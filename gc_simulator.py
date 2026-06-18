"""
chromatox/backend/routers/gc_simulator.py

Endpoints FastAPI para el motor de Cromatografía de Gases.
Complementa simulator.py (HPLC/UHPLC).
"""

from __future__ import annotations
import os
import json
import asyncio
import redis.asyncio as aioredis
from uuid import UUID
from typing import Optional
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, validator

from gc_engine import (
    run_gc_simulation, golay_curve,
    GCParams, GCColumnSpec, InjectionParams, InjectionMode,
    GC_COLUMN_CATALOG, CARRIER_GASES, GC_DETECTORS,
    GCInstrumentLimits,
)

router = APIRouter(prefix="/api/gc", tags=["GC Simulator"])


# ─── SCHEMAS ─────────────────────────────────────────────────

class InjectionSchema(BaseModel):
    mode: str = Field("SPLIT", pattern="^(SPLIT|SPLITLESS|ON_COLUMN|PTV|SPME)$")
    injector_temp_c: float = Field(250.0, ge=50.0, le=450.0)
    split_ratio: float = Field(50.0, ge=1.0, le=1000.0)
    purge_time_min: float = Field(1.0, ge=0.1, le=5.0)
    injection_vol_ul: float = Field(1.0, ge=0.1, le=5.0)


class GCSimRequest(BaseModel):
    session_id: UUID
    gate_id: Optional[UUID] = None
    column_key: str
    carrier_gas: str = Field("He", pattern="^(He|H2|N2)$")
    inlet_pressure_kpa: float = Field(
        100.0,
        ge=GCInstrumentLimits.PRESSURE_INLET_MIN_KPA,
        le=GCInstrumentLimits.PRESSURE_INLET_MAX_KPA,
    )
    oven_temp_c: float = Field(150.0, ge=-60.0, le=450.0)
    injector_temp_c: float = Field(250.0, ge=50.0, le=450.0)
    detector_type: str = Field("FID", pattern="^(FID|TCD|ECD|MS|NPD)$")
    detector_temp_c: float = Field(300.0, ge=50.0, le=450.0)
    injection: InjectionSchema = InjectionSchema()
    k_prime_a: float = Field(..., gt=0)
    k_prime_b: float = Field(..., gt=0)

    @validator("column_key")
    def col_must_exist(cls, v: str) -> str:
        if v not in GC_COLUMN_CATALOG:
            raise ValueError(f"Columna GC '{v}' no existe en el catálogo")
        return v

    @validator("oven_temp_c")
    def temp_vs_column(cls, v: float, values: dict) -> float:
        col_key = values.get("column_key")
        if col_key and col_key in GC_COLUMN_CATALOG:
            col_max = GC_COLUMN_CATALOG[col_key].max_temp_c
            if v > col_max:
                raise ValueError(
                    f"T horno {v}°C supera el máximo de la columna {col_max}°C"
                )
        return v


class GolayRequest(BaseModel):
    column_key: str
    carrier_gas: str = "He"
    temp_c: float = 150.0
    inlet_pressure_kpa: float = 100.0
    k_prime: float = 5.0
    u_min_cm_s: float = 5.0
    u_max_cm_s: float = 80.0


# ─── ENDPOINTS ───────────────────────────────────────────────

@router.post("/run")
async def run_gc(req: GCSimRequest):
    """Ejecuta el motor GC completo y retorna métricas + cromatograma."""
    t0 = time.perf_counter()
    col = GC_COLUMN_CATALOG[req.column_key]
    inj = InjectionParams(
        mode=InjectionMode(req.injection.mode),
        injector_temp_c=req.injection.injector_temp_c,
        split_ratio=req.injection.split_ratio,
        purge_time_min=req.injection.purge_time_min,
        injection_vol_ul=req.injection.injection_vol_ul,
    )
    params = GCParams(
        column=col,
        carrier_gas=req.carrier_gas,
        inlet_pressure_kpa=req.inlet_pressure_kpa,
        oven_temp_c=req.oven_temp_c,
        injector_temp_c=req.injector_temp_c,
        detector_type=req.detector_type,
        detector_temp_c=req.detector_temp_c,
        injection=inj,
        k_prime_a=req.k_prime_a,
        k_prime_b=req.k_prime_b,
    )
    result = run_gc_simulation(params)
    compute_ms = int((time.perf_counter() - t0) * 1000)

    return {
        "ok": True,
        "compute_ms": compute_ms,
        "result": result.to_dict(),
        "chromatogram_points": _gc_chromatogram(result),
    }


@router.post("/golay-curve")
async def get_golay_curve(req: GolayRequest):
    """Curva de Golay HETP vs velocidad lineal con contribuciones B, Cm, Cs."""
    col = GC_COLUMN_CATALOG[req.column_key]
    points = golay_curve(
        col, req.carrier_gas, req.temp_c,
        req.inlet_pressure_kpa, req.k_prime,
        (req.u_min_cm_s, req.u_max_cm_s),
    )
    gas = CARRIER_GASES[req.carrier_gas]
    return {
        "ok": True,
        "points": points,
        "gas": gas.name,
        "optimal_range_cm_s": list(gas.optimal_velocity_range),
    }


