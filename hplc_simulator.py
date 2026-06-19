"""
chromatox/backend/hplc_simulator.py

Endpoints de API y WebSocket para el simulador físico de HPLC/UHPLC y SPE.
Implementa el cálculo dinámico de cromatogramas líquidos bi-gaussianos (con asimetría USP)
y controla el estallido hidráulico por WebSocket si la presión supera 130 MPa.
"""

from __future__ import annotations
import os
import json
import asyncio
import redis.asyncio as aioredis
from uuid import UUID
from typing import Optional, Literal
import time
import math

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, validator

from hplc_engine import (
    run_hplc_simulation, vandeemter_hplc_curve,
    HPLCParams, HPLC_COLUMN_CATALOG, HPLCInstrumentLimits,
)
from spe_engine import run_spe_simulation, SPEParams

router = APIRouter(prefix="/api/hplc", tags=["HPLC/UHPLC Simulator"])

# ─── SCHEMAS HPLC ────────────────────────────────────────────

class HPLCSimRequest(BaseModel):
    session_id: UUID
    column_key: str
    mobile_phase_solvent: Literal["ACN", "MeOH"]
    organic_modifier_pct: float = Field(..., ge=0.0, le=100.0)
    flow_rate_ml_min: float = Field(..., ge=0.05, le=5.0)
    oven_temp_c: float = Field(..., ge=15.0, le=80.0)
    analyte_mixture: Optional[str] = "Paracetamol + Ibuprofeno"

    @validator("column_key")
    def column_must_exist(cls, v: str) -> str:
        if v not in HPLC_COLUMN_CATALOG:
            raise ValueError(f"Columna '{v}' no existe en el catálogo.")
        return v

class HPLCVanDeemterRequest(BaseModel):
    column_key: str
    mobile_phase_solvent: Literal["ACN", "MeOH"]
    organic_modifier_pct: float = Field(50.0, ge=0.0, le=100.0)
    oven_temp_c: float = Field(25.0, ge=15.0, le=80.0)
    u_min: float = 0.1
    u_max: float = 8.0

# ─── SCHEMAS SPE ─────────────────────────────────────────────

class SPESimRequest(BaseModel):
    session_id: UUID
    sorbent_type: Literal["C18", "Silica"]
    conditioning_solvent: str
    conditioning_volume_ml: float = Field(..., ge=0.0)
    equilibrating_volume_ml: float = Field(..., ge=0.0)
    loading_volume_ml: float = Field(..., ge=0.1)
    loading_sample_matrix: Literal["Water", "Organic"]
    washing_solvent: str
    washing_organic_pct: float = Field(..., ge=0.0, le=100.0)
    washing_volume_ml: float = Field(..., ge=0.0)
    elution_solvent: Literal["MeOH", "ACN", "EtOAc"]
    elution_organic_pct: float = Field(..., ge=0.0, le=100.0)
    elution_volume_ml: float = Field(..., ge=0.1)
    analyte_mixture: Optional[str] = "Paracetamol + Ibuprofeno"

# ─── ENDPOINTS HPLC ──────────────────────────────────────────

@router.get("/catalog")
async def hplc_catalog():
    """Lista columnas y modificadores orgánicos disponibles para HPLC/UHPLC."""
    return {
        "columns": [
            {
                "key": k,
                "name": v.name,
                "length_mm": v.length_mm,
                "id_mm": v.inner_diameter_mm,
                "particle_size_um": v.particle_size_um,
                "max_pressure_mpa": v.max_pressure_mpa,
                "chemistry": v.chemistry,
            }
            for k, v in HPLC_COLUMN_CATALOG.items()
        ],
        "solvents": ["ACN", "MeOH"]
    }

