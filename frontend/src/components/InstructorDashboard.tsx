/**
 * InstructorDashboard.tsx
 *
 * Panel de control docente (Instructor Dashboard).
 * Integra:
 *   - Supervisión en Vivo de Estudiantes mediante WebSockets.
 *   - Control HITL Gate manual (Bloquear/Desbloquear mandos de estudiantes).
 *   - Envío de tutoría en vivo personalizada.
 *   - Rúbrica cualitativa para evaluar la defensa oral del examen final.
 *   - Mapa de Calor de Errores y planilla consolidada de notas.
 */

import { useState, useEffect, useRef } from "react";

interface HeatmapData {
  overpressure: number;
  poor_resolution: number;
  high_tailing: number;
  temp_violation: number;
  solvent_mismatch: number;
  total_submissions: number;
}

interface OmittedConcept {
  concept: string;
  count: number;
}

interface StudentGrade {
  student_code: string;
  full_name: string;
  act1_grade: number | null;
  act2_grade: number | null;
  act3_grade: number | null;
  act4_grade: number | null;
  act5_grade: number | null;
  act6_grade: number | null;
  final_exam_grade: number | null;
  final_exam_comments: string | null;
  final_exam_rubric: {
    matrix_effect?: number;
    data_integrity?: number;
    defense?: number;
  } | null;
  final_grade: number;
}

interface ActiveSession {
  session_id: string;
  student_code: string;
  full_name: string;
  route: string;
  status: "ACTIVE" | "LOCKED" | "BLOWOUT" | "COMPLETED";
  time_left: number;
  active_unit: number;
  timestamp: number;
  metrics: {
    pressure_mpa?: number;
    pressure_kpa?: number;
    rs?: number;
    plates?: number;
    flow?: number;
    org_pct?: number;
    temp?: number;
    carrier?: string;
    compound?: string;
    math_score?: number;
    semantic_score?: number;
  };
}

