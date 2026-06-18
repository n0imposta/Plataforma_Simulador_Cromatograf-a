"""
chromatox/backend/telemetry.py

Rutas de API de FastAPI para control de calificaciones, telemetría y evaluación semántica
de las 6 actividades bimensuales del microcurrículo UdeA/USS 2026.
"""

from __future__ import annotations
import os
import httpx
import redis
import redis.asyncio as aioredis
import json
import asyncio
from typing import Optional, Any
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy.future import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import func

from db_models import get_db, StudentGrade, ActivityLedger, AsyncSessionLocal

router = APIRouter(prefix="/api/telemetry", tags=["Telemetry & Grades"])

# ─── SCHEMAS ─────────────────────────────────────────────────

class ActivitySubmitSchema(BaseModel):
    session_id: str
    student_code: str
    full_name: str
    activity_number: int = Field(..., ge=1, le=6)
    score_sim: float = Field(..., ge=0.0, le=5.0, description="Nota de la fase práctica/simulador")
    justification: str = Field(..., min_length=30, description="Justificación técnica escrita por el estudiante")
    time_spent_seconds: int = Field(0, ge=0)
    telemetry_data: dict[str, Any] = Field(default_factory=dict)

class FinalExamSubmitSchema(BaseModel):
    student_code: str
    score: float = Field(..., ge=0.0, le=5.0)
    comments: Optional[str] = ""
    rubric_matrix_effect: Optional[float] = Field(None, ge=1.0, le=5.0)
    rubric_data_integrity: Optional[float] = Field(None, ge=1.0, le=5.0)
    rubric_defense: Optional[float] = Field(None, ge=1.0, le=5.0)

# ─── EVALUADOR SEMÁNTICO (KEYWORDS & LLM FALLBACK) ───────────

KEYWORDS_PER_ACTIVITY = {
    1: ["cromatografía", "fase móvil", "fase estacionaria", "reparto", "adsorción"],
    2: ["acondicionamiento", "elución", "lavado", "adsorción", "fase reversa", "polaridad", "recuperación", "sorbente"],
    3: ["darcy", "resolución", "presión", "viscosidad", "fase móvil", "caudal", "columna", "c18"],
    4: ["uhplc", "knox", "partícula", "hetp", "presión", "contrapresión", "130 mpa", "chrozen", "velocidad lineal"],
    5: ["golay", "gas portador", "difusión", "temperatura", "inyector", "split", "detector", "platos"],
    6: ["cuantificación", "calibración", "rsd", "área", "curva", "precisión", "exactitud"]
}

async def evaluate_justification_semantically(activity_num: int, text: str) -> tuple[float, str]:
    """
    Evalúa semánticamente el texto del estudiante.
    1. Calcula un puntaje de coincidencia de palabras clave.
    2. Si ANTHROPIC_API_KEY está configurada, realiza una llamada a Claude para evaluación cualitativa.
    Retorna un tuple: (nota_semantica_0_a_5, feedback_tutor).
    """
    # 1. Análisis por palabras clave (Algoritmo determinista base)
    req_keywords = KEYWORDS_PER_ACTIVITY.get(activity_num, ["cromatografía"])
    found = [kw for kw in req_keywords if kw in text.lower()]
    match_ratio = len(found) / len(req_keywords)
    
    # Nota base entre 1.0 y 5.0
    keyword_score = 1.0 + (match_ratio * 4.0)
    
    # Feedback inicial
    missing = [kw for kw in req_keywords if kw not in found]
    if missing:
        keyword_feedback = (
            f"Tu justificación técnica es aceptable pero omitiste conceptos clave del microcurrículo: "
            f"{', '.join(missing)}. Intenta justificar usando el fundamento físico-químico."
        )
    else:
        keyword_feedback = "Excelente uso del lenguaje técnico y los conceptos fundamentales del microcurrículo."

    # 2. Evaluación con LLM (Claude 3.5 Sonnet) si está disponible
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if api_key and api_key.strip() and api_key != "${ANTHROPIC_API_KEY}":
        try:
            prompt = (
                f"Actúa como un profesor de Química Farmacéutica evaluando el microcurrículo 2026. "
                f"Evalúa la siguiente justificación técnica de un estudiante para la Actividad {activity_num} "
                f"de Cromatografía (Conceptos requeridos: {', '.join(req_keywords)}).\n\n"
                f"Justificación del estudiante:\n\"{text}\"\n\n"
                f"Responde ESTRICTAMENTE en formato JSON con la siguiente estructura:\n"
                f'{{"score": float_entre_1.0_y_5.0, "feedback": "string_breve_en_espanol"}}\n'
                f"No agregues texto introductorio ni conclusiones adicionales."
            )
            
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json"
                    },
                    json={
                        "model": "claude-3-5-sonnet-20241022",
                        "max_tokens": 200,
                        "messages": [{"role": "user", "content": prompt}]
                    },
                    timeout=10.0
                )
                if response.status_code == 200:
                    res_json = response.json()
                    content_text = res_json["content"][0]["text"]
                    import json
                    parsed = json.loads(content_text.strip())
                    llm_score = float(parsed.get("score", keyword_score))
                    llm_feedback = parsed.get("feedback", keyword_feedback)
                    return llm_score, llm_feedback
        except Exception as e:
            # En caso de fallo de red o API key inválida, hacer fallback al método determinista
            print(f"[TELEMETRY] Error en evaluación LLM: {e}. Fallback a Keywords.")
            
    return round(keyword_score, 2), keyword_feedback

