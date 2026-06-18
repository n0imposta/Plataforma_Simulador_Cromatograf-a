"""
chromatox/backend/main.py

Punto de entrada de la aplicación FastAPI.
Registra todos los routers, configura CORS, lifespan (startup/shutdown)
y expone el endpoint de health para Docker.
"""

from __future__ import annotations
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from gc_simulator import router as gc_router
from hplc_simulator import router as hplc_router
from telemetry import router as telemetry_router
from quantitative_simulator import router as quant_router
from auth import router as auth_router
from db_models import init_db


# ─── LIFESPAN ────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown tasks."""
    print("[CHROMATOX] Backend iniciando...")

    # Inicializar WS Manager
    from ws_manager import ws_manager
    await ws_manager.init()

    # Inicializar Base de Datos
    try:
        await init_db()
        print("[CHROMATOX] Base de datos inicializada correctamente.")
        
        # Sembrar usuarios iniciales si no existen
        from sqlalchemy.future import select
        from db_models import AsyncSessionLocal, User, StudentGrade, hash_password
        async with AsyncSessionLocal() as session:
            result = await session.execute(select(User))
            users = result.scalars().all()
            if not users:
                print("[CHROMATOX] Sembrando usuarios iniciales...")
                docente = User(
                    username="docente",
                    full_name="Profesor de Cromatografía",
                    hashed_password=hash_password("docente2026"),
                    role="instructor",
                    active_unit=2
                )
                estudiante = User(
                    username="estudiante",
                    full_name="Estudiante Demo",
                    hashed_password=hash_password("estudiante2026"),
                    role="student",
                    active_unit=2
                )
                session.add_all([docente, estudiante])
                
                # También crear su planilla de notas
                std_grade = StudentGrade(
                    student_code="estudiante",
                    full_name="Estudiante Demo"
                )
                session.add(std_grade)
                await session.commit()
                print("[CHROMATOX] Usuarios sembrados con éxito.")
    except Exception as e:
        print(f"[CHROMATOX] Error al inicializar la base de datos: {e}")

    # Inicializar ChromaDB de forma diferida
    try:
        from tasks import get_chromadb_collection
        get_chromadb_collection()
    except Exception as e:
        print(f"[CHROMATOX] Error al conectar ChromaDB en lifespan: {e}")

    yield

    print("[CHROMATOX] Backend cerrando...")


# ─── APP ─────────────────────────────────────────────────────

app = FastAPI(
    title="CHROMATOX·EDU API",
    description=(
        "Motor físico-químico y plataforma pedagógica HITL para "
        "Cromatografía Líquida (HPLC/UHPLC) y Gaseosa (GC). "
        "Universidad de Antioquia — Química Farmacéutica 2026."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)


# ─── CORS ────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",    # Vite dev (standard)
        "http://localhost:5174",
        "http://localhost:5175",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://127.0.0.1:5175",
        "http://localhost:3000",    # Build preview
        "https://chromatox.udea.edu.co",  # Producción
    ],
    allow_origin_regex=r"https://.*\.onrender\.com",  # Permitir cualquier subdominio en Render
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── ROUTERS ─────────────────────────────────────────────────

app.include_router(gc_router)     # /api/gc/*
app.include_router(hplc_router)   # /api/hplc/*
app.include_router(telemetry_router) # /api/telemetry/*
app.include_router(quant_router)  # /api/quantitative/*
app.include_router(auth_router)   # /api/auth/*


# ─── HEALTH ──────────────────────────────────────────────────

@app.get("/health", tags=["Health"])
async def health():
    return {
        "status": "ok",
        "service": "chromatox-backend",
        "version": "1.0.0",
        "modules": ["HPLC", "UHPLC", "GC", "RAG", "HITL"],
    }


@app.get("/", tags=["Root"])
async def root():
    return {
        "message": "CHROMATOX·EDU API v1.0",
        "docs": "/api/docs",
        "health": "/health",
    }
