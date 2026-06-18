/**
 * OnlineSessionManager.tsx
 *
 * Administrador del tiempo de actividades y compuerta de evaluación semántica.
 * Estructura del examen (60 minutos en total):
 *   - Fase 1: Simulación Física (40 minutos)
 *     El alumno interactúa libremente con los parámetros e intenta resolver el caso.
 *   - Fase 2: Bloqueo de Simulación e Informe Técnico (20 minutos)
 *     Los controles se bloquean y el alumno redacta su justificación analítica.
 *   - Evaluación Semántica HITL:
 *     Envía el informe a la API para calificar con LLM (Claude) o coincidencia de conceptos.
 */

import { useState, useEffect } from "react";
import { BACKEND_URL } from "../config";

interface OnlineSessionManagerProps {
  sessionId: string;
  studentCode: string;
  fullName: string;
  activityNumber: number;
  currentSimScore: number;
  telemetryData: any;
  onActivityValidated: (finalScore: number) => void;
}

export default function OnlineSessionManager({
  sessionId,
  studentCode,
  fullName,
  activityNumber,
  currentSimScore,
  telemetryData,
  onActivityValidated
}: OnlineSessionManagerProps) {
  // Tiempos en segundos: 40 min simulación, 20 min justificación (total 60 min)
  const TOTAL_TIME = 60 * 60; // 3600s
  const SIM_PHASE_DURATION = 40 * 60; // 2400s

  const [timeLeft, setTimeLeft] = useState(TOTAL_TIME);
  const [phase, setPhase] = useState<"simulation" | "justification" | "completed">("simulation");
  const [justificationText, setJustificationText] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string>("");
  const [gradeResult, setGradeResult] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);

  const fetchHistory = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/telemetry/history/${studentCode}/${activityNumber}`);
      if (res.ok) {
        const data = await res.json();
        setHistory(data);
        
        // Sincronizar el número de intentos realizados
        if (data.length > 0) {
          setAttempts(data.length);
          // Si ya aprobó en algún intento anterior, marcar como completado
          const approvedAttempt = data.find((h: any) => h.score >= 3.0);
          if (approvedAttempt) {
            setPhase("completed");
            setGradeResult({
              score_final: approvedAttempt.score,
              score_sim: approvedAttempt.telemetry_data?.score_sim || 0,
              score_semantic: approvedAttempt.telemetry_data?.score_semantic || 0
            });
            setFeedback(approvedAttempt.semantic_feedback);
          }
        }
      }
    } catch (e) {
      console.log("Error al cargar el historial:", e);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, [studentCode, activityNumber]);

  // Timer
  useEffect(() => {
    if (timeLeft <= 0) {
      if (phase === "simulation") {
        setPhase("justification");
        setTimeLeft(20 * 60); // Iniciar los 20 min de informe
      } else if (phase === "justification") {
        handleSubmitReport(); // Auto-enviar si expira el tiempo
      }
      return;
    }

    const t = setInterval(() => {
      setTimeLeft(prev => {
        const next = prev - 1;
        // Transicionar a justificación si pasa de los 40 min
        if (phase === "simulation" && (TOTAL_TIME - next) >= SIM_PHASE_DURATION) {
          setPhase("justification");
          return 20 * 60; // Configurar a 20 min
        }
        return next;
      });
    }, 1000);

    return () => clearInterval(t);
  }, [timeLeft, phase]);

  const forceSwitchToJustification = () => {
    setPhase("justification");
    setTimeLeft(20 * 60);
  };

  const handleSubmitReport = async () => {
    if (justificationText.trim().length < 30) {
      setFeedback("⚠️ Justificación muy corta (mínimo 30 caracteres para evaluación semántica).");
      return;
    }

    setLoading(true);
    setFeedback("");
    
    try {
      const res = await fetch(`${BACKEND_URL}/api/telemetry/activity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          student_code: studentCode,
          full_name: fullName,
          activity_number: activityNumber,
          score_sim: currentSimScore,
          justification: justificationText,
          time_spent_seconds: TOTAL_TIME - timeLeft,
          telemetry_data: {
            ...telemetryData,
            attempts: attempts + 1
          }
        })
      });

      if (res.ok) {
        const data = await res.json();
        setGradeResult(data);
        setFeedback(data.feedback);
        fetchHistory(); // Esto actualizará el historial e incrementará attempts automáticamente

        if (data.score_final >= 3.0) {
          setPhase("completed");
          onActivityValidated(data.score_final);
        } else if (attempts >= 2) {
          setFeedback(
            "❌ Has agotado los 3 intentos. Se registrará tu calificación más alta, " +
            "y se requiere intervención del instructor para desbloquear el módulo."
          );
        }
      } else {
        setFeedback("⚠️ Error al conectar con el servidor de evaluación.");
      }
    } catch (e) {
      setFeedback("⚠️ Error de red. Fallback evaluativo local activado.");
      // Simular evaluación local
      const kw = ["darcy", "resolución", "presión", "viscosidad", "fase móvil", "hetp", "velocidad", "platos", "knox", "partícula"];
      const found = kw.filter(k => justificationText.toLowerCase().includes(k));
      const score = 1.0 + (found.length / kw.length) * 4.0;
      const final_score = (currentSimScore + score) / 2.0;

      setGradeResult({
        score_sim: currentSimScore,
        score_semantic: score,
        score_final: final_score,
      });

      if (final_score >= 3.0) {
        setPhase("completed");
        onActivityValidated(final_score);
      } else {
        setFeedback("⚠️ Justificación técnica deficiente. Revisa el uso de términos físico-químicos.");
      }
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  return (
    <div className="bg-[#0f111a] border border-[#21262d] rounded-xl p-4 space-y-4 shadow-xl">
      
      {/* HEADER BANNER */}
      <div className="flex items-center justify-between border-b border-[#21262d] pb-3">
        <div className="flex items-center gap-3">
          <span className="text-xl">⏱️</span>
          <div>
            <h3 className="text-slate-200 font-extrabold text-sm uppercase tracking-wide">
              Actividad Evaluada #{activityNumber} — Sesión Híbrida UdeA/USS
            </h3>
            <p className="text-[10px] text-slate-500">Estudiante: {fullName} ({studentCode})</p>
          </div>
        </div>

        {/* TIMER */}
        <div className="flex flex-col items-end">
          <span className={`text-xl font-mono font-extrabold tracking-wider ${timeLeft < 300 ? "text-red-400 animate-pulse" : "text-amber-400"}`}>
            {formatTime(timeLeft)}
          </span>
          <span className="text-[8px] uppercase text-slate-600 font-bold tracking-widest mt-0.5">
            {phase === "simulation" ? "Fase 1: Simulación Física" : "Fase 2: Redacción de Informe"}
          </span>
        </div>
      </div>

      {/* PHASE CONTROLLERS */}
      {phase === "simulation" && (
        <div className="bg-[#18110b] border border-amber-900/40 rounded-xl p-3 flex justify-between items-center">
          <div className="space-y-1">
            <p className="text-amber-500 font-bold text-[11px]">🔬 Etapa Práctica Activa</p>
            <p className="text-[10px] text-slate-400 leading-relaxed max-w-md">
              Ajusta los sliders del cromatógrafo para lograr una separación analítica óptima (Rs ≥ 1.50). 
              Cuando consideres tener la mejor separación, puedes finalizar la fase práctica y pasar a redactar el informe técnico.
            </p>
          </div>
          <button
            onClick={forceSwitchToJustification}
            className="bg-amber-600 hover:bg-amber-500 border border-amber-700 text-black font-bold rounded-lg px-4 py-2 cursor-pointer transition-colors shadow"
          >
            Finalizar Simulación e Informar ➜
          </button>
        </div>
      )}

      {phase === "justification" && (
        <div className="space-y-3 animate-fadeIn">
          <div className="bg-[#13111f] border border-purple-900/40 rounded-xl p-3">
            <p className="text-purple-400 font-bold text-[11px]">✍️ Fase de Justificación Técnica Bloqueada</p>
            <p className="text-[10px] text-slate-400 leading-relaxed">
              Los mandos de simulación física han sido bloqueados. 
              Por favor, redacta el fundamento físico-químico del método optimizado. 
              Explica cómo lograste la resolución ideal o resolviste la contrapresión citando los modelos de <strong>Darcy, Knox y la polaridad química</strong>.
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-slate-500 font-mono">
              <span>Informe Analítico:</span>
              <span>Mínimo 30 caracteres | Actual: {justificationText.length}</span>
            </div>
            <textarea
              disabled={loading || attempts >= 3}
              value={justificationText}
              onChange={e => setJustificationText(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] focus:border-purple-500 rounded-xl p-3 text-slate-300 text-xs font-mono resize-none outline-none transition-colors"
              rows={5}
              placeholder="Justifica aquí tu diseño de método físico-químico..."
            />
          </div>

          {feedback && (
            <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-2.5 text-[10px] text-slate-300 leading-relaxed">
              {feedback}
            </div>
          )}

          {gradeResult && (
            <div className="bg-[#1c1d24] border border-[#30363d] rounded-xl p-3 grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-slate-500 text-[9px] uppercase">Nota Simulador</p>
                <p className="text-white text-base font-extrabold">{gradeResult.score_sim?.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-slate-500 text-[9px] uppercase">Nota Semántica</p>
                <p className="text-white text-base font-extrabold">{gradeResult.score_semantic?.toFixed(2)}</p>
              </div>
              <div className="bg-purple-950/20 border border-purple-800/40 rounded-lg py-1">
                <p className="text-purple-400 text-[9px] uppercase font-bold">Calificación Final</p>
                <p className="text-purple-300 text-base font-extrabold">{gradeResult.score_final?.toFixed(2)}</p>
              </div>
            </div>
          )}

          <div className="flex justify-between items-center pt-2">
            <span className="text-[10px] text-slate-500 font-bold font-mono">Intento {attempts} de 3</span>
            <button
              onClick={handleSubmitReport}
              disabled={loading || justificationText.trim().length < 30 || attempts >= 3}
              className="bg-purple-700 hover:bg-purple-600 disabled:opacity-40 border border-purple-500 text-white font-bold rounded-lg px-5 py-2 cursor-pointer transition-colors shadow-lg"
            >
              {loading ? "Evaluando con Claude..." : "Enviar Informe Técnico"}
            </button>
          </div>
        </div>
      )}

      {phase === "completed" && (
        <div className="bg-emerald-950/30 border border-emerald-800 rounded-xl p-6 text-center space-y-4 animate-scaleUp">
          <span className="text-5xl">🏆</span>
          <h2 className="text-emerald-400 text-lg font-extrabold uppercase tracking-wide">
            ¡Actividad #{activityNumber} Completada con Éxito!
          </h2>
          <p className="text-slate-300 text-xs font-mono max-w-md mx-auto leading-relaxed">
            Tu informe ha sido evaluado y validado semánticamente. Has logrado una nota final consolidada de:
            <strong className="block text-emerald-400 text-2xl font-extrabold mt-1 font-mono">{gradeResult?.score_final?.toFixed(2)} / 5.00</strong>
          </p>
          <div className="text-[10px] text-slate-500 italic bg-[#0d1117] border border-[#21262d] rounded-lg p-2 max-w-sm mx-auto leading-relaxed">
            "{feedback}"
          </div>
        </div>
      )}

      {/* HISTORIAL DE INTENTOS */}
      {history.length > 0 && (
        <div className="border-t border-[#21262d] pt-4 mt-4 space-y-2">
          <p className="text-[10px] uppercase text-slate-500 font-bold tracking-wider">📜 Historial de Intentos anteriores</p>
          <div className="space-y-2.5 max-h-52 overflow-y-auto pr-1">
            {history.map((h, i) => (
              <div key={h.id || i} className="bg-[#161b22]/50 border border-[#21262d] rounded-xl p-3 space-y-2 text-[10px] font-mono leading-relaxed transition-all hover:border-purple-900/50">
                <div className="flex justify-between items-center border-b border-[#21262d]/50 pb-1.5 text-slate-400">
                  <span>Intento #{history.length - i} — {new Date(h.created_at).toLocaleString("es-ES")}</span>
                  <span className={`font-bold px-1.5 py-0.5 rounded text-[9px] ${
                    h.score >= 3.0 ? "bg-emerald-950/60 text-emerald-400" : "bg-red-950/60 text-red-400"
                  }`}>
                    Nota Final: {h.score.toFixed(2)}
                  </span>
                </div>
                <div className="space-y-1">
                  <p className="text-slate-500 italic"><span className="text-slate-400 font-bold not-italic">Justificación:</span> "{h.justification}"</p>
                  <p className="text-purple-400"><span className="text-slate-400 font-bold">Feedback del Tutor:</span> "{h.semantic_feedback}"</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