# ─── ENDPOINTS ───────────────────────────────────────────────

@router.post("/activity")
async def submit_activity(req: ActivitySubmitSchema, db: AsyncSession = Depends(get_db)):
    """
    Registra el envío de una actividad bimensual, evalúa la justificación semánticamente,
    guarda la bitácora y actualiza las notas consolidadas del estudiante.
    """
    # 1. Evaluar justificación semántica
    sem_score, sem_feedback = await evaluate_justification_semantically(req.activity_number, req.justification)

    # 2. Nota consolidada del envío (50% simulador + 50% justificación técnica escrita)
    final_activity_score = round((req.score_sim + sem_score) / 2.0, 2)

    # 3. Guardar en Bitácora (ActivityLedger)
    ledger_entry = ActivityLedger(
        session_id=req.session_id,
        student_code=req.student_code,
        activity_number=req.activity_number,
        score=final_activity_score,
        justification=req.justification,
        semantic_feedback=sem_feedback,
        attempts=1,
        time_spent_seconds=req.time_spent_seconds,
        telemetry_data=req.telemetry_data
    )
    db.add(ledger_entry)

    # 4. Actualizar tabla StudentGrades
    result = await db.execute(select(StudentGrade).filter_by(student_code=req.student_code))
    student = result.scalars().first()
    
    if not student:
        student = StudentGrade(
            student_code=req.student_code,
            full_name=req.full_name
        )
        db.add(student)

    # Lógica de mejor intento: Actualizar solo si la nueva nota es mayor
    grade_field = f"act{req.activity_number}_grade"
    current_grade = getattr(student, grade_field)
    if current_grade is None or final_activity_score > current_grade:
        setattr(student, grade_field, final_activity_score)

    # Actualizar el progreso del estudiante (active_unit) si aprobó la actividad (nota >= 3.0)
    if final_activity_score >= 3.0:
        from db_models import User
        res_user = await db.execute(select(User).filter_by(username=req.student_code))
        user = res_user.scalars().first()
        if user:
            next_unit = req.activity_number + 1
            if next_unit > user.active_unit:
                user.active_unit = next_unit

    await db.flush() # Guardar cambios en sesión

    return {
        "ok": True,
        "activity_number": req.activity_number,
        "score_sim": req.score_sim,
        "score_semantic": sem_score,
        "score_final": final_activity_score,
        "feedback": sem_feedback,
        "student_grades": student.to_dict()
    }