def _generate_hplc_chromatogram_points(result) -> list[dict]:
    """
    Genera 160 puntos para graficar el cromatograma líquido.
    Usa el modelo de bi-Gaussianas para emular asimetría USP (Tailing) de forma exacta:
    T_right = 2 * T_usp - 1
    """
    pa = result.peak_a
    pb = result.peak_b
    
    t_end = pb.retention_time_min * 1.5
    n_points = 160
    points = []

    # Desviación estándar sigma = W_base / 4
    sigma_a_left = pa.peak_width_min / 4.0
    # Modificar sigma derecha según tailing factor
    # Si T_usp = 1.0 (perfecto), T_right_mult = 1.0. Si T_usp > 1.0, se ensancha el hemisferio derecho.
    t_mult_a = 2.0 * pa.tailing_factor_usp - 1.0
    sigma_a_right = sigma_a_left * t_mult_a

    sigma_b_left = pb.peak_width_min / 4.0
    t_mult_b = 2.0 * pb.tailing_factor_usp - 1.0
    sigma_b_right = sigma_b_left * t_mult_b

    for i in range(n_points):
        t = (t_end * i) / (n_points - 1)
        
        # Pico A
        if t <= pa.retention_time_min:
            ya = pa.height_signal * math.exp(-0.5 * ((t - pa.retention_time_min) / sigma_a_left) ** 2)
        else:
            ya = pa.height_signal * math.exp(-0.5 * ((t - pa.retention_time_min) / sigma_a_right) ** 2)

        # Pico B
        if t <= pb.retention_time_min:
            yb = pb.height_signal * math.exp(-0.5 * ((t - pb.retention_time_min) / sigma_b_left) ** 2)
        else:
            yb = pb.height_signal * math.exp(-0.5 * ((t - pb.retention_time_min) / sigma_b_right) ** 2)

        points.append({
            "t": round(t, 4),
            "signal": round(ya + yb, 5),
            "peak_a": round(ya, 5),
            "peak_b": round(yb, 5),
        })
    return points

@router.post("/run")
async def run_hplc(req: HPLCSimRequest):
    """Ejecuta simulación de columna líquida y retorna métricas + cromatograma."""
    t0 = time.perf_counter()
    params = HPLCParams(
        column_key=req.column_key,
        mobile_phase_solvent=req.mobile_phase_solvent,
        organic_modifier_pct=req.organic_modifier_pct,
        flow_rate_ml_min=req.flow_rate_ml_min,
        oven_temp_c=req.oven_temp_c,
        analyte_mixture=req.analyte_mixture
    )
    result = run_hplc_simulation(params)
    compute_ms = int((time.perf_counter() - t0) * 1000)

    # Disparar RAG si hay errores de idoneidad (Rs < 1.5 o Tailing > 2.0)
    if result.rs < 1.50 or result.peak_a.tailing_factor_usp > 2.0 or result.peak_b.tailing_factor_usp > 2.0:
        try:
            from tasks import trigger_rag_feedback
            error_lbl = "Baja Resolucion" if result.rs < 1.50 else "Alto Tailing"
            det = f"Rs={result.rs:.2f}, Tailing_A={result.peak_a.tailing_factor_usp:.2f}, Tailing_B={result.peak_b.tailing_factor_usp:.2f}"
            trigger_rag_feedback(str(req.session_id), "ESTUDIANTE", error_lbl, det)
        except Exception as e:
            print(f"[HPLC API] Error encolando RAG: {e}")

    # Si hay error crítico (ej. sobrepresión), FastAPI retorna de igual manera las métricas con errors
    return {
        "ok": len(result.errors) == 0,
        "compute_ms": compute_ms,
        "result": result.to_dict(),
        "chromatogram_points": _generate_hplc_chromatogram_points(result)
    }

@router.post("/vandeemter-curve")
async def get_vandeemter_curve(req: HPLCVanDeemterRequest):
    """Retorna los puntos de la curva de van Deemter (HETP vs u) para HPLC."""
    points = vandeemter_hplc_curve(
        column_key=req.column_key,
        solvent=req.mobile_phase_solvent,
        organic_pct=req.organic_modifier_pct,
        temp_c=req.oven_temp_c,
        u_min=req.u_min,
        u_max=req.u_max
    )
    return {
        "ok": True,
        "points": points
    }

# ─── ENDPOINTS SPE ───────────────────────────────────────────