@router.get("/catalog")
async def gc_catalog():
    """Lista columnas, gases portadores y detectores disponibles."""
    return {
        "columns": [
            {
                "key": k,
                "name": v.name,
                "length_m": v.length_m,
                "id_mm": v.inner_diameter_mm,
                "film_um": v.film_thickness_um,
                "phase": v.phase_type,
                "polarity": v.polarity,
                "max_temp_c": v.max_temp_c,
                "phase_ratio_beta": round(v.phase_ratio, 1),
            }
            for k, v in GC_COLUMN_CATALOG.items()
        ],
        "carrier_gases": [
            {
                "key": k,
                "name": v.name,
                "symbol": v.symbol,
                "optimal_velocity_range": list(v.optimal_velocity_range),
                "min_hetp_factor": v.min_hetp_factor,
                "safety_note": v.safety_note,
            }
            for k, v in CARRIER_GASES.items()
        ],
        "detectors": [
            {
                "key": k,
                "name": v.name,
                "abbreviation": v.abbreviation,
                "principle": v.principle,
                "mdq_g_s": v.min_detectable_g_s,
                "linear_range_decades": v.linear_range_decades,
                "selective_for": v.selective_for,
                "compatible_gases": v.carrier_gas_compatible,
            }
            for k, v in GC_DETECTORS.items()
        ],
    }

@router.websocket("/ws/{session_id}")
async def gc_websocket(websocket: WebSocket, session_id: UUID):
    """
    WebSocket GC.
    Sincroniza telemetría en tiempo real y recibe comandos de bloqueo/feedback del docente.
    """
    await websocket.accept()
    
    student_code = websocket.query_params.get("student_code", "Desconocido")
    full_name = websocket.query_params.get("full_name", "Estudiante")
    
    from ws_manager import ws_manager
    await ws_manager.connect_student(str(session_id), websocket)
    
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "GC_RUN":
                p = data["params"]
                col = GC_COLUMN_CATALOG.get(p.get("column_key", ""))
                if not col:
                    await websocket.send_json({"type": "ERROR", "message": "Columna inválida"})
                    continue
                inj = InjectionParams(
                    mode=InjectionMode(p.get("injection_mode", "SPLIT")),
                    injector_temp_c=p.get("injector_temp_c", 250.0),
                    split_ratio=p.get("split_ratio", 50.0),
                    purge_time_min=p.get("purge_time_min", 1.0),
                    injection_vol_ul=p.get("injection_vol_ul", 1.0),
                )
                params = GCParams(
                    column=col,
                    carrier_gas=p.get("carrier_gas", "He"),
                    inlet_pressure_kpa=p.get("inlet_pressure_kpa", 100.0),
                    oven_temp_c=p.get("oven_temp_c", 150.0),
                    injector_temp_c=p.get("injector_temp_c", 250.0),
                    detector_type=p.get("detector_type", "FID"),
                    detector_temp_c=p.get("detector_temp_c", 300.0),
                    injection=inj,
                    k_prime_a=p.get("k_prime_a", 5.0),
                    k_prime_b=p.get("k_prime_b", 7.0),
                )
                result = run_gc_simulation(params)
                await websocket.send_json({
                    "type": "GC_RESULT",
                    "result": result.to_dict(),
                    "chromatogram": _gc_chromatogram(result),
                })
                
                # Publicar actualización al docente
                sdata = {
                    "session_id": str(session_id),
                    "student_code": student_code,
                    "full_name": full_name,
                    "route": "gc",
                    "status": "ACTIVE",
                    "time_left": 3600,
                    "active_unit": 5,
                    "timestamp": time.time(),
                    "metrics": {
                        "rs": result.rs,
                        "plates": result.n_plates,
                        "carrier": params.carrier_gas,
                        "pressure_kpa": params.inlet_pressure_kpa,
                        "temp": params.oven_temp_c,
                        "detector": params.detector_type
                    }
                }
                await ws_manager.register_session(str(session_id), sdata)

            elif msg_type == "GOLAY_CURVE":
                p = data["params"]
                col = GC_COLUMN_CATALOG.get(p.get("column_key", ""))
                if col:
                    pts = golay_curve(
                        col,
                        p.get("carrier_gas", "He"),
                        p.get("temp_c", 150.0),
                        p.get("inlet_pressure_kpa", 100.0),
                        p.get("k_prime", 5.0),
                    )
                    await websocket.send_json({"type": "GOLAY_DATA", "points": pts})

            elif msg_type == "PING":
                await websocket.send_json({"type": "PONG"})

    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect_student(str(session_id), websocket)
def _gc_chromatogram(result) -> list[dict]:
    """Genera 150 puntos gaussianos para el cromatograma GC."""
    import math
    pa, pb = result.peak_a, result.peak_b
    t_end = pb.retention_time_min * 1.5
    n = 150
    points = []
    for i in range(n):
        t = t_end * i / (n - 1)
        sa = pa.peak_width_min / 4
        sb = pb.peak_width_min / 4
        ya = pa.height_signal * math.exp(-0.5 * ((t - pa.retention_time_min) / sa) ** 2)
        yb = pb.height_signal * math.exp(-0.5 * ((t - pb.retention_time_min) / sb) ** 2)
        points.append({
            "t": round(t, 4),
            "signal": round(ya + yb, 5),
            "peak_a": round(ya, 5),
            "peak_b": round(yb, 5),
        })
    return points
