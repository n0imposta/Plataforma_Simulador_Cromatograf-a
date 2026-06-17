"""
chromatox/backend/db_models.py

Modelos de base de datos SQLAlchemy para el registro de calificaciones (StudentGrades)
y la bitácora de actividades (ActivityLedger), adaptado a las ponderaciones del microcurrículo:
- Actividad 1 y 2: 6% c/u
- Actividad 3 a 6: 7% c/u
- Examen Final: 60%

Configura un motor asíncrono para PostgreSQL (en producción/Docker) o SQLite local (desarrollo).
"""

from __future__ import annotations
import os
from datetime import datetime
from typing import AsyncGenerator

from sqlalchemy import Column, String, Float, Integer, DateTime, Text, JSON, ForeignKey
from sqlalchemy.orm import declarative_base
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

# Variables de entorno para bases de datos
# En desarrollo local si no se define se asume SQLite para evitar dependencias complejas de Postgres
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    DATABASE_URL = "sqlite+aiosqlite:///./chromatox.db"
elif DATABASE_URL.startswith("postgresql://"):
    # Convertir a asyncpg para soporte de SQLAlchemy asíncrono
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://")

# Configurar motor de DB asíncrono
engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

Base = declarative_base()

class StudentGrade(Base):
    __tablename__ = "student_grades"
    
    student_code = Column(String, primary_key=True, index=True)
    full_name = Column(String, nullable=False)
    act1_grade = Column(Float, nullable=True)
    act2_grade = Column(Float, nullable=True)
    act3_grade = Column(Float, nullable=True)
    act4_grade = Column(Float, nullable=True)
    act5_grade = Column(Float, nullable=True)
    act6_grade = Column(Float, nullable=True)
    final_exam_grade = Column(Float, nullable=True)
    final_exam_comments = Column(Text, nullable=True)
    final_exam_rubric = Column(JSON, nullable=True)
    
    @property
    def final_grade(self) -> float:
        """Calcula la nota ponderada final del curso basándose en el microcurrículo."""
        total = 0.0
        weights = [
            (self.act1_grade, 0.06),
            (self.act2_grade, 0.06),
            (self.act3_grade, 0.07),
            (self.act4_grade, 0.07),
            (self.act5_grade, 0.07),
            (self.act6_grade, 0.07),
            (self.final_exam_grade, 0.60)
        ]
        for grade, weight in weights:
            if grade is not None:
                total += grade * weight
        return round(total, 2)

    def to_dict(self) -> dict:
        return {
            "student_code": self.student_code,
            "full_name": self.full_name,
            "act1_grade": self.act1_grade,
            "act2_grade": self.act2_grade,
            "act3_grade": self.act3_grade,
            "act4_grade": self.act4_grade,
            "act5_grade": self.act5_grade,
            "act6_grade": self.act6_grade,
            "final_exam_grade": self.final_exam_grade,
            "final_exam_comments": self.final_exam_comments,
            "final_exam_rubric": self.final_exam_rubric,
            "final_grade": self.final_grade,
        }

class ActivityLedger(Base):
    __tablename__ = "activity_ledger"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, index=True, nullable=False)
    student_code = Column(String, ForeignKey("student_grades.student_code"), nullable=False)
    activity_number = Column(Integer, nullable=False) # 1 a 6
    score = Column(Float, nullable=False)
    justification = Column(Text, nullable=True)
    semantic_feedback = Column(Text, nullable=True)
    attempts = Column(Integer, default=1)
    time_spent_seconds = Column(Integer, default=0)
    telemetry_data = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "student_code": self.student_code,
            "activity_number": self.activity_number,
            "score": self.score,
            "justification": self.justification,
            "semantic_feedback": self.semantic_feedback,
            "attempts": self.attempts,
            "time_spent_seconds": self.time_spent_seconds,
            "telemetry_data": self.telemetry_data,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }

async def init_db():
    """Crea las tablas en la base de datos si no existen."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Generador de sesión de base de datos FastAPI."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
