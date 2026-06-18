"""
ws_manager.py

Administrador unificado de conexiones WebSocket y almacenamiento de telemetría.
Valida la conexión a Redis en el arranque. Si falla o no está configurado,
activa un fallback en memoria para persistir las sesiones y enrutar mensajes
de manera local y síncrona, asegurando el funcionamiento en Render (tier gratis).
"""

from __future__ import annotations
import os
import json
import time
import asyncio
from typing import Dict, Set, List, Optional
from fastapi import WebSocket
import redis.asyncio as aioredis

class WSManager:
    def __init__(self) -> None:
        self.use_redis: bool = False
        self.redis_client: Optional[aioredis.Redis] = None
        
        # Fallback en memoria para despliegues monoproceso
        self._active_sessions: Dict[str, dict] = {}
        self._student_sockets: Dict[str, Set[WebSocket]] = {}
        self._instructor_sockets: Set[WebSocket] = set()
        self._rag_feedbacks: Dict[str, dict] = {}
        
        # Tareas en segundo plano para escuchar actualizaciones de Redis PubSub por WebSocket
        self._listener_tasks: Dict[WebSocket, asyncio.Task] = {}

    async def init(self) -> None:
        """Prueba la conectividad a Redis y configura el modo de operación."""
        redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
        try:
            print(f"[WS MANAGER] Conectando a Redis en {redis_url}...")
            client = aioredis.Redis.from_url(redis_url, decode_responses=True, socket_connect_timeout=1.0)
            await client.ping()
            self.redis_client = client
            self.use_redis = True
            print("[WS MANAGER] Conectado a Redis. Modo distribuido activo.")
        except Exception as e:
            self.use_redis = False
            self.redis_client = None
            print(f"[WS MANAGER] Error al conectar a Redis: {e}. Fallback En Memoria activo.")

    async def register_session(self, session_id: str, data: dict) -> None:
        """Registra o actualiza el estado de telemetría de una sesión activa."""
        data["timestamp"] = time.time()
        
        if self.use_redis and self.redis_client:
            try:
                session_key = f"chromatox:active_session:{session_id}"
                await self.redis_client.set(session_key, json.dumps(data), ex=3600)
                await self.redis_client.publish("chromatox:instructor_updates", json.dumps({"type": "STUDENT_UPDATE", **data}))
            except Exception as e:
                print(f"[WS MANAGER] Error escribiendo en Redis: {e}. Reintentando guardar en memoria local.")
                self._active_sessions[session_id] = data
        else:
            self._active_sessions[session_id] = data
            await self.broadcast_student_update({"type": "STUDENT_UPDATE", **data})

    async def get_active_sessions(self) -> List[dict]:
        """Retorna todas las sesiones activas en el sistema."""
        if self.use_redis and self.redis_client:
            try:
                keys = await self.redis_client.keys("chromatox:active_session:*")
                sessions = []
                for k in keys:
                    val = await self.redis_client.get(k)
                    if val:
                        sessions.append(json.loads(val))
                return sessions
            except Exception as e:
                print(f"[WS MANAGER] Error leyendo sesiones de Redis: {e}. Usando fallback local.")
                return list(self._active_sessions.values())
        else:
            # Limpiar sesiones expiradas (más de 1 hora)
            now = time.time()
            expired = [sid for sid, s in self._active_sessions.items() if now - s.get("timestamp", 0) > 3600]
            for sid in expired:
                del self._active_sessions[sid]
            return list(self._active_sessions.values())

    async def connect_student(self, session_id: str, websocket: WebSocket) -> None:
        """Asocia un socket de estudiante a su ID de sesión."""
        if session_id not in self._student_sockets:
            self._student_sockets[session_id] = set()
        self._student_sockets[session_id].add(websocket)
        
        # Si hay Redis, nos suscribimos a su canal de comandos en segundo plano
        if self.use_redis and self.redis_client:
            pubsub = self.redis_client.pubsub()
            await pubsub.subscribe(f"chromatox:student_commands:{session_id}")
            
            async def command_listener():
                try:
                    async for message in pubsub.listen():
                        if message["type"] == "message":
                            cmd_data = json.loads(message["data"])
                            await websocket.send_json(cmd_data)
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    print(f"[WS MANAGER] Error en PubSub de estudiante: {e}")
                finally:
                    await pubsub.unsubscribe(f"chromatox:student_commands:{session_id}")
                    await pubsub.close()

            task = asyncio.create_task(command_listener())
            self._listener_tasks[websocket] = task

    async def disconnect_student(self, session_id: str, websocket: WebSocket) -> None:
        """Remueve la conexión del estudiante y detiene las escuchas."""
        if session_id in self._student_sockets:
            self._student_sockets[session_id].discard(websocket)
            if not self._student_sockets[session_id]:
                del self._student_sockets[session_id]
                
        task = self._listener_tasks.pop(websocket, None)
        if task:
            task.cancel()

    async def connect_instructor(self, websocket: WebSocket) -> None:
        """Registra un socket de docente para telemetría en vivo."""
        self._instructor_sockets.add(websocket)
        
        if self.use_redis and self.redis_client:
            pubsub = self.redis_client.pubsub()
            await pubsub.subscribe("chromatox:instructor_updates")
            
            async def update_listener():
                try:
                    async for message in pubsub.listen():
                        if message["type"] == "message":
                            await websocket.send_text(message["data"])
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    print(f"[WS MANAGER] Error en PubSub de instructor: {e}")
                finally:
                    await pubsub.unsubscribe("chromatox:instructor_updates")
                    await pubsub.close()
                    
            task = asyncio.create_task(update_listener())
            self._listener_tasks[websocket] = task

    async def disconnect_instructor(self, websocket: WebSocket) -> None:
        """Remueve la conexión del docente."""
        self._instructor_sockets.discard(websocket)
        task = self._listener_tasks.pop(websocket, None)
        if task:
            task.cancel()

    async def send_command_to_student(self, session_id: str, command: dict) -> None:
        """Envía comandos (LOCK/UNLOCK/FEEDBACK) a un estudiante específico."""
        if self.use_redis and self.redis_client:
            try:
                student_channel = f"chromatox:student_commands:{session_id}"
                await self.redis_client.publish(student_channel, json.dumps(command))
            except Exception as e:
                print(f"[WS MANAGER] Error publicando comando en Redis: {e}")
        else:
            # Despacho en memoria directo
            sockets = self._student_sockets.get(session_id, set())
            for ws in list(sockets):
                try:
                    await ws.send_json(command)
                except Exception as e:
                    print(f"[WS MANAGER] Error al enviar comando directo: {e}")
                    self._student_sockets[session_id].discard(ws)

    async def broadcast_student_update(self, update_data: dict) -> None:
        """Notifica cambios en vivo a todos los instructores conectados."""
        if self.use_redis and self.redis_client:
            try:
                await self.redis_client.publish("chromatox:instructor_updates", json.dumps(update_data))
            except Exception as e:
                print(f"[WS MANAGER] Error publicando actualización de estudiante en Redis: {e}")
        else:
            # Despacho en memoria directo
            for ws in list(self._instructor_sockets):
                try:
                    await ws.send_json(update_data)
                except Exception as e:
                    print(f"[WS MANAGER] Error enviando actualización directa: {e}")
                    self._instructor_sockets.discard(ws)

    async def get_rag_feedback(self, session_id: str) -> Optional[dict]:
        """Obtiene y consume el RAG feedback de la cola."""
        if self.use_redis and self.redis_client:
            try:
                key = f"chromatox:rag_feedback:{session_id}"
                val = await self.redis_client.get(key)
                if val:
                    await self.redis_client.delete(key)
                    return json.loads(val)
            except Exception as e:
                print(f"[WS MANAGER] Error al consumir RAG de Redis: {e}")
            return None
        else:
            return self._rag_feedbacks.pop(session_id, None)

    def set_rag_feedback_sync(self, session_id: str, feedback_data: dict) -> None:
        """Guarda sincrónicamente el feedback RAG (llamado desde tareas síncronas/hilos de fondo)."""
        self._rag_feedbacks[session_id] = feedback_data

# Instancia singleton para importar en el backend
ws_manager = WSManager()
