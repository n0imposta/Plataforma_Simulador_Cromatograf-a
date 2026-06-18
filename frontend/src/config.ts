/**
 * config.ts
 *
 * Configuración dinámica de URLs para conectar con el backend.
 * Soporta variables de entorno de Vite o autodetecta según el entorno (desarrollo/producción).
 */

const isProd = import.meta.env.PROD;

export const BACKEND_URL = (import.meta.env.VITE_API_URL as string) || (isProd
  ? "https://plataforma-simulador-cromatografia.onrender.com"
  : "http://localhost:8000");

export const WS_BACKEND_URL = (import.meta.env.VITE_WS_URL as string) || (isProd
  ? "wss://plataforma-simulador-cromatografia.onrender.com"
  : "ws://localhost:8000");
