"""
chromatox/backend/routers/quantitative_simulator.py

Enrutador FastAPI para el módulo de calibración cuantitativa (Unidad 6).
Permite generar inyecciones sintéticas de estándares USP aleatorios
y validar los cálculos de regresión e incertidumbre de los estudiantes.
"""

from __future__ import annotations
import os
import json
import redis
from uuid import UUID
from typing import Optional, Any
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.future import select
from sqlalchemy.ext.asyncio import AsyncSession

from db_models import get_db, StudentGrade, ActivityLedger
from quantitative_engine import (
    generate_calibration_data, calculate_regression, USP_COMPOUNDS
)
from telemetry import evaluate_justification_semantically

router = APIRouter(prefix="/api/quantitative", tags=["Quantitative Analysis"])

# Conexión Redis
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
redis_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)

# Caché local en memoria para fallbacks
local_quant_cases: dict[str, dict] = {}

# ─── SCHEMAS ─────────────────────────────────────────────────

class GenerateCaseRequest(BaseModel):
    session_id: str
    student_code: str

class ValidateCaseRequest(BaseModel):
    session_id: str
    student_code: str
    full_name: str
    compound_name: str
    slope: float = Field(..., description="Pendiente calculada por el alumno (m)")
    intercept: float = Field(..., description="Intercepto calculado por el alumno (b)")
    r_squared: float = Field(..., description="Coeficiente de correlación R²")
    x_interpolated: float = Field(..., description="Concentración interpolada de la muestra")
    uncertainty: float = Field(..., description="Incertidumbre absoluta de interpolación")
    justification: str = Field(..., min_length=30, description="Justificación técnica / análisis de calidad USP 49")
    time_spent_seconds: int = Field(0, ge=0)

# ─── ENDPOINTS ───────────────────────────────────────────────

@router.post("/generate-case")
async def generate_case(req: GenerateCaseRequest):
    """
    Selecciona un fármaco USP de forma aleatoria y simula la inyección
    de estándares y de la muestra problema del lote.
    Los datos se guardan en caché de Redis para validar contra las respuestas del estudiante.
    """
    import random
    
    # Elegir fármaco USP al azar
    compounds = list(USP_COMPOUNDS.keys())
    chosen_compound = random.choice(compounds)
    
    # Generar caso (reproducible por sesión)
    seed = abs(hash(str(req.session_id))) % (10**8)
    case_data = generate_calibration_data(chosen_compound, seed=seed)
    
    # Guardar en Redis o fallback local
    redis_key = f"chromatox:quant_case:{req.session_id}"
    try:
        redis_client.set(redis_key, json.dumps(case_data), ex=3600)  # Expira en 1 hora
    except Exception as e:
        print(f"[QUANT SIM] Fallo al escribir en Redis: {e}. Guardando en memoria local.")
    local_quant_cases[req.session_id] = case_data
    
    # Retornar al alumno (ocultando target_unk_conc)
    return {
        "ok": True,
        "compound_name": case_data["compound_name"],
        "concentrations": case_data["concentrations"],
        "areas": case_data["areas"],
        "unk_areas": case_data["unk_areas"],
        "message": (
            f"Se ha inyectado con éxito el set de 5 estándares de calibración y 3 réplicas "
            f"del lote problema de {chosen_compound} USP. Procesa la curva de regresión."
        )
    }

