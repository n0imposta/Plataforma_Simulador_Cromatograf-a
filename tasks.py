"""
chromatox/backend/tasks.py

Tareas asíncronas de Celery para el pipeline de tutoría RAG (ChromaDB + Anthropic API).
Al detectar Rs < 1.50 o Tailing > 2.0, consulta ChromaDB con embeddings del microcurrículo
y genera una 'Microcápsula Informativa Contextual' mediante Claude 3.5 Sonnet,
guardando el feedback en Redis para su consumo en el frontend.
"""

from __future__ import annotations
import os
import json
from celery import Celery
import redis
import httpx

# Inicializar Celery
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
celery = Celery("tasks", broker=REDIS_URL, backend=REDIS_URL)

# Inicializar cliente de Redis para almacenamiento de caché RAG
redis_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)

# ─── INICIALIZACIÓN Y BÚSQUEDA EN CHROMADB ───────────────────

def get_chromadb_collection():
    """Conecta a ChromaDB y retorna la colección del microcurrículo. La inicializa si está vacía."""
    try:
        import chromadb
        from chromadb.config import Settings
        
        # En docker-compose, ChromaDB corre en chromadb:8000. Localmente en localhost:8001 o 8000
        chroma_host = os.getenv("CHROMA_HOST", "localhost")
        chroma_port = int(os.getenv("CHROMA_PORT", 8001))
        
        # Intentar conectar
        client = chromadb.HttpClient(host=chroma_host, port=chroma_port)
        collection = client.get_or_create_collection("microcurriculo_chromatox")
        
        # Inicializar si no tiene documentos
        if collection.count() == 0:
            print("[RAG] Inicializando ChromaDB con microcápsulas académicas...")
            documents = [
                # Darcy y Knox
                "Cromatografía de Líquidos (HPLC/UHPLC) - Hidráulica y Ecuación de Darcy: "
                "La contrapresión del sistema (ΔP) aumenta proporcionalmente a la viscosidad de la fase móvil (η), "
                "la longitud de columna (L) y la velocidad lineal (u), e inversamente al cuadrado del diámetro de partícula (dp^2). "
                "En UHPLC ChroZen se usan partículas de 1.7 µm para aumentar drásticamente la eficiencia (Ecuación de Knox), "
                "pero esto incrementa exponencialmente la presión. Si se superan los 130 MPa (1300 bar), "
                "se produce un fallo catastrófico (estallido estructural de sellos de zafiro y capilares).",
                
                # Resolución e Idoneidad
                "Idoneidad del Sistema y Resolución (Rs): Según USP 49 - NF 44, la resolución de línea base "
                "aceptable entre dos picos cromatográficos adyacentes debe ser Rs ≥ 1.50. "
                "Si la resolución es menor, existe solapamiento físico que impide la cuantificación exacta. "
                "Se puede mejorar Rs modificando el volumen de retención (k') mediante la fracción orgánica (C), "
                "cambiando de solvente (de Metanol a Acetonitrilo para modificar la selectividad alfa) "
                "o utilizando partículas más pequeñas para aumentar el número de platos (N).",
                
                # Tailing de picos
                "Asimetría y Factor de Cola (Tailing USP): Un factor de cola superior a 2.0 indica "
                "picos severamente asimétricos. En la farmacopea USP 49 se restringe T ≤ 2.0 debido a que "
                "anchos de cola excesivos introducen errores graves de integración en el software cromatográfico. "
                "El tailing se debe frecuentemente a interacciones secundarias silanofílicas (silanoles activos de la sílice "
                "atrayendo compuestos básicos), sobrecarga de columna o flujo no óptimo. Se corrige desactivando silanoles "
                "o agregando reguladores de pH (buffers).",
                
                # SPE (Unidad 2)
                "Extracción en Fase Sólida (SPE) - Acondicionamiento y Lavado: Para fase reversa (C18), "
                "el acondicionamiento con metanol es mandatorio para humectar/abrir las cadenas de C18 (que son altamente hidrofóbicas "
                "y se colapsan en agua pura). Luego, el equilibrado con agua prepara el lecho. La carga debe ser en disolvente débil (agua) "
                "para retener los analitos. Un solvente de lavado muy fuerte (ej. alto % de metanol) eluirá los analitos polares como "
                "el Paracetamol prematuramente, mientras que el Ibuprofeno (apolar) se eluye con alto % orgánico (>80% MeOH/ACN)."
            ]
            
            # Embeddings locales por defecto si no hay API externa configurada
            collection.add(
                documents=documents,
                ids=["doc_darcy", "doc_resolution", "doc_tailing", "doc_spe"],
                metadatas=[
                    {"unidad": 3, "tema": "hidraulica"},
                    {"unidad": 4, "tema": "resolucion"},
                    {"unidad": 3, "tema": "tailing"},
                    {"unidad": 2, "tema": "spe"}
                ]
            )
            print("[RAG] ChromaDB inicializado exitosamente.")
            
        return collection
    except Exception as e:
        print(f"[RAG] No se pudo conectar a ChromaDB o inicializar: {e}. Se usará fallback local.")
        return None

# ─── TAREA CELERY RAG ────────────────────────────────────────