@router.post("/final-exam")
async def submit_final_exam(req: FinalExamSubmitSchema, db: AsyncSession = Depends(get_db)):
    """Registra la nota y la rúbrica cualitativa del examen final (60%)."""
    result = await db.execute(select(StudentGrade).filter_by(student_code=req.student_code))
    student = result.scalars().first()
    if not student:
        raise HTTPException(status_code=404, detail="Estudiante no encontrado. Debe realizar al menos una actividad previa.")

    student.final_exam_grade = req.score
    student.final_exam_comments = req.comments
    student.final_exam_rubric = {
        "matrix_effect": req.rubric_matrix_effect,
        "data_integrity": req.rubric_data_integrity,
        "defense": req.rubric_defense
    }
    await db.flush()

    return {
        "ok": True,
        "student_grades": student.to_dict()
    }

@router.get("/grades")
async def get_all_grades(student_code: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    """Retorna las notas consolidadas de los estudiantes (para el dashboard docente)."""
    if student_code:
        result = await db.execute(select(StudentGrade).filter_by(student_code=student_code))
        student = result.scalars().first()
        if not student:
            raise HTTPException(status_code=404, detail="Estudiante no encontrado")
        return [student.to_dict()]
    else:
        result = await db.execute(select(StudentGrade))
        students = result.scalars().all()
        return [s.to_dict() for s in students]

@router.get("/errors-heatmap")
async def get_errors_heatmap(db: AsyncSession = Depends(get_db)):
    """
    Agrega datos de telemetría de todos los envíos en ActivityLedger para proveer
    al docente un mapa de calor de errores instrumentales y conceptos omitidos.
    """
    result = await db.execute(select(ActivityLedger))
    ledgers = result.scalars().all()

    heatmap = {
        "overpressure": 0,          # Exceso de límite hidráulico
        "poor_resolution": 0,       # Rs < 1.50
        "high_tailing": 0,          # T > 2.0
        "temp_violation": 0,        # Superar Tmax de columna
        "solvent_mismatch": 0,      # Incompatibilidad detector-fase o fase-matriz SPE
        "total_submissions": len(ledgers)
    }

    concept_omissions: dict[str, int] = {}

    for entry in ledgers:
        data = entry.telemetry_data or {}
        
        # 1. Errores instrumentales guardados en la telemetría
        if data.get("errors"):
            for err in data["errors"]:
                if "presión" in err.lower() or "pressure" in err.lower():
                    heatmap["overpressure"] += 1
                if "temperatura" in err.lower() or "temp" in err.lower():
                    heatmap["temp_violation"] += 1
        
        # 2. Advertencias de idoneidad (Resolution & Tailing)
        if data.get("warnings"):
            for warn in data["warnings"]:
                if "resolución" in warn.lower() or "rs" in warn.lower():
                    heatmap["poor_resolution"] += 1
                if "tailing" in warn.lower() or "cola" in warn.lower():
                    heatmap["high_tailing"] += 1
                if "incompatible" in warn.lower() or "mismatch" in warn.lower() or "polaridad" in warn.lower():
                    heatmap["solvent_mismatch"] += 1

        # 3. Contar palabras omitidas de la evaluación de feedback
        feedback = entry.semantic_feedback or ""
        if "omitiste" in feedback.lower():
            try:
                # Extraer las palabras que indica el feedback que fueron omitidas
                parts = feedback.split("omitiste conceptos clave del microcurrículo:")
                if len(parts) > 1:
                    omitted_words = parts[1].split(".")[0].strip().split(",")
                    for w in omitted_words:
                        w_clean = w.strip().lower()
                        if w_clean:
                            concept_omissions[w_clean] = concept_omissions.get(w_clean, 0) + 1
            except Exception:
                pass

    # Formatear conceptos omitidos
    sorted_omissions = [{"concept": k, "count": v} for k, v in sorted(concept_omissions.items(), key=lambda item: item[1], reverse=True)]

    return {
        "ok": True,
        "heatmap": heatmap,
        "frequent_omitted_concepts": sorted_omissions[:10]
    }

@router.get("/rag-feedback/{session_id}")
async def get_rag_feedback(session_id: str):
    """Obtiene y limpia la microcápsula RAG de tutoría correspondiente a la sesión."""
    try:
        redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
        r = redis.Redis.from_url(redis_url, decode_responses=True)
        key = f"chromatox:rag_feedback:{session_id}"
        val = r.get(key)
        if val:
            r.delete(key) # Consumir una sola vez
            return {"ok": True, "data": json.loads(val)}
    except Exception as e:
        print(f"[TELEMETRY] Error al conectar a Redis para RAG: {e}")
    return {"ok": False, "message": "No hay feedback RAG pendiente."}


@router.websocket("/ws/instructor")
async def instructor_websocket(websocket: WebSocket):
    """
    WebSocket para el panel del docente.
    Transmite en tiempo real el mapa de telemetría de todos los estudiantes conectados
    y gestiona comandos de bloqueo/desbloqueo (HITL) o feedback personalizado.
    """
    await websocket.accept()
    
    # Conexión Redis asíncrona
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
    async_redis = aioredis.Redis.from_url(redis_url, decode_responses=True)
    
    # 1. Enviar snapshot inicial de sesiones activas en Redis
    try:
        keys = await async_redis.keys("chromatox:active_session:*")
        active_sessions = []
        for k in keys:
            val = await async_redis.get(k)
            if val:
                active_sessions.append(json.loads(val))
        await websocket.send_json({
            "type": "ACTIVE_SESSIONS",
            "sessions": active_sessions
        })
    except Exception as e:
        print(f"[WS INSTRUCTOR] Error al enviar snapshot: {e}")
        
    # 2. Suscribirse a actualizaciones de telemetría de estudiantes
    pubsub = async_redis.pubsub()
    await pubsub.subscribe("chromatox:instructor_updates")
    
    async def redis_listener():
        try:
            async for message in pubsub.listen():
                if message["type"] == "message":
                    # Reenviar el mensaje de actualización al WebSocket del docente
                    await websocket.send_text(message["data"])
        except Exception as e:
            print(f"[WS INSTRUCTOR] Error en listener PubSub: {e}")
            
    # Lanzar listener de PubSub
    listener_task = asyncio.create_task(redis_listener())
    
    try:
        while True:
            # Escuchar comandos enviados por el docente
            data = await websocket.receive_json()
            cmd_type = data.get("type")
            
            if cmd_type in ["LOCK", "UNLOCK", "SEND_FEEDBACK"]:
                session_id = data.get("session_id")
                if session_id:
                    # Publicar el comando al canal del estudiante correspondiente
                    student_channel = f"chromatox:student_commands:{session_id}"
                    await async_redis.publish(student_channel, json.dumps(data))
                    
                    # Actualizar estado en Redis de forma local
                    session_key = f"chromatox:active_session:{session_id}"
                    session_data_raw = await async_redis.get(session_key)
                    if session_data_raw:
                        sdata = json.loads(session_data_raw)
                        sdata["status"] = "LOCKED" if cmd_type == "LOCK" else "ACTIVE"
                        await async_redis.set(session_key, json.dumps(sdata), ex=300)
                        
            elif cmd_type == "GRADE_OVERRIDE":
                student_code = data.get("student_code")
                activity_number = int(data.get("activity_number"))
                score = float(data.get("score"))
                
                # Ejecutar actualización en la base de datos SQL
                async with AsyncSessionLocal() as session:
                    res = await session.execute(select(StudentGrade).filter_by(student_code=student_code))
                    student = res.scalars().first()
                    if student:
                        grade_field = f"act{activity_number}_grade"
                        setattr(student, grade_field, score)
                        await session.commit()
                        
                        # Informar a todos los docentes
                        update_msg = {
                            "type": "GRADE_OVERRIDE_CONFIRM",
                            "student_code": student_code,
                            "grades": student.to_dict()
                        }
                        await async_redis.publish("chromatox:instructor_updates", json.dumps(update_msg))
                        
            elif cmd_type == "PING":
                await websocket.send_json({"type": "PONG"})
                
    except WebSocketDisconnect:
        print("[WS INSTRUCTOR] Docente desconectado.")
    finally:
        listener_task.cancel()
        await pubsub.unsubscribe("chromatox:instructor_updates")
        await pubsub.close()
        await async_redis.close()
