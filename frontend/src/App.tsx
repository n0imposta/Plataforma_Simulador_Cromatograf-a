/**
 * App.tsx
 *
 * Pantalla integradora principal de CHROMATOX·EDU.
 * Enruta entre módulos:
 *   /              → Splash / Login
 *   /hplc          → ChromatogramPanel (Unidades 3-4: HPLC / UHPLC)
 *   /gc            → GCSimulatorPanel  (Unidad 5: GC)
 *   /vandeemter    → VanDeemterChart   (HPLC + GC, comparación gases)
 *   /dashboard     → InstructorDashboard
 *   /caso/:n       → CaseRouter        (ABP diagnostics por caso)
 *
 * Diseño: sidebar collapsible + topbar de sesión + área de contenido.
 * Sin react-router — enrutamiento interno con useState.
 */

import { useState, useEffect } from "react";
import { BACKEND_URL, WS_BACKEND_URL } from "./config";
import GCSimulatorPanel       from "./components/GCSimulatorPanel";
import VanDeemterChart        from "./components/VanDeemterChart";
import HPLCSimulatorPanel     from "./components/HPLCSimulatorPanel";
import SPEWorkspacePanel      from "./components/SPEWorkspacePanel";
import OnlineSessionManager   from "./components/OnlineSessionManager";
import InstructorDashboard   from "./components/InstructorDashboard";
import QuantitativeWorkspace from "./components/QuantitativeWorkspace";

// ─── TIPOS ───────────────────────────────────────────────────

type Route =
  | "home"
  | "hplc"
  | "uhplc"
  | "gc"
  | "vandeemter_hplc"
  | "vandeemter_gc"
  | "dashboard"
  | "spe"
  | "quantitative";

type Role = "student" | "instructor";

interface AppSession {
  sessionId: string;
  studentCode: string;
  fullName: string;
  role: Role;
  activeCase: number;
  activeUnit: number;
}

// ─── TYPES ────────────────────────────────────────────────────
// AppSession, Route, Role defined at root level

// ─── NAV ITEMS ────────────────────────────────────────────────

const NAV_ITEMS: { route: Route; icon: string; label: string; unit: string; roles: Role[] }[] = [
  { route: "hplc",           icon: "💧", label: "HPLC",             unit: "Unidad 3", roles: ["student","instructor"] },
  { route: "uhplc",          icon: "⚡", label: "UHPLC",            unit: "Unidad 4", roles: ["student","instructor"] },
  { route: "gc",             icon: "🔥", label: "GC",               unit: "Unidad 5", roles: ["student","instructor"] },
  { route: "vandeemter_hplc",icon: "📈", label: "van Deemter",      unit: "HPLC/UHPLC", roles: ["student","instructor"] },
  { route: "vandeemter_gc",  icon: "📊", label: "Golay",            unit: "GC",      roles: ["student","instructor"] },
  { route: "spe",            icon: "🧪", label: "Extrac. Fase Sól.", unit: "Unidad 2", roles: ["student","instructor"] },
  { route: "quantitative",   icon: "📊", label: "Taller Cuant.",    unit: "Unidad 6", roles: ["student","instructor"] },
  { route: "dashboard",      icon: "🖥",  label: "Dashboard Docente",unit: "Admin",   roles: ["instructor"] },
];

// ─── SUB-COMPONENTS ──────────────────────────────────────────