@router.post("/validate")
async def validate_case(req: ValidateCaseRequest, db: AsyncSession = Depends(get_db)):
    """
    Valida los cálculos matemáticos del alumno.
    Calificación: 50% Precisión de cálculos + 50% Evaluación semántica de la justificación.
    """
    redis_key = f"chromatox:quant_case:{req.session_id}"
    case_json = None
    try:
        case_json = redis_client.get(redis_key)
    except Exception as e:
        print(f"[QUANT SIM] Fallo al leer de Redis: {e}. Recuperando de memoria local.")
    
    if not case_json:
        if req.session_id in local_quant_cases:
            case_data = local_quant_cases[req.session_id]
        else:
            # Si no se encuentra en Redis, re-generar usando el seed de la sesión para consistencia
            import random
            seed = abs(hash(str(req.session_id))) % (10**8)
            random.seed(seed)
            compounds = list(USP_COMPOUNDS.keys())
            chosen_compound = random.choice(compounds)
            case_data = generate_calibration_data(chosen_compound, seed=seed)
            try:
                redis_client.set(redis_key, json.dumps(case_data), ex=3600)
            except Exception as e:
                print(f"[QUANT SIM] Fallo al escribir en Redis: {e}")
            local_quant_cases[req.session_id] = case_data
    else:
        case_data = json.loads(case_json)
        
    # Calcular solución verdadera
    true_res = calculate_regression(
        case_data["concentrations"],
        case_data["areas"],
        case_data["unk_areas"]
    )
    
    # Calificar precisión matemática
    errors = []
    score_sim = 5.0
    
    # Tolerancias
    # slope, intercept: 1.5%
    # x_interpolated, uncertainty: 2.0%
    # r_squared: ±0.005 abs
    
    def check_rel_error(val: float, true_val: float, tolerance: float) -> bool:
        if abs(true_val) < 1e-9:
            return abs(val) < tolerance
        return abs(val - true_val) / abs(true_val) <= tolerance

    if not check_rel_error(req.slope, true_res["slope"], 0.015):
        errors.append(f"Pendiente incorrecta. Esperado: {true_res['slope']}, Recibido: {req.slope}")
        score_sim -= 1.0
        
    if not check_rel_error(req.intercept, true_res["intercept"], 0.015):
        errors.append(f"Intercepto incorrecto. Esperado: {true_res['intercept']}, Recibido: {req.intercept}")
        score_sim -= 1.0
        
    if abs(req.r_squared - true_res["r_squared"]) > 0.005:
        errors.append(f"Coeficiente R² incorrecto. Esperado: {true_res['r_squared']}, Recibido: {req.r_squared}")
        score_sim -= 1.0
        
    if not check_rel_error(req.x_interpolated, true_res["x_interpolated"], 0.02):
        errors.append(f"Concentración interpolada incorrecta. Esperado: {true_res['x_interpolated']} mg/L, Recibido: {req.x_interpolated} mg/L")
        score_sim -= 1.0
        
    if not check_rel_error(req.uncertainty, true_res["uncertainty"], 0.03):
        errors.append(f"Incertidumbre de interpolación incorrecta. Esperado: {true_res['uncertainty']}, Recibido: {req.uncertainty}")
        score_sim -= 1.0
        
    score_sim = max(1.0, score_sim)
    
    # Evaluación semántica de la justificación escrita
    sem_score, sem_feedback = await evaluate_justification_semantically(6, req.justification)
    
    # Nota consolidada final (50% simulación + 50% justificación)
    final_score = round((score_sim + sem_score) / 2.0, 2)
    
    # Registrar en bitácora ActivityLedger
    ledger_entry = ActivityLedger(
        session_id=str(req.session_id),
        student_code=req.student_code,
        activity_number=6,
        score=final_score,
        justification=req.justification,
        semantic_feedback=sem_feedback,
        attempts=1,
        time_spent_seconds=req.time_spent_seconds,
        telemetry_data={
            "compound_name": req.compound_name,
            "student_inputs": {
                "slope": req.slope,
                "intercept": req.intercept,
                "r_squared": req.r_squared,
                "x_interpolated": req.x_interpolated,
                "uncertainty": req.uncertainty
            },
            "true_values": true_res,
            "math_errors": errors,
            "score_math": score_sim,
            "score_semantic": sem_score
        }
    )
    db.add(ledger_entry)
    
    # Actualizar nota en StudentGrades
    result = await db.execute(select(StudentGrade).filter_by(student_code=req.student_code))
    student = result.scalars().first()
    if not student:
        student = StudentGrade(
            student_code=req.student_code,
            full_name=req.full_name
        )
        db.add(student)
        
    # Mejor intento
    if student.act6_grade is None or final_score > student.act6_grade:
        student.act6_grade = final_score

    # Actualizar progreso
    if final_score >= 3.0:
        from db_models import User
        res_user = await db.execute(select(User).filter_by(username=req.student_code))
        user = res_user.scalars().first()
        if user:
            if user.active_unit < 6:
                user.active_unit = 6
        
    await db.flush()
    
    # Enviar telemetría en vivo del progreso al panel del docente
    try:
        live_update = {
            "type": "STUDENT_UPDATE",
            "session_id": str(req.session_id),
            "student_code": req.student_code,
            "full_name": req.full_name,
            "route": "quantitative",
            "active_unit": 6,
            "time_left": 0,
            "attempts": 1,
            "score": final_score,
            "status": "COMPLETED" if final_score >= 3.0 else "ACTIVE",
            "metrics": {
                "compound": req.compound_name,
                "math_score": score_sim,
                "semantic_score": sem_score,
                "r_squared": req.r_squared
            }
        }
        redis_client.publish("chromatox:instructor_updates", json.dumps(live_update))
    except Exception as e:
        print(f"[QUANT SIM] Fallo al publicar telemetría en vivo: {e}")
        
    return {
        "ok": len(errors) == 0,
        "math_errors": errors,
        "score_math": score_sim,
        "score_semantic": sem_score,
        "score_final": final_score,
        "feedback": sem_feedback if len(errors) == 0 else f"Errores en cálculos matemáticos: {', '.join(errors)}",
        "student_grades": student.to_dict()
    }