export default function InstructorDashboard() {
  const [activeTab, setActiveTab] = useState<"supervision" | "grades" | "heatmap">("supervision");
  const [heatmap, setHeatmap] = useState<HeatmapData>({
    overpressure: 8,
    poor_resolution: 14,
    high_tailing: 19,
    temp_violation: 3,
    solvent_mismatch: 6,
    total_submissions: 50
  });
  const [omittedConcepts, setOmittedConcepts] = useState<OmittedConcept[]>([
    { concept: "ecuación de darcy", count: 12 },
    { concept: "resolución usp 49", count: 9 },
    { concept: "diámetro de partícula", count: 8 },
    { concept: "viscosidad fase móvil", count: 7 }
  ]);
  const [grades, setGrades] = useState<StudentGrade[]>([]);
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [dbMode, setDbMode] = useState<"live" | "mock">("mock");

  // Estados del modal de rúbrica
  const [selectedStudent, setSelectedStudent] = useState<StudentGrade | null>(null);
  const [rubric, setRubric] = useState({
    matrix_effect: 4.0,
    data_integrity: 4.0,
    defense: 4.0,
    comments: ""
  });

  // Mensajes rápidos del tutor
  const [customMessages, setCustomMessages] = useState<Record<string, string>>({});

  const wsRef = useRef<WebSocket | null>(null);

  // Cargar datos estáticos e iniciales
  const fetchGradesAndHeatmap = async () => {
    try {
      const heatmapRes = await fetch("http://localhost:8000/api/telemetry/errors-heatmap");
      const gradesRes = await fetch("http://localhost:8000/api/telemetry/grades");
      
      if (heatmapRes.ok && gradesRes.ok) {
        const heatmapData = await heatmapRes.json();
        const gradesData = await gradesRes.json();
        
        if (heatmapData.ok) {
          setHeatmap(heatmapData.heatmap);
          setOmittedConcepts(heatmapData.frequent_omitted_concepts);
        }
        if (gradesData) {
          setGrades(gradesData);
          setDbMode("live");
        }
      }
    } catch (e) {
      console.log("Conexión al backend fallida, operando en modo simulación.");
      setDbMode("mock");
      // Fallback Mock Data
      setGrades([
        { student_code: "QF-2026-001", full_name: "Alejandro Bedoya", act1_grade: 4.5, act2_grade: 4.8, act3_grade: 3.5, act4_grade: 4.0, act5_grade: 4.2, act6_grade: 4.0, final_exam_grade: 4.2, final_exam_comments: "Excelente defensa de Van Deemter.", final_exam_rubric: { matrix_effect: 4.2, data_integrity: 4.0, defense: 4.4 }, final_grade: 4.21 },
        { student_code: "QF-2026-012", full_name: "Mariana Restrepo", act1_grade: 3.8, act2_grade: 4.0, act3_grade: 2.8, act4_grade: 3.5, act5_grade: 4.1, act6_grade: 4.0, final_exam_grade: 3.8, final_exam_comments: "Respuestas directas pero completas.", final_exam_rubric: { matrix_effect: 3.8, data_integrity: 3.5, defense: 4.1 }, final_grade: 3.76 },
        { student_code: "QF-2026-024", full_name: "Santiago Gómez", act1_grade: 4.0, act2_grade: 3.5, act3_grade: 4.2, act4_grade: 1.5, act5_grade: 3.0, act6_grade: 3.5, final_exam_grade: null, final_exam_comments: null, final_exam_rubric: null, final_grade: 1.04 }
      ]);
    }
  };

  useEffect(() => {
    fetchGradesAndHeatmap();

    // Iniciar conexión WebSocket docente en vivo
    const connectWs = () => {
      const wsUrl = "ws://localhost:8000/api/telemetry/ws/instructor";
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "ACTIVE_SESSIONS") {
          setActiveSessions(data.sessions);
        } else if (data.type === "STUDENT_UPDATE") {
          // Reemplazar o añadir estudiante
          setActiveSessions(prev => {
            const idx = prev.findIndex(s => s.session_id === data.session_id);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = data;
              return updated;
            } else {
              return [...prev, data];
            }
          });
        } else if (data.type === "GRADE_OVERRIDE_CONFIRM") {
          // Actualizar planilla
          fetchGradesAndHeatmap();
        }
      };

      ws.onclose = () => {
        setTimeout(connectWs, 5000); // Reintentar
      };
    };

    connectWs();

    return () => {
      wsRef.current?.close();
    };
  }, []);

  const sendCommand = (type: "LOCK" | "UNLOCK" | "SEND_FEEDBACK", session_id: string, extra = {}) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type,
        session_id,
        ...extra
      }));
      // Actualizar localmente el status de la sesión
      if (type === "LOCK" || type === "UNLOCK") {
        setActiveSessions(prev =>
          prev.map(s => s.session_id === session_id ? { ...s, status: type === "LOCK" ? "LOCKED" : "ACTIVE" } : s)
        );
      }
    }
  };

  const handleOpenRubric = (student: StudentGrade) => {
    setSelectedStudent(student);
    setRubric({
      matrix_effect: student.final_exam_rubric?.matrix_effect ?? 4.0,
      data_integrity: student.final_exam_rubric?.data_integrity ?? 4.0,
      defense: student.final_exam_rubric?.defense ?? 4.0,
      comments: student.final_exam_comments ?? ""
    });
  };

  const handleSaveRubric = async () => {
    if (!selectedStudent) return;
    
    const finalScore = parseFloat(((rubric.matrix_effect + rubric.data_integrity + rubric.defense) / 3.0).toFixed(2));

    try {
      const res = await fetch("http://localhost:8000/api/telemetry/final-exam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          student_code: selectedStudent.student_code,
          score: finalScore,
          comments: rubric.comments,
          rubric_matrix_effect: rubric.matrix_effect,
          rubric_data_integrity: rubric.data_integrity,
          rubric_defense: rubric.defense
        })
      });
      if (res.ok) {
        fetchGradesAndHeatmap();
        setSelectedStudent(null);
      } else {
        alert("Error al registrar rúbrica en base de datos.");
      }
    } catch (e) {
      // Fallback local en modo mock
      setGrades(prev =>
        prev.map(s => s.student_code === selectedStudent.student_code ? {
          ...s,
          final_exam_grade: finalScore,
          final_exam_comments: rubric.comments,
          final_exam_rubric: {
            matrix_effect: rubric.matrix_effect,
            data_integrity: rubric.data_integrity,
            defense: rubric.defense
          },
          final_grade: parseFloat((s.final_grade - (s.final_exam_grade ?? 0)*0.6 + finalScore*0.6).toFixed(2))
        } : s)
      );
      setSelectedStudent(null);
    }
  };

  const getHeatmapColor = (count: number) => {
    if (count > 15) return "bg-red-950/80 border-red-500 text-red-400";
    if (count > 8) return "bg-amber-950/80 border-amber-500 text-amber-400";
    if (count > 0) return "bg-blue-950/80 border-blue-500 text-blue-400";
    return "bg-slate-900 border-slate-800 text-slate-500";
  };

  const getGradeStyle = (grade: number | null) => {
    if (grade === null) return "text-slate-600 font-bold";
    if (grade < 3.0) return "text-red-400 font-bold bg-red-950/20 px-1 rounded";
    return "text-emerald-400 font-bold";
  };

  const activeTabStyle = (tab: typeof activeTab) =>
    `px-4 py-2 text-xs font-mono font-bold rounded-lg border cursor-pointer transition-colors ${
      activeTab === tab
        ? "bg-[#21262d] border-[#30363d] text-purple-400 shadow-md"
        : "border-transparent text-slate-500 hover:text-slate-300 hover:bg-[#161b22]"
    }`;

  return (
    <div className="bg-[#0d1117] text-slate-300 font-mono text-xs rounded-xl p-4 border border-[#21262d] space-y-4">
      
      {/* HEADER */}
      <div className="flex items-center justify-between border-b border-[#21262d] pb-3">
        <div className="flex items-center gap-2">
          <span className="text-blue-400 text-sm">👨‍🏫 Panel Docente de Administración</span>
          <span className="bg-[#161b22] border border-[#30363d] rounded px-2.5 py-0.5 text-slate-500 text-[10px]">
            Supervisión In Vivo y Gobernanza Híbrida 2026
          </span>
          <span className="text-[10px] text-slate-600 font-sans">
            Base: {dbMode === "live" ? "🟢 SQLite/PostgreSQL Activo" : "🟡 Datos de Demostración"}
          </span>
        </div>
        <div className="flex gap-2">
          <button className={activeTabStyle("supervision")} onClick={() => setActiveTab("supervision")}>📡 Supervisión en Vivo ({activeSessions.length})</button>
          <button className={activeTabStyle("grades")} onClick={() => setActiveTab("grades")}>📋 Calificaciones Ponderadas</button>
          <button className={activeTabStyle("heatmap")} onClick={() => setActiveTab("heatmap")}>🔥 Mapa de Calor y RAG</button>
        </div>
      </div>

      {/* TAB: SUPERVISIÓN EN VIVO */}
      {activeTab === "supervision" && (
        <div className="space-y-4 animate-fadeIn">
          {activeSessions.length === 0 ? (
            <div className="text-center py-12 bg-[#161b22] border border-[#21262d] rounded-xl space-y-2">
              <span className="text-4xl block">📡</span>
              <p className="text-slate-400 font-bold">No hay estudiantes activos en simuladores en este momento.</p>
              <p className="text-slate-600 max-w-sm mx-auto leading-relaxed">
                Cuando los estudiantes abran su simulador (HPLC, UHPLC o GC) y comiencen a correr inyecciones,
                aparecerán en este panel en menos de 100 ms.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4">
              {activeSessions.map((s, idx) => (
                <div key={idx} className={`bg-[#161b22] border rounded-xl p-3 flex flex-col justify-between transition-all hover:scale-[1.01] ${
                  s.status === "BLOWOUT" ? "border-red-600 bg-red-950/10 shadow-lg shadow-red-950/20" : 
                  s.status === "LOCKED" ? "border-amber-600 bg-amber-950/5" : "border-[#21262d]"
                }`}>
                  {/* Student Title */}
                  <div className="flex justify-between items-start border-b border-[#21262d] pb-2 mb-2">
                    <div>
                      <h4 className="text-slate-200 font-bold text-xs uppercase">{s.full_name}</h4>
                      <p className="text-[9px] text-slate-600 font-mono mt-0.5">{s.student_code}</p>
                    </div>
                    <span className={`text-[9px] font-bold rounded px-1.5 py-0.5 uppercase tracking-wider ${
                      s.status === "BLOWOUT" ? "bg-red-800 text-white animate-pulse" :
                      s.status === "LOCKED" ? "bg-amber-600 text-black" : "bg-emerald-950/60 text-emerald-400"
                    }`}>
                      {s.status}
                    </span>
                  </div>

                  {/* Student Metrics */}
                  <div className="space-y-1.5 py-1 text-[10px] flex-1">
                    <div className="flex justify-between">
                      <span className="text-slate-600">Simulador Activo:</span>
                      <span className="text-purple-400 font-bold uppercase">{s.route} (U{s.active_unit})</span>
                    </div>

                    {s.route === "spe" ? (
                      <>
                        <div className="flex justify-between">
                          <span className="text-slate-600">Rec. Ibuprofeno:</span>
                          <span className="text-slate-300 font-bold">{(s.metrics.rec_b ?? 0).toFixed(1)}%</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-600">Pureza Colectada:</span>
                          <span className="text-slate-300 font-bold">{(s.metrics.pur_b ?? 0).toFixed(1)}%</span>
                        </div>
                      </>
                    ) : s.route === "quantitative" ? (
                      <>
                        <div className="flex justify-between">
                          <span className="text-slate-600">Fármaco USP:</span>
                          <span className="text-slate-300 font-bold">{s.metrics.compound}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-600">Linealidad R²:</span>
                          <span className="text-slate-300 font-bold">{s.metrics.r_squared}</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex justify-between">
                          <span className="text-slate-600">Presión actual:</span>
                          <span className={`${s.status === "BLOWOUT" ? "text-red-400 font-extrabold animate-pulse" : "text-slate-300"}`}>
                            {s.metrics.pressure_mpa ? `${s.metrics.pressure_mpa.toFixed(1)} MPa` : (s.metrics.pressure_kpa ? `${s.metrics.pressure_kpa.toFixed(0)} kPa` : "—")}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-600">Resolución (Rs):</span>
                          <span className="text-slate-300">{(s.metrics.rs ?? 0).toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-600">Platos (N):</span>
                          <span className="text-slate-300">{(s.metrics.plates ?? 0).toLocaleString()}</span>
                        </div>
                      </>
                    )}
                  </div>

                  {/* HITL Controls */}
                  <div className="pt-2 border-t border-[#21262d] mt-2 space-y-2">
                    {/* Chat rápido */}
                    <div className="flex gap-1">
                      <input
                        type="text"
                        placeholder="Enviar sugerencia rápida..."
                        className="flex-1 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-slate-300 text-[10px] outline-none"
                        value={customMessages[s.session_id] ?? ""}
                        onChange={e => setCustomMessages(prev => ({ ...prev, [s.session_id]: e.target.value }))}
                      />
                      <button
                        onClick={() => {
                          sendCommand("SEND_FEEDBACK", s.session_id, { feedback: customMessages[s.session_id] });
                          setCustomMessages(prev => ({ ...prev, [s.session_id]: "" }));
                        }}
                        className="bg-purple-950 hover:bg-purple-900 border border-purple-800 rounded px-2.5 text-purple-400 font-bold cursor-pointer"
                      >
                        Enviar
                      </button>
                    </div>

                    {/* Botones de bloqueo */}
                    <div className="flex gap-2">
                      {s.status === "LOCKED" ? (
                        <button
                          onClick={() => sendCommand("UNLOCK", s.session_id)}
                          className="flex-1 bg-emerald-950 hover:bg-emerald-900 border border-emerald-800 text-emerald-400 rounded py-1.5 text-[10px] font-bold cursor-pointer"
                        >
                          🔓 Desbloquear Mandos
                        </button>
                      ) : (
                        <button
                          onClick={() => sendCommand("LOCK", s.session_id)}
                          className="flex-1 bg-amber-950 hover:bg-amber-900 border border-amber-800 text-amber-400 rounded py-1.5 text-[10px] font-bold cursor-pointer"
                        >
                          🔒 Bloquear Mandos
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB: CALIFICACIONES PONDERADAS */}
      {activeTab === "grades" && (
        <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-3 animate-fadeIn">
          <span className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1 block">
            Planilla de Notas Consolidadas (Microcurrículo Ponderado)
          </span>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono border-collapse text-[10px]">
              <thead>
                <tr className="border-b border-[#30363d] text-slate-500 uppercase">
                  <th className="py-2">Código</th>
                  <th className="py-2">Nombre Completo</th>
                  <th className="py-2 text-center">Act 1 (6%)</th>
                  <th className="py-2 text-center">Act 2 (6%)</th>
                  <th className="py-2 text-center">Act 3 (7%)</th>
                  <th className="py-2 text-center">Act 4 (7%)</th>
                  <th className="py-2 text-center">Act 5 (7%)</th>
                  <th className="py-2 text-center">Act 6 (7%)</th>
                  <th className="py-2 text-center">Examen (60%)</th>
                  <th className="py-2 text-center bg-purple-950/20 text-purple-400 font-bold">Ponderado</th>
                  <th className="py-2 text-right">Rúbrica</th>
                </tr>
              </thead>
              <tbody>
                {grades.map((s, idx) => (
                  <tr key={idx} className="border-b border-[#1b2028] hover:bg-[#1d232e]/30">
                    <td className="py-2 font-bold text-slate-400">{s.student_code}</td>
                    <td className="py-2 text-slate-200">{s.full_name}</td>
                    <td className="py-2 text-center">{s.act1_grade !== null ? <span className={getGradeStyle(s.act1_grade)}>{s.act1_grade.toFixed(1)}</span> : "—"}</td>
                    <td className="py-2 text-center">{s.act2_grade !== null ? <span className={getGradeStyle(s.act2_grade)}>{s.act2_grade.toFixed(1)}</span> : "—"}</td>
                    <td className="py-2 text-center">{s.act3_grade !== null ? <span className={getGradeStyle(s.act3_grade)}>{s.act3_grade.toFixed(1)}</span> : "—"}</td>
                    <td className="py-2 text-center">{s.act4_grade !== null ? <span className={getGradeStyle(s.act4_grade)}>{s.act4_grade.toFixed(1)}</span> : "—"}</td>
                    <td className="py-2 text-center">{s.act5_grade !== null ? <span className={getGradeStyle(s.act5_grade)}>{s.act5_grade.toFixed(1)}</span> : "—"}</td>
                    <td className="py-2 text-center">{s.act6_grade !== null ? <span className={getGradeStyle(s.act6_grade)}>{s.act6_grade.toFixed(1)}</span> : "—"}</td>
                    <td className="py-2 text-center">
                      {s.final_exam_grade !== null ? (
                        <span className={getGradeStyle(s.final_exam_grade)} title={s.final_exam_comments ?? ""}>
                          {s.final_exam_grade.toFixed(2)}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="py-2 text-center bg-purple-950/10 text-purple-300 font-extrabold border-l border-r border-[#21262d]">
                      {s.final_grade.toFixed(2)}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => handleOpenRubric(s)}
                        className="bg-[#21262d] border border-[#30363d] hover:border-purple-500 text-slate-400 hover:text-purple-400 font-bold px-2 py-0.5 rounded text-[9px] cursor-pointer"
                      >
                        Evaluar Oral 🎤
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB: CALOR Y RAG */}
      {activeTab === "heatmap" && (
        <div className="grid grid-cols-[1fr_310px] gap-4 animate-fadeIn">
          
          {/* MAPA DE CALOR */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-3">
            <span className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1 block">
              Mapa de Calor de Errores Instrumentales Acumulados
            </span>
            
            <div className="grid grid-cols-5 gap-3 pt-1">
              <div className={`border rounded-lg p-2.5 text-center flex flex-col items-center justify-center ${getHeatmapColor(heatmap.overpressure)}`}>
                <span className="text-xl">💥</span>
                <span className="text-[9px] uppercase font-bold tracking-wider mt-1.5 leading-none">Sobrepresión</span>
                <span className="text-base font-extrabold mt-1">{heatmap.overpressure}</span>
              </div>
              <div className={`border rounded-lg p-2.5 text-center flex flex-col items-center justify-center ${getHeatmapColor(heatmap.poor_resolution)}`}>
                <span className="text-xl">📊</span>
                <span className="text-[9px] uppercase font-bold tracking-wider mt-1.5 leading-none">Rs &lt; 1.50</span>
                <span className="text-base font-extrabold mt-1">{heatmap.poor_resolution}</span>
              </div>
              <div className={`border rounded-lg p-2.5 text-center flex flex-col items-center justify-center ${getHeatmapColor(heatmap.high_tailing)}`}>
                <span className="text-xl">📐</span>
                <span className="text-[9px] uppercase font-bold tracking-wider mt-1.5 leading-none">T (Cola) &gt; 2.0</span>
                <span className="text-base font-extrabold mt-1">{heatmap.high_tailing}</span>
              </div>
              <div className={`border rounded-lg p-2.5 text-center flex flex-col items-center justify-center ${getHeatmapColor(heatmap.temp_violation)}`}>
                <span className="text-xl">🌡️</span>
                <span className="text-[9px] uppercase font-bold tracking-wider mt-1.5 leading-none">T Horno Max</span>
                <span className="text-base font-extrabold mt-1">{heatmap.temp_violation}</span>
              </div>
              <div className={`border rounded-lg p-2.5 text-center flex flex-col items-center justify-center ${getHeatmapColor(heatmap.solvent_mismatch)}`}>
                <span className="text-xl">🧪</span>
                <span className="text-[9px] uppercase font-bold tracking-wider mt-1.5 leading-none">Solvente Err</span>
                <span className="text-base font-extrabold mt-1">{heatmap.solvent_mismatch}</span>
              </div>
            </div>
            <p className="text-[9px] text-slate-500 font-sans leading-relaxed">
              * El mapa de calor indica la frecuencia acumulada con la que los estudiantes cometen errores estructurales hidráulicos (Darcy) o de idoneidad (USP 49) en sus sesiones de simulación.
            </p>
          </div>

          {/* DEFICIENCIAS CONCEPTUALES */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-2">
            <span className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1 block">
              Deficiencias Conceptuales (Omitidos RAG)
            </span>
            <div className="space-y-1.5 max-h-36 overflow-y-auto">
              {omittedConcepts.length === 0 ? (
                <p className="text-emerald-500 text-[10px]">No se detectan conceptos omitidos en el grupo.</p>
              ) : (
                omittedConcepts.map((item, idx) => (
                  <div key={idx} className="flex justify-between border-b border-[#1b2028] pb-1 last:border-0">
                    <span className="text-slate-400 capitalize">{item.concept}</span>
                    <span className="text-red-400 font-bold">Omitido {item.count} veces</span>
                  </div>
                ))
              )}
            </div>
          </div>

        </div>
      )}

      {/* MODAL DE RÚBRICA CUALITATIVA DE DEFENSA ORAL */}
      {selectedStudent && (
        <div className="fixed inset-0 bg-[#000]/70 backdrop-blur-sm z-[110] flex items-center justify-center p-4">
          <div className="bg-[#161b22] border-2 border-purple-500 rounded-xl p-4 w-full max-w-md space-y-4 shadow-2xl font-mono text-xs">
            <div className="flex justify-between items-center border-b border-purple-500 pb-2">
              <span className="text-purple-400 font-extrabold uppercase text-[11px]">Rúbrica Cualitativa Oral — Examen Final</span>
              <button onClick={() => setSelectedStudent(null)} className="text-slate-500 hover:text-white font-bold text-sm cursor-pointer">×</button>
            </div>

            <p className="text-slate-400">
              Evaluando defensa oral de: <strong className="text-white">{selectedStudent.full_name} ({selectedStudent.student_code})</strong>
            </p>

            <div className="space-y-3">
              {/* Criterio 1 */}
              <div className="space-y-1">
                <div className="flex justify-between">
                  <label className="text-slate-500 font-bold">1. Comprensión de Efecto Matriz:</label>
                  <span className="text-purple-400 font-bold">{rubric.matrix_effect.toFixed(1)}</span>
                </div>
                <input
                  type="range" min="1.0" max="5.0" step="0.1"
                  className="w-full accent-purple-500"
                  value={rubric.matrix_effect}
                  onChange={e => setRubric(r => ({ ...r, matrix_effect: parseFloat(e.target.value) }))}
                />
              </div>

              {/* Criterio 2 */}
              <div className="space-y-1">
                <div className="flex justify-between">
                  <label className="text-slate-500 font-bold">2. Integridad de Datos Cromatográficos:</label>
                  <span className="text-purple-400 font-bold">{rubric.data_integrity.toFixed(1)}</span>
                </div>
                <input
                  type="range" min="1.0" max="5.0" step="0.1"
                  className="w-full accent-purple-500"
                  value={rubric.data_integrity}
                  onChange={e => setRubric(r => ({ ...r, data_integrity: parseFloat(e.target.value) }))}
                />
              </div>

              {/* Criterio 3 */}
              <div className="space-y-1">
                <div className="flex justify-between">
                  <label className="text-slate-500 font-bold">3. Defensa de Van Deemter / Golay:</label>
                  <span className="text-purple-400 font-bold">{rubric.defense.toFixed(1)}</span>
                </div>
                <input
                  type="range" min="1.0" max="5.0" step="0.1"
                  className="w-full accent-purple-500"
                  value={rubric.defense}
                  onChange={e => setRubric(r => ({ ...r, defense: parseFloat(e.target.value) }))}
                />
              </div>

              {/* Comentarios */}
              <div className="space-y-1">
                <label className="text-slate-500 font-bold">Observaciones cualitativas de la defensa oral:</label>
                <textarea
                  className="w-full bg-[#0d1117] border border-[#30363d] focus:border-purple-500 rounded p-2 text-slate-300 text-xs resize-none outline-none"
                  rows={3}
                  value={rubric.comments}
                  onChange={e => setRubric(r => ({ ...r, comments: e.target.value }))}
                  placeholder="Escribe comentarios sobre la asimilación del estudiante o posibles dudas de autoría..."
                />
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setSelectedStudent(null)}
                className="flex-1 bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] text-slate-400 rounded py-2 font-bold cursor-pointer"
              >
                Cancelar
              </button>
              <button
                onClick={handleSaveRubric}
                className="flex-1 bg-purple-700 hover:bg-purple-600 border border-purple-500 text-white rounded py-2 font-bold cursor-pointer"
              >
                Guardar Calificación
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