function NavItem({
  item, active, onClick,
}: {
  item: typeof NAV_ITEMS[0];
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-md transition-colors cursor-pointer
        flex items-center gap-3
        ${active
          ? "bg-[#21262d] border border-[#30363d] text-slate-200"
          : "text-slate-600 hover:text-slate-400 hover:bg-[#161b22]"
        }`}
    >
      <span className="text-base">{item.icon}</span>
      <div>
        <p className="text-xs font-mono font-bold leading-none">{item.label}</p>
        <p className="text-[9px] text-slate-700 mt-0.5">{item.unit}</p>
      </div>
      {active && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-400" />}
    </button>
  );
}

function UnitProgress({ activeUnit }: { activeUnit: number }) {
  const units = [
    { n: 1, label: "Generalidades" },
    { n: 2, label: "SPE" },
    { n: 3, label: "HPLC" },
    { n: 4, label: "UHPLC" },
    { n: 5, label: "GC" },
    { n: 6, label: "Cuantitativo" },
  ];
  return (
    <div className="px-3 py-2 border-t border-[#21262d]">
      <p className="text-[9px] uppercase tracking-widest text-slate-600 mb-2">Progreso del curso</p>
      <div className="space-y-1">
        {units.map(u => (
          <div key={u.n} className="flex items-center gap-2">
            <div className={`w-4 h-4 rounded-full border flex items-center justify-center text-[8px] font-bold ${
              u.n < activeUnit  ? "bg-emerald-900/60 border-emerald-700 text-emerald-400" :
              u.n === activeUnit ? "bg-blue-900/60 border-blue-700 text-blue-400" :
              "border-slate-800 text-slate-700"
            }`}>
              {u.n < activeUnit ? "✓" : u.n}
            </div>
            <span className={`text-[10px] ${
              u.n === activeUnit ? "text-blue-400 font-bold" :
              u.n < activeUnit  ? "text-slate-500" : "text-slate-700"
            }`}>{u.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────

export default function App() {
  const [session, setSession] = useState<AppSession | null>(() => {
    const saved = localStorage.getItem("chromatox_session");
    return saved ? JSON.parse(saved) : null;
  });
  const [route, setRoute] = useState<Route>("spe");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isDark] = useState(true); // siempre dark — estética de laboratorio
  const [isLocked, setIsLocked] = useState(false);
  const [instructorFeedback, setInstructorFeedback] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<"connecting" | "online" | "disconnected">("disconnected");

  // Enrutar según progreso o rol tras iniciar sesión
  useEffect(() => {
    if (!session) return;
    if (session.role === "instructor") {
      setRoute("dashboard");
    } else {
      const unitRouteMap: Record<number, Route> = {
        2: "spe",
        3: "hplc",
        4: "uhplc",
        5: "gc",
        6: "quantitative"
      };
      setRoute(unitRouteMap[session.activeUnit] || "spe");
    }
  }, [session]);

  const handleActivityValidated = (nextUnit: number) => {
    setSession(s => {
      if (!s) return null;
      const updated = { ...s, activeUnit: nextUnit };
      localStorage.setItem("chromatox_session", JSON.stringify(updated));
      return updated;
    });
  };

  // WebSocket global de estudiante para telemetría activa y compuertas HITL
  useEffect(() => {
    if (!session) return;
    const wsUrl = `${WS_BACKEND_URL}/api/hplc/ws/${session.sessionId}?student_code=${session.studentCode}&full_name=${encodeURIComponent(session.fullName)}`;
    let ws: WebSocket | null = null;
    let timer: number;

    const connectWs = () => {
      setWsStatus("connecting");
      try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          setWsStatus("online");
        };
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "LOCK") {
            setIsLocked(true);
          } else if (data.type === "UNLOCK") {
            setIsLocked(false);
          } else if (data.type === "SEND_FEEDBACK") {
            setInstructorFeedback(data.feedback);
          } else if (data.type === "DELETE_SESSION") {
            localStorage.removeItem("chromatox_session");
            window.location.reload();
          }
        };
        ws.onerror = () => {
          setWsStatus("disconnected");
        };
        ws.onclose = () => {
          setWsStatus("disconnected");
          timer = window.setTimeout(connectWs, 5000);
        };
      } catch (e) {
        setWsStatus("disconnected");
        timer = window.setTimeout(connectWs, 5000);
      }
    };

    connectWs();
    return () => {
      ws?.close();
      clearTimeout(timer);
    };
  }, [session?.sessionId, session?.studentCode, session?.fullName]);

  // Telemetría de simulación en vivo para calificar en tiempo real
  const [hplcMetrics, setHplcMetrics] = useState<any>(null);
  const [speMetrics, setSpeMetrics] = useState<any>(null);

  // Cálculo de notas de simulación en tiempo real (0.0 a 5.0)
  const currentSimScore = (() => {
    if (!session) return 1.0;
    if (route === "hplc" || route === "uhplc") {
      if (!hplcMetrics) return 1.0;
      if (hplcMetrics.errors && hplcMetrics.errors.length > 0) return 1.0; // Falla hidráulica
      let score = 2.0;
      if (hplcMetrics.rs >= 1.50) {
        score = 5.0;
      } else if (hplcMetrics.rs >= 1.00) {
        score = 3.5;
      }
      // Penalizar por tailing USP excesivo
      if (hplcMetrics.peak_b && hplcMetrics.peak_b.tailing_factor_usp > 2.0) {
        score = Math.max(1.0, score - 1.0);
      }
      return score;
    }
    if (route === "spe") {
      if (!speMetrics) return 1.0;
      // Evaluar recuperación de Ibuprofeno y su pureza
      const rec = speMetrics.analyte_b?.percent_recovered ?? 0.0;
      const pur = speMetrics.purity_b_pct ?? 0.0;
      const score = (rec / 100.0) * 4.0 + (pur / 100.0) * 1.0;
      return Math.max(1.0, Math.min(5.0, score));
    }
    return 1.0;
  })();

  const currentTelemetryData = (() => {
    if (route === "hplc" || route === "uhplc") {
      return hplcMetrics || {};
    }
    if (route === "spe") {
      return speMetrics || {};
    }
    return {};
  })();

  // Filtrar nav por rol
  const visibleNav = session ? NAV_ITEMS.filter(n => n.roles.includes(session.role)) : [];

  // Notificaciones de alerta (mockup — en prod viene por WS)
  const [alerts, setAlerts] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setAlerts(2), 8000);
    return () => clearTimeout(t);
  }, []);

  const renderContent = () => {
    if (!session) return null;
    switch (route) {
      case "hplc":
        return (
          <div className="space-y-4">
            <OnlineSessionManager
              sessionId={session.sessionId}
              studentCode={session.studentCode}
              fullName={session.fullName}
              activityNumber={3}
              currentSimScore={currentSimScore}
              telemetryData={currentTelemetryData}
              onActivityValidated={(_score) => handleActivityValidated(4)}
            />
            <HPLCSimulatorPanel
              sessionId={session.sessionId}
              caseNumber={1}
              onSimulationUpdate={(m) => setHplcMetrics(m)}
            />
          </div>
        );
      case "uhplc":
        return (
          <div className="space-y-4">
            <OnlineSessionManager
              sessionId={session.sessionId + "-uhplc"}
              studentCode={session.studentCode}
              fullName={session.fullName}
              activityNumber={4}
              currentSimScore={currentSimScore}
              telemetryData={currentTelemetryData}
              onActivityValidated={(_score) => handleActivityValidated(5)}
            />
            <HPLCSimulatorPanel
              sessionId={session.sessionId + "-uhplc"}
              caseNumber={2}
              onSimulationUpdate={(m) => setHplcMetrics(m)}
            />
          </div>
        );
      case "gc":
        return <GCSimulatorPanel sessionId={session.sessionId} />;
      case "vandeemter_hplc":
        return (
          <VanDeemterChart
            technique="HPLC"
            initialColumnKey="C18_3um"
            gateUnlocked={true}
            operatingPoint={{ u: 1.0, hetp: 0.032, label: "Punto actual" }}
            onOptimalVelocityFound={(u, h) =>
              console.log(`HPLC u_opt=${u.toFixed(2)} mm/min, HETP_min=${h.toFixed(4)} mm`)
            }
          />
        );
      case "vandeemter_gc":
        return (
          <VanDeemterChart
            technique="GC"
            initialColumnKey="DB5_30m"
            gateUnlocked={true}
            onOptimalVelocityFound={(u, h) =>
              console.log(`GC u_opt=${u.toFixed(2)} cm/s, HETP_min=${h.toFixed(4)} mm`)
            }
          />
        );
      case "spe":
        return (
          <div className="space-y-4">
            <OnlineSessionManager
              sessionId={session.sessionId + "-spe"}
              studentCode={session.studentCode}
              fullName={session.fullName}
              activityNumber={2}
              currentSimScore={currentSimScore}
              telemetryData={currentTelemetryData}
              onActivityValidated={(_score) => handleActivityValidated(3)}
            />
            <SPEWorkspacePanel
              sessionId={session.sessionId}
              onSimulationUpdate={(m) => setSpeMetrics(m)}
            />
          </div>
        );
      case "quantitative":
        return (
          <div className="space-y-4">
            <OnlineSessionManager
              sessionId={session.sessionId + "-quantitative"}
              studentCode={session.studentCode}
              fullName={session.fullName}
              activityNumber={6}
              currentSimScore={5.0}
              telemetryData={currentTelemetryData}
              onActivityValidated={(_score) => handleActivityValidated(6)}
            />
            <QuantitativeWorkspace
              sessionId={session.sessionId}
              studentCode={session.studentCode}
              fullName={session.fullName}
              onActivityValidated={(_score) => handleActivityValidated(6)}
            />
          </div>
        );
      case "dashboard":
        return session.role === "instructor"
          ? <InstructorDashboard />
          : <p className="text-red-400 font-mono p-8">Acceso restringido — solo docentes</p>;
      default:
        return <p className="text-slate-500 font-mono p-8">Módulo en construcción</p>;
    }
  };

  if (!session) {
    return <LoginScreen onLoginSuccess={setSession} />;
  }

  return (
    <div className={`flex h-screen bg-[#010409] text-slate-300 font-mono overflow-hidden ${isDark ? "dark" : ""}`}>
  
        {/* OVERLAY DE BLOQUEO DE INSTRUCTOR */}
        {isLocked && (
          <div className="absolute inset-0 bg-[#000]/85 backdrop-blur-sm z-[100] flex flex-col items-center justify-center text-center p-6 animate-fadeIn">
            <span className="text-6xl mb-4">🔒</span>
            <h2 className="text-amber-500 text-lg font-extrabold tracking-wider uppercase mb-2">
              SIMULADOR BLOQUEADO POR EL DOCENTE
            </h2>
            <p className="text-slate-400 font-mono text-xs max-w-md mb-6 leading-relaxed">
              El docente ha bloqueado tu panel de control de forma temporal (HITL Gate manual).
              Esto puede deberse a que realizaste múltiples intentos de ensayo y error o requieres
              revisar tu fundamento analítico.
            </p>
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg px-4 py-3 text-[10px] text-slate-500">
              Espera a que el docente autorice el acceso nuevamente.
            </div>
          </div>
        )}
  
        {/* MENSAJE FLOTANTE DE INSTRUCTOR */}
        {instructorFeedback && (
          <div className="absolute bottom-10 right-10 bg-[#13112c] border-2 border-purple-500 text-slate-300 font-mono text-xs rounded-xl p-4 shadow-2xl max-w-sm z-[90] animate-bounce">
            <div className="flex justify-between items-center border-b border-purple-500 pb-1 mb-2 font-bold text-purple-400">
              <span>🔮 Mensaje en Vivo del Docente</span>
              <button onClick={() => setInstructorFeedback(null)} className="text-slate-500 hover:text-white cursor-pointer font-bold text-sm px-1">×</button>
            </div>
            <p className="italic font-sans text-xs">"{instructorFeedback}"</p>
          </div>
        )}
  
        {/* ── SIDEBAR ── */}
      <aside className={`flex flex-col border-r border-[#21262d] bg-[#0d1117] transition-all duration-300 ${
        sidebarOpen ? "w-52" : "w-12"
      }`}>
        {/* Logo */}
        <div className="flex items-center gap-2 px-3 py-3 border-b border-[#21262d]">
          <span className="text-emerald-400 text-sm font-bold shrink-0">●</span>
          {sidebarOpen && (
            <span className="text-slate-300 text-xs font-bold tracking-wider">CHROMATOX·EDU</span>
          )}
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="ml-auto text-slate-700 hover:text-slate-400 cursor-pointer text-sm"
          >
            {sidebarOpen ? "‹" : "›"}
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-2 px-2 space-y-0.5 overflow-y-auto">
          {visibleNav.map(item => (
            <NavItem
              key={item.route}
              item={item}
              active={route === item.route}
              onClick={() => setRoute(item.route)}
            />
          ))}
        </nav>

        {/* Progreso */}
        {sidebarOpen && <UnitProgress activeUnit={session.activeUnit} />}

        {/* Session info */}
        <div className="px-3 py-2 border-t border-[#21262d]">
          {sidebarOpen ? (
            <>
              <p className="text-slate-400 text-[10px] font-bold">{session.fullName}</p>
              <p className="text-slate-700 text-[9px]">{session.studentCode}</p>
              <div className="flex items-center gap-1 mt-1">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span className="text-emerald-400 text-[9px]">Sesión activa</span>
              </div>
            </>
          ) : (
            <div className="w-2 h-2 rounded-full bg-emerald-400 mx-auto" />
          )}
        </div>
      </aside>

      {/* ── MAIN AREA ── */}
      <div className="flex flex-col flex-1 overflow-hidden">

        {/* Topbar */}
        <header className="flex items-center justify-between px-4 py-2 border-b border-[#21262d] bg-[#0d1117] shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-slate-400 text-xs">
              {visibleNav.find(n => n.route === route)?.icon}{" "}
              {visibleNav.find(n => n.route === route)?.label}
            </span>
            <span className="text-slate-700 text-xs">—</span>
            <span className="text-slate-600 text-xs">
              {visibleNav.find(n => n.route === route)?.unit}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {/* Información del Rol */}
            <span className="bg-[#161b22] border border-[#30363d] text-slate-400 rounded px-2.5 py-0.5 text-[10px]">
              {session.role === "instructor" ? "👨‍🏫 Docente" : "👩‍🔬 Estudiante"}
            </span>

            {/* Alertas */}
            {session.role === "instructor" && alerts > 0 && (
              <button
                onClick={() => { setRoute("dashboard"); setAlerts(0); }}
                className="relative bg-red-900/40 border border-red-800 text-red-400
                           rounded px-2 py-0.5 text-[10px] cursor-pointer"
              >
                ⚠ {alerts} alertas
              </button>
            )}

            {/* Cerrar Sesión */}
            <button
              onClick={() => {
                localStorage.removeItem("chromatox_session");
                setSession(null);
              }}
              className="bg-red-950/30 hover:bg-red-900/40 border border-red-900 text-red-400 hover:text-red-300
                         rounded px-2.5 py-0.5 text-[10px] cursor-pointer transition-colors"
            >
              🚪 Cerrar Sesión
            </button>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-3 bg-[#010409]">
          {renderContent()}
        </main>

        {/* Statusbar */}
        <footer className="flex items-center justify-between px-4 py-1 border-t border-[#21262d] bg-[#0d1117] shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="text-emerald-400 text-[9px]">Motor físico OK</span>
            </div>
            <span className="text-slate-800 text-[9px]">|</span>
            <span className="text-slate-700 text-[9px]">
              WebSocket: {
                wsStatus === "online" ? "En línea 🟢" :
                wsStatus === "connecting" ? "Conectando... 🟡" :
                "Desconectado 🔴"
              }
            </span>
            <span className="text-slate-800 text-[9px]">|</span>
            <span className="text-slate-700 text-[9px]">RAG: ChromaDB listo</span>
          </div>
          <span className="text-slate-800 text-[9px]">
            CHROMATOX·EDU v1.0 — UdeA QF 2026 — Caso {session.activeCase}
          </span>
        </footer>
      </div>
    </div>
  );
}

// ─── LOGIN & REGISTER SCREEN ──────────────────────────────────

function LoginScreen({ onLoginSuccess }: { onLoginSuccess: (session: AppSession) => void }) {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setMessage("");

    if (!username || !password) {
      setError("Por favor completa todos los campos obligatorios.");
      return;
    }

    if (!isLogin) {
      if (!fullName) {
        setError("Por favor ingresa tu nombre completo.");
        return;
      }
      if (password !== confirmPassword) {
        setError("Las contraseñas no coinciden.");
        return;
      }
    }

    setLoading(true);

    try {
      const endpoint = isLogin ? "/api/auth/login" : "/api/auth/register";
      const body = isLogin
        ? { username, password }
        : { username, password, full_name: fullName };

      const res = await fetch(`${BACKEND_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || "Ocurrió un error inesperado.");
        setLoading(false);
        return;
      }

      if (isLogin) {
        const userSession: AppSession = {
          sessionId: data.session_id,
          studentCode: data.student_code,
          fullName: data.full_name,
          role: data.role,
          activeCase: 1,
          activeUnit: data.active_unit,
        };
        localStorage.setItem("chromatox_session", JSON.stringify(userSession));
        onLoginSuccess(userSession);
      } else {
        setMessage(data.message || "Usuario registrado correctamente. Inicia sesión.");
        setIsLogin(true);
        setPassword("");
        setConfirmPassword("");
      }
    } catch (err) {
      setError("Error de red. Asegúrate de que el servidor esté en línea.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#010409] font-mono p-4 text-xs text-slate-300">
      <div className="w-full max-w-sm rounded-xl border border-[#21262d] bg-[#0d1117]/85 p-6 shadow-2xl backdrop-blur-md">
        
        {/* LOGO */}
        <div className="flex items-center justify-center gap-2 mb-6 text-center">
          <span className="text-emerald-400 text-base animate-pulse">●</span>
          <span className="text-slate-200 text-sm font-extrabold tracking-wider uppercase">CHROMATOX·EDU</span>
        </div>

        {/* TABS */}
        <div className="flex border-b border-[#21262d] mb-4">
          <button
            onClick={() => { setIsLogin(true); setError(""); setMessage(""); }}
            className={`flex-1 pb-2 text-center font-bold border-b-2 cursor-pointer transition-colors ${
              isLogin ? "border-purple-500 text-purple-400 font-bold" : "border-transparent text-slate-500"
            }`}
          >
            Iniciar Sesión
          </button>
          <button
            onClick={() => { setIsLogin(false); setError(""); setMessage(""); }}
            className={`flex-1 pb-2 text-center font-bold border-b-2 cursor-pointer transition-colors ${
              !isLogin ? "border-purple-500 text-purple-400 font-bold" : "border-transparent text-slate-500"
            }`}
          >
            Registrarse
          </button>
        </div>

        {/* FORM */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <div className="rounded-lg border border-red-800/40 bg-red-950/20 p-2.5 text-red-400">{error}</div>}
          {message && <div className="rounded-lg border border-emerald-800/40 bg-emerald-950/20 p-2.5 text-emerald-400">{message}</div>}

          <div>
            <label className="block text-slate-500 font-bold mb-1">
              {isLogin ? "Código de Usuario / Estudiante:" : "Código de Estudiante (ej. QF-2026-001):"}
            </label>
            <input
              type="text"
              required
              className="w-full rounded border border-[#30363d] bg-[#0d1117] px-2.5 py-1.5 text-slate-200 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder={isLogin ? "ej. estudiante o docente" : "ej. QF-2026-001"}
            />
          </div>

          {!isLogin && (
            <div>
              <label className="block text-slate-500 font-bold mb-1">Nombre Completo:</label>
              <input
                type="text"
                required
                className="w-full rounded border border-[#30363d] bg-[#0d1117] px-2.5 py-1.5 text-slate-200 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                value={fullName}
                onChange={e => setFullName(e.target.value)}
                placeholder="Nombre y Apellidos"
              />
            </div>
          )}

          <div>
            <label className="block text-slate-500 font-bold mb-1">Contraseña:</label>
            <input
              type="password"
              required
              className="w-full rounded border border-[#30363d] bg-[#0d1117] px-2.5 py-1.5 text-slate-200 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {!isLogin && (
            <div>
              <label className="block text-slate-500 font-bold mb-1">Confirmar Contraseña:</label>
              <input
                type="password"
                required
                className="w-full rounded border border-[#30363d] bg-[#0d1117] px-2.5 py-1.5 text-slate-200 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white font-bold py-2 cursor-pointer transition-colors"
          >
            {loading ? "Procesando..." : isLogin ? "Ingresar" : "Crear Cuenta"}
          </button>
        </form>

        {/* DEMO ACCREDITATIONS HELP */}
        {isLogin && (
          <div className="mt-6 border-t border-[#21262d] pt-4 text-[10px] text-slate-600 space-y-1 font-sans">
            <p className="font-bold">🔑 Cuentas por defecto para pruebas:</p>
            <p>• <strong>Profesor:</strong> docente / docente2026</p>
            <p>• <strong>Estudiante:</strong> estudiante / estudiante2026</p>
          </div>
        )}
      </div>
    </div>
  );
}