@celery.task(name="tasks.query_rag_feedback")
def query_rag_feedback(session_id: str, student_code: str, error_type: str, context_details: str):
    """
    Busca información en ChromaDB relevante al error y usa Claude 3.5 Sonnet
    para redactar una Microcápsula Informativa que fuerce fricción útil pedagógica.
    """
    print(f"[RAG Task] Iniciando búsqueda adaptativa para {student_code} en sesión {session_id} por: {error_type}")

    # 1. Recuperar contexto de ChromaDB
    collection = get_chromadb_collection()
    retrieved_context = ""
    
    if collection:
        try:
            # Buscar documentos similares al error
            results = collection.query(
                query_texts=[error_type + " " + context_details],
                n_results=1
            )
            if results and results["documents"]:
                retrieved_context = results["documents"][0][0]
                print(f"[RAG Task] Contexto recuperado de ChromaDB: {retrieved_context[:100]}...")
        except Exception as e:
            print(f"[RAG Task] Error consultando ChromaDB: {e}")

    # Fallback si no hay ChromaDB
    if not retrieved_context:
        if "presión" in error_type.lower() or "darcy" in error_type.lower():
            retrieved_context = (
                "Ecuación de Darcy: La presión depende de viscosidad, velocidad lineal y longitud, e inversamente del cuadrado del diámetro de partícula. "
                "Límite crítico UHPLC ChroZen: 130 MPa."
            )
        elif "tailing" in error_type.lower() or "asimetría" in error_type.lower():
            retrieved_context = (
                "Tailing USP 49 exige T <= 2.0. Picos asimétricos causan errores de integración. "
                "Se corrige ajustando pH o usando fases de silanoles desactivados."
            )
        else:
            retrieved_context = (
                "Resolución USP exige Rs >= 1.50 para garantizar separación en línea base. "
                "Para mejorar Rs, modifica solvente orgánico, aumenta longitud de columna o disminuye partículas."
            )

    # 2. Generar Feedback con Anthropic Claude
    feedback_text = ""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    
    if api_key and api_key.strip() and api_key != "${ANTHROPIC_API_KEY}":
        try:
            prompt = (
                f"Actúa como un Tutor Inteligente y Senior en Química Farmacéutica de la Universidad de Antioquia.\n"
                f"El estudiante '{student_code}' cometió el siguiente error cromatográfico: {error_type}.\n"
                f"Detalles técnicos del simulador: {context_details}.\n"
                f"Fundamento del microcurrículo:\n{retrieved_context}\n\n"
                f"Escribe una 'Microcápsula Informativa Contextual' breve (máximo 3-4 líneas) en un tono académico, "
                f"explicando el mecanismo del error físico-químico y forzando la fricción útil (HITL Gate): "
                f"no le des la respuesta directa del parámetro correcto, sino guíalo a que deduzca la ecuación adecuada.\n"
                f"Comienza directamente con el texto explicativo sin introducciones vacías como 'Aquí tienes...'."
            )
            
            with httpx.Client() as client:
                response = client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json"
                    },
                    json={
                        "model": "claude-3-5-sonnet-20241022",
                        "max_tokens": 250,
                        "messages": [{"role": "user", "content": prompt}]
                    },
                    timeout=10.0
                )
                if response.status_code == 200:
                    res_json = response.json()
                    feedback_text = res_json["content"][0]["text"].strip()
                    print("[RAG Task] Feedback generado por Claude exitosamente.")
        except Exception as e:
            print(f"[RAG Task] Error llamando a Claude: {e}")

    # Fallback de feedback si Claude falla o no está configurado
    if not feedback_text:
        if "presión" in error_type.lower():
            feedback_text = (
                f"⚠️ ALERTA HIDRÁULICA: Has superado el límite estructural (130 MPa) del equipo. "
                f"Recuerda la Ecuación de Darcy: la contrapresión es inversamente proporcional al cuadrado del diámetro de partícula (dp^2). "
                f"¿Cómo afecta pasar de 5 µm a 1.7 µm si mantienes el mismo caudal?"
            )
        elif "tailing" in error_type.lower():
            feedback_text = (
                f"⚠️ ALERTA DE ASIMETRÍA: El factor de cola del Ibuprofeno ({context_details}) supera el límite de USP 49 (T ≤ 2.0). "
                f"Esto indica interacciones silanofílicas secundarias indeseadas. ¿Qué rol tiene el % de solvente orgánico "
                f"y la polaridad en la fase reversa para reducir la cola?"
            )
        else:
            feedback_text = (
                f"⚠️ ALERTA DE IDONEIDAD: La resolución Rs ({context_details}) es inferior a 1.50 (USP 49). "
                f"Para mejorar la resolución, debes incidir sobre N (longitud, partícula) o alfa (selectividad, cambiando de solvente). "
                f"Prueba modificando la fracción de modificador orgánico."
            )

    # 3. Guardar en Redis caché
    cache_key = f"chromatox:rag_feedback:{session_id}"
    cache_data = {
        "error_type": error_type,
        "feedback": feedback_text,
        "context_details": context_details
    }
    redis_client.set(cache_key, json.dumps(cache_data), ex=300) # Expira en 5 minutos
    print(f"[RAG Task] Feedback guardado en Redis con la clave: {cache_key}")