@router.post("/spe/run")
async def run_spe(req: SPESimRequest):
    """Simula la extracción por fase sólida (SPE) y retorna el porcentaje de recuperación."""
    params = SPEParams(
        sorbent_type=req.sorbent_type,
        conditioning_solvent=req.conditioning_solvent,
        conditioning_volume_ml=req.conditioning_volume_ml,
        equilibrating_volume_ml=req.equilibrating_volume_ml,
        loading_volume_ml=req.loading_volume_ml,
        loading_sample_matrix=req.loading_sample_matrix,
        washing_solvent=req.washing_solvent,
        washing_organic_pct=req.washing_organic_pct,
        washing_volume_ml=req.washing_volume_ml,
        elution_solvent=req.elution_solvent,
        elution_organic_pct=req.elution_organic_pct,
        elution_volume_ml=req.elution_volume_ml,
        analyte_mixture=req.analyte_mixture
    )
    result = run_spe_simulation(params)
    return {
        "ok": len(result.errors) == 0,
        "result": result.to_dict()
    }

# ─── WEBSOCKET REAL-TIME TELEMETRY ───────────────────────────

@router.websocket("/ws/{session_id}")
async def hplc_websocket(websocket: WebSocket, session_id: str):
    """
    WebSocket HPLC/UHPLC y SPE.
    Sincroniza telemetría en tiempo real y recibe comandos de bloqueo/feedback del docente.
    """
    await websocket.accept()
    
    student_code = websocket.query_params.get("student_code", "Desconocido")
    full_name = websocket.query_params.get("full_name", "Estudiante")
    
    from ws_manager import ws_manager
    await ws_manager.connect_student(session_id, websocket)
    
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "HPLC_RUN":
                p = data["params"]
                column_key = p.get("column_key", "C18_150mm_3.5um")
                
                params = HPLCParams(
                    column_key=column_key,
                    mobile_phase_solvent=p.get("mobile_phase_solvent", "ACN"),
                    organic_modifier_pct=float(p.get("organic_modifier_pct", 50.0)),
                    flow_rate_ml_min=float(p.get("flow_rate_ml_min", 1.0)),
                    oven_temp_c=float(p.get("oven_temp_c", 25.0)),
                    analyte_mixture=p.get("analyte_mixture", "Paracetamol + Ibuprofeno")
                )
                
                result = run_hplc_simulation(params)
                
                # Comprobar límite de presión crítico
                if result.backpressure_mpa > HPLCInstrumentLimits.MAX_PRESSURE_UHPLC_MPA:
                    await websocket.send_json({
                        "type": "PRESSURE_BLOWOUT",
                        "message": (
                            f"¡ALERTA CATÁSTROFE HIDRÁULICA! Contrapresión del sistema superó {result.backpressure_mpa:.1f} MPa. "
                            f"Se ha excedido el límite crítico del ChroZen UHPLC (130 MPa / 1300 bar). "
                            f"Pistones y sellos del inyector destruidos. Deteniendo flujo automáticamente."
                        ),
                        "backpressure_mpa": result.backpressure_mpa
                    })
                    
                    # Reportar el blowout en vivo
                    sdata = {
                        "session_id": session_id,
                        "student_code": student_code,
                        "full_name": full_name,
                        "route": "uhplc" if "1.7um" in column_key else "hplc",
                        "status": "BLOWOUT",
                        "time_left": 3600,
                        "active_unit": 4 if "1.7um" in column_key else 3,
                        "timestamp": time.time(),
                        "metrics": {"pressure_mpa": result.backpressure_mpa, "rs": result.rs, "plates": result.n_plates}
                    }
                    await ws_manager.register_session(session_id, sdata)
                    continue
                
                # Disparar RAG si hay errores de idoneidad en WS
                if result.rs < 1.50 or result.peak_a.tailing_factor_usp > 2.0 or result.peak_b.tailing_factor_usp > 2.0:
                    try:
                        from tasks import trigger_rag_feedback
                        error_lbl = "Baja Resolucion" if result.rs < 1.50 else "Alto Tailing"
                        det = f"Rs={result.rs:.2f}, Tailing_A={result.peak_a.tailing_factor_usp:.2f}, Tailing_B={result.peak_b.tailing_factor_usp:.2f}"
                        trigger_rag_feedback(str(session_id), "ESTUDIANTE", error_lbl, det)
                    except Exception as e:
                        print(f"[HPLC WS] Error encolando RAG: {e}")

                await websocket.send_json({
                    "type": "HPLC_RESULT",
                    "result": result.to_dict(),
                    "chromatogram": _generate_hplc_chromatogram_points(result)
                })
                
                # Publicar actualización al docente
                route_lbl = "uhplc" if "1.7um" in column_key else "hplc"
                sdata = {
                    "session_id": session_id,
                    "student_code": student_code,
                    "full_name": full_name,
                    "route": route_lbl,
                    "status": "ACTIVE",
                    "time_left": 3600,
                    "active_unit": 4 if route_lbl == "uhplc" else 3,
                    "timestamp": time.time(),
                    "metrics": {
                        "pressure_mpa": result.backpressure_mpa,
                        "rs": result.rs,
                        "plates": result.n_plates,
                        "flow": params.flow_rate_ml_min,
                        "org_pct": params.organic_modifier_pct,
                        "temp": params.oven_temp_c
                    }
                }
                await ws_manager.register_session(session_id, sdata)

            elif msg_type == "SPE_RUN":
                p = data["params"]
                params_spe = SPEParams(
                    sorbent_type=p.get("sorbent_type", "C18"),
                    conditioning_solvent=p.get("conditioning_solvent", "MeOH"),
                    conditioning_volume_ml=float(p.get("conditioning_volume_ml", 2.0)),
                    equilibrating_volume_ml=float(p.get("equilibrating_volume_ml", 2.0)),
                    loading_volume_ml=float(p.get("loading_volume_ml", 1.0)),
                    loading_sample_matrix=p.get("loading_sample_matrix", "Water"),
                    washing_solvent=p.get("washing_solvent", "H2O"),
                    washing_organic_pct=float(p.get("washing_organic_pct", 0.0)),
                    washing_volume_ml=float(p.get("washing_volume_ml", 1.0)),
                    elution_solvent=p.get("elution_solvent", "MeOH"),
                    elution_organic_pct=float(p.get("elution_organic_pct", 80.0)),
                    elution_volume_ml=float(p.get("elution_volume_ml", 2.0)),
                    analyte_mixture=p.get("analyte_mixture", "Paracetamol + Ibuprofeno")
                )
                result_spe = run_spe_simulation(params_spe)
                await websocket.send_json({
                    "type": "SPE_RESULT",
                    "result": result_spe.to_dict()
                })
                
                # Publicar actualización al docente
                sdata = {
                    "session_id": session_id,
                    "student_code": student_code,
                    "full_name": full_name,
                    "route": "spe",
                    "status": "ACTIVE",
                    "time_left": 3600,
                    "active_unit": 2,
                    "timestamp": time.time(),
                    "metrics": {
                        "rec_a": result_spe.analyte_a.percent_recovered,
                        "rec_b": result_spe.analyte_b.percent_recovered,
                        "pur_a": result_spe.purity_a_pct,
                        "pur_b": result_spe.purity_b_pct
                    }
                }
                await ws_manager.register_session(session_id, sdata)

            elif msg_type == "VAN_DEEMTER":
                p = data["params"]
                pts = vandeemter_hplc_curve(
                    column_key=p.get("column_key", "C18_150mm_3.5um"),
                    solvent=p.get("mobile_phase_solvent", "ACN"),
                    organic_pct=float(p.get("organic_modifier_pct", 50.0)),
                    temp_c=float(p.get("oven_temp_c", 25.0))
                )
                await websocket.send_json({
                    "type": "VAN_DEEMTER_DATA",
                    "points": pts
                })

            elif msg_type == "PING":
                await websocket.send_json({"type": "PONG"})

    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect_student(session_id, websocket)
