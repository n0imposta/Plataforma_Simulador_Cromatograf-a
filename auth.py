"""
auth.py

Enrutador FastAPI para autenticación de usuarios (estudiantes y docentes).
Maneja el registro de nuevos estudiantes y la validación de credenciales.
"""

from __future__ import annotations
import os
import json
import uuid
import time
import redis
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.future import select
from sqlalchemy.ext.asyncio import AsyncSession

from db_models import get_db, User, StudentGrade, hash_password

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


# ─── SCHEMAS ─────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str = Field(..., description="Código de estudiante o usuario de docente")
    password: str = Field(..., description="Contraseña")


class RegisterRequest(BaseModel):
    username: str = Field(..., description="Código de estudiante (ej. QF-2026-001)")
    password: str = Field(..., description="Contraseña")
    full_name: str = Field(..., description="Nombre completo del estudiante")


# ─── ENDPOINTS ───────────────────────────────────────────────

@router.post("/login")
async def login(req: LoginRequest, db: AsyncSession = Depends(get_db)):
    """Inicia sesión validando credenciales y registra la sesión activa en Redis."""
    result = await db.execute(select(User).filter_by(username=req.username))
    user = result.scalars().first()

    if not user:
        raise HTTPException(status_code=401, detail="Código de usuario o contraseña incorrectos.")

    if user.hashed_password != hash_password(req.password):
        raise HTTPException(status_code=401, detail="Código de usuario o contraseña incorrectos.")

    # Generar un ID de sesión único
    session_id = f"ses-{uuid.uuid4().hex[:8]}"

    # Registrar en Redis la sesión activa si es estudiante, para que el dashboard docente lo vea
    if user.role == "student":
        try:
            redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
            r = redis.Redis.from_url(redis_url, decode_responses=True)
            session_key = f"chromatox:active_session:{session_id}"
            
            sdata = {
                "session_id": session_id,
                "student_code": user.username,
                "full_name": user.full_name,
                "route": "spe",  # Comienza por defecto en SPE (Unidad 2)
                "status": "ACTIVE",
                "time_left": 3600,
                "active_unit": user.active_unit,
                "timestamp": time.time(),
                "metrics": {}
            }
            r.set(session_key, json.dumps(sdata), ex=3600)  # Expira en 1 hora
            # Publicar actualización al canal PubSub del docente
            r.publish("chromatox:instructor_updates", json.dumps({"type": "STUDENT_UPDATE", **sdata}))
        except Exception as e:
            print(f"[AUTH API] Advertencia al conectar con Redis: {e}")

    return {
        "ok": True,
        "session_id": session_id,
        "student_code": user.username,
        "full_name": user.full_name,
        "role": user.role,
        "active_unit": user.active_unit
    }


@router.post("/register")
async def register(req: RegisterRequest, db: AsyncSession = Depends(get_db)):
    """Registra un nuevo estudiante en el sistema y crea su planilla de notas vacía."""
    # Verificar si el código ya existe
    result = await db.execute(select(User).filter_by(username=req.username))
    existing_user = result.scalars().first()
    if existing_user:
        raise HTTPException(status_code=400, detail="El código de estudiante ya se encuentra registrado.")

    # Crear usuario estudiante
    new_user = User(
        username=req.username,
        full_name=req.full_name,
        hashed_password=hash_password(req.password),
        role="student",
        active_unit=2  # Comienza en la Unidad 2 (SPE)
    )
    db.add(new_user)

    # Crear automáticamente su planilla en student_grades para que aparezca en el panel docente
    result_grade = await db.execute(select(StudentGrade).filter_by(student_code=req.username))
    existing_grade = result_grade.scalars().first()
    if not existing_grade:
        new_grade = StudentGrade(
            student_code=req.username,
            full_name=req.full_name
        )
        db.add(new_grade)

    await db.flush()

    return {
        "ok": True,
        "message": "Registro exitoso. Ahora puedes iniciar sesión con tus credenciales."
    }
