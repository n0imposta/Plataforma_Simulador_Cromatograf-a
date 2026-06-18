/**
 * QuantitativeWorkspace.tsx
 *
 * Panel interactivo para la Unidad 6: Taller Cuantitativo.
 * El estudiante genera un caso de estándares USP aleatorios,
 * calcula la curva de calibración (m, b, R²), interpola la muestra problema
 * y calcula su incertidumbre estadística acumulada.
 */

import { useState, useMemo } from "react";
import { BACKEND_URL } from "../config";
import {
  ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine
} from "recharts";

interface QuantitativeWorkspaceProps {
  sessionId: string;
  studentCode: string;
  fullName: string;
  onActivityValidated: (score: number) => void;
}

interface CaseData {
  compound_name: string;
  concentrations: number[];
  areas: number[];
  unk_areas: number[];
}

export default function QuantitativeWorkspace({
  sessionId,
  studentCode,
  fullName,
  onActivityValidated
}: QuantitativeWorkspaceProps) {
  const [loading, setLoading] = useState(false);
  const [caseData, setCaseData] = useState<CaseData | null>(null);
  
  // Respuestas del estudiante
  const [inputs, setInputs] = useState({
    slope: "",
    intercept: "",
    r_squared: "",
    x_interpolated: "",
    uncertainty: "",
    justification: ""
  });

  const [validationResult, setValidationResult] = useState<any>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [timeSpent, setTimeSpent] = useState(0);

  // Timer local
  useState(() => {
    const t = setInterval(() => setTimeSpent(s => s + 1), 1000);
    return () => clearInterval(t);
  });

  const handleGenerateCase = async () => {
    setLoading(true);
    setErrorMessage("");
    setValidationResult(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/quantitative/generate-case`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          student_code: studentCode
        })
      });
      if (res.ok) {
        const data = await res.json();
        setCaseData(data);
      } else {
        setErrorMessage("Fallo al conectar con el motor de simulación cuantitativa.");
      }
    } catch (e) {
      setErrorMessage("Error de red. Asegúrate de tener el backend activo.");
    } finally {
      setLoading(false);
    }
  };

  const handleValidate = async () => {
    if (!caseData) return;
    setLoading(true);
    setErrorMessage("");
    try {
      const res = await fetch(`${BACKEND_URL}/api/quantitative/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          student_code: studentCode,
          full_name: fullName,
          compound_name: caseData.compound_name,
          slope: parseFloat(inputs.slope),
          intercept: parseFloat(inputs.intercept),
          r_squared: parseFloat(inputs.r_squared),
          x_interpolated: parseFloat(inputs.x_interpolated),
          uncertainty: parseFloat(inputs.uncertainty),
          justification: inputs.justification,
          time_spent_seconds: timeSpent
        })
      });
      if (res.ok) {
        const data = await res.json();
        setValidationResult(data);
        if (data.ok && data.score_final >= 3.0) {
          onActivityValidated(data.score_final);
        }
      } else {
        setErrorMessage("Error al validar el caso. Revisa que todos los campos sean números válidos.");
      }
    } catch (e) {
      setErrorMessage("Error de conexión al validar respuestas.");
    } finally {
      setLoading(false);
    }
  };

  const updateField = (field: keyof typeof inputs, val: string) => {
    setInputs(prev => ({ ...prev, [field]: val }));
  };

  // Datos para graficar la recta de calibración
  const chartData = useMemo(() => {
    if (!caseData) return { points: [], linePoints: [] };
    
    // Puntos estándares
    const points = caseData.concentrations.map((c, i) => ({
      x: c,
      y: caseData.areas[i],
      type: "Estándar"
    }));

    // Recta calculada por el alumno
    const m = parseFloat(inputs.slope);
    const b = parseFloat(inputs.intercept);
    
    const linePoints: any[] = [];
    if (!isNaN(m) && !isNaN(b)) {
      const minX = Math.min(...caseData.concentrations) * 0.8;
      const maxX = Math.max(...caseData.concentrations) * 1.2;
      linePoints.push({ x: minX, y: m * minX + b, type: "Recta Regresión" });
      linePoints.push({ x: maxX, y: m * maxX + b, type: "Recta Regresión" });
    }

    // Muestra problema interpolada
    const x_unk = parseFloat(inputs.x_interpolated);
    const y_unk = caseData.unk_areas.reduce((a, b) => a + b, 0) / caseData.unk_areas.length;
    if (!isNaN(x_unk)) {
      points.push({ x: x_unk, y: y_unk, type: "Muestra Lote" });
    }

    return { points, linePoints };
  }, [caseData, inputs.slope, inputs.intercept, inputs.x_interpolated]);

  const avgUnkArea = caseData ? caseData.unk_areas.reduce((sum, a) => sum + a, 0) / caseData.unk_areas.length : 0;

  const isMathValid = (field: string) => {
    if (!validationResult || !validationResult.math_errors) return true;
    return !validationResult.math_errors.some((err: string) => err.toLowerCase().includes(field));
  };

  return (
    <div className="bg-[#0d1117] text-slate-300 font-mono text-xs rounded-xl p-4 border border-[#21262d] space-y-4">
      
      {/* HEADER */}
      <div className="flex items-center justify-between border-b border-[#21262d] pb-3">
        <div className="flex items-center gap-2">
          <span className="text-purple-400 text-sm">● Unidad 6: Taller Cuantitativo USP</span>
          <span className="bg-[#161b22] border border-[#30363d] rounded px-2.5 py-0.5 text-slate-500 text-[10px]">
            Calibración Analítica y Regresión por Mínimos Cuadrados
          </span>
        </div>
        <button
          onClick={handleGenerateCase}
          disabled={loading}
          className="bg-purple-800 hover:bg-purple-700 disabled:opacity-40 text-white font-bold rounded-lg px-4 py-2 cursor-pointer transition-colors shadow"
        >
          {caseData ? "🔄 Re-inyectar Estándares" : "🧪 Inyectar Estándares USP"}
        </button>
      </div>

      {errorMessage && (
        <div className="bg-red-950/20 border border-red-900/60 rounded-lg p-2.5 text-red-400">
          ⚠️ {errorMessage}
        </div>
      )}

      {/* CASO NO INICIADO */}
      {!caseData ? (
        <div className="text-center py-12 bg-[#161b22] border border-[#21262d] rounded-xl space-y-4">
          <span className="text-5xl block">📊</span>
          <h3 className="text-slate-200 font-extrabold text-sm uppercase">Carga de Protocolo Cuantitativo</h3>
          <p className="text-slate-500 max-w-sm mx-auto leading-relaxed">
            Presiona el botón superior para simular la inyección automática de una serie de 5 estándares de calibración
            y 3 réplicas del lote problema del fármaco asignado aleatoriamente por la USP.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_310px] gap-4">
          
          {/* COLUMNA IZQUIERDA: DATOS Y CÁLCULOS */}
          <div className="space-y-4">
            
            {/* TABLAS DE INYECCIÓN */}
            <div className="grid grid-cols-2 gap-3">
              {/* Estándares */}
              <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3">
                <span className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1 block mb-2">
                  Estándares de Calibración ({caseData.compound_name})
                </span>
                <table className="w-full text-left font-mono">
                  <thead>
                    <tr className="text-slate-500 border-b border-[#21262d] text-[9px] uppercase">
                      <th className="py-1">Punto</th>
                      <th className="py-1 text-right">Conc (mg/L)</th>
                      <th className="py-1 text-right">Área (u.a.)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {caseData.concentrations.map((c, i) => (
                      <tr key={i} className="border-b border-[#1b2028] last:border-0 hover:bg-[#1d232e]/30">
                        <td className="py-1 text-slate-500">STD {i+1}</td>
                        <td className="py-1 text-right text-purple-400 font-bold">{c.toFixed(1)}</td>
                        <td className="py-1 text-right text-slate-300">{caseData.areas[i].toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Lote Problema */}
              <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 flex flex-col justify-between">
                <div>
                  <span className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1 block mb-2">
                    Lote Muestra Problema (Réplicas k=3)
                  </span>
                  <table className="w-full text-left font-mono mb-2">
                    <thead>
                      <tr className="text-slate-500 border-b border-[#21262d] text-[9px] uppercase">
                        <th className="py-1">Réplica</th>
                        <th className="py-1 text-right">Área Colectada (u.a.)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {caseData.unk_areas.map((area, i) => (
                        <tr key={i} className="border-b border-[#1b2028] last:border-0">
                          <td className="py-1 text-slate-500">Inyección {i+1}</td>
                          <td className="py-1 text-right text-slate-300">{area.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="bg-[#0d1117] border border-[#21262d] rounded-lg p-2 text-[10px] flex justify-between items-center">
                  <span className="text-slate-500">Área Promedio (y_unk):</span>
                  <span className="text-blue-400 font-extrabold">{avgUnkArea.toFixed(1)}</span>
                </div>
              </div>
            </div>

            {/* CALCULADORA DE REGRESIÓN */}
            <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-3">
              <span className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1 block">
                Resultados de Regresión Lineal por Mínimos Cuadrados
              </span>
              
              <div className="grid grid-cols-3 gap-3">
                {/* Slope */}
                <div className="space-y-1">
                  <label className="text-slate-500 text-[10px] flex justify-between">
                    <span>Pendiente (m):</span>
                    {!isMathValid("pendiente") && <span className="text-red-400 font-bold">✗</span>}
                  </label>
                  <input
                    type="number"
                    className={`w-full bg-[#0d1117] border rounded px-2.5 py-1.5 text-slate-300 outline-none ${
                      isMathValid("pendiente") ? "border-[#30363d] focus:border-purple-500" : "border-red-800 text-red-400"
                    }`}
                    value={inputs.slope}
                    onChange={e => updateField("slope", e.target.value)}
                    placeholder="Pendiente m..."
                  />
                </div>
                {/* Intercept */}
                <div className="space-y-1">
                  <label className="text-slate-500 text-[10px] flex justify-between">
                    <span>Intercepto (b):</span>
                    {!isMathValid("intercepto") && <span className="text-red-400 font-bold">✗</span>}
                  </label>
                  <input
                    type="number"
                    className={`w-full bg-[#0d1117] border rounded px-2.5 py-1.5 text-slate-300 outline-none ${
                      isMathValid("intercepto") ? "border-[#30363d] focus:border-purple-500" : "border-red-800 text-red-400"
                    }`}
                    value={inputs.intercept}
                    onChange={e => updateField("intercept", e.target.value)}
                    placeholder="Intercepto b..."
                  />
                </div>
                {/* R-squared */}
                <div className="space-y-1">
                  <label className="text-slate-500 text-[10px] flex justify-between">
                    <span>Coeficiente R²:</span>
                    {!isMathValid("r²") && <span className="text-red-400 font-bold">✗</span>}
                  </label>
                  <input
                    type="number"
                    step="0.00001"
                    className={`w-full bg-[#0d1117] border rounded px-2.5 py-1.5 text-slate-300 outline-none ${
                      isMathValid("r²") ? "border-[#30363d] focus:border-purple-500" : "border-red-800 text-red-400"
                    }`}
                    value={inputs.r_squared}
                    onChange={e => updateField("r_squared", e.target.value)}
                    placeholder="Linealidad R²..."
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-[#21262d]">
                {/* Interpolación */}
                <div className="space-y-1">
                  <label className="text-slate-500 text-[10px] flex justify-between">
                    <span>Conc Interpolada (mg/L):</span>
                    {!isMathValid("interpolada") && <span className="text-red-400 font-bold">✗</span>}
                  </label>
                  <input
                    type="number"
                    className={`w-full bg-[#0d1117] border rounded px-2.5 py-1.5 text-slate-300 outline-none ${
                      isMathValid("interpolada") ? "border-[#30363d] focus:border-purple-500" : "border-red-800 text-red-400"
                    }`}
                    value={inputs.x_interpolated}
                    onChange={e => updateField("x_interpolated", e.target.value)}
                    placeholder="Concentración interpolada..."
                  />
                </div>
                {/* Incertidumbre */}
                <div className="space-y-1">
                  <label className="text-slate-500 text-[10px] flex justify-between">
                    <span>Incertidumbre Abs (s_x):</span>
                    {!isMathValid("incertidumbre") && <span className="text-red-400 font-bold">✗</span>}
                  </label>
                  <input
                    type="number"
                    className={`w-full bg-[#0d1117] border rounded px-2.5 py-1.5 text-slate-300 outline-none ${
                      isMathValid("incertidumbre") ? "border-[#30363d] focus:border-purple-500" : "border-red-800 text-red-400"
                    }`}
                    value={inputs.uncertainty}
                    onChange={e => updateField("uncertainty", e.target.value)}
                    placeholder="Incertidumbre absoluta..."
                  />
                </div>
              </div>
            </div>

            {/* JUSTIFICACIÓN FÍSICO-QUÍMICA */}
            <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-2">
              <span className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1 block">
                Análisis de Idoneidad y Declaración de Integridad de Datos (USP 49)
              </span>
              <textarea
                className="w-full bg-[#0d1117] border border-[#30363d] focus:border-purple-500 rounded-xl p-3 text-slate-300 text-xs resize-none outline-none transition-colors"
                rows={4}
                value={inputs.justification}
                onChange={e => updateField("justification", e.target.value)}
                placeholder="Redacta la idoneidad analítica de la curva (R² >= 0.995) y discute si el lote analizado se encuentra dentro del rango de cuantificación lineal sin extrapolaciones..."
              />
              <div className="flex justify-between items-center text-[10px]">
                <span className="text-slate-500">Mínimo 30 caracteres | Actual: {inputs.justification.length}</span>
                <button
                  onClick={handleValidate}
                  disabled={loading || inputs.justification.length < 30 || !inputs.slope}
                  className="bg-purple-700 hover:bg-purple-600 border border-purple-500 text-white font-bold rounded-lg px-4 py-1.5 cursor-pointer disabled:opacity-40"
                >
                  {loading ? "Validando cálculos..." : "Validar e Informar"}
                </button>
              </div>
            </div>

          </div>

          {/* COLUMNA DERECHA: GRÁFICO E IDONEIDAD */}
          <div className="space-y-3">
            
            {/* GRÁFICO INTERACTIVO RECHAFTS */}
            <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 flex flex-col justify-between h-[210px]">
              <span className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1 block w-full mb-2">
                Recta de Regresión Estadística
              </span>
              <ResponsiveContainer width="100%" height={150}>
                <ScatterChart margin={{ top: 5, right: 10, left: -25, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                  <XAxis type="number" dataKey="x" stroke="#484f58" tick={{ fontSize: 8, fill: "#8b949e" }} name="Conc (mg/L)" />
                  <YAxis type="number" dataKey="y" stroke="#484f58" tick={{ fontSize: 8, fill: "#8b949e" }} name="Área (u.a.)" />
                  <Tooltip cursor={{ strokeDasharray: "3 3" }} contentStyle={{ background: "#0d1117", border: "1px solid #30363d", fontSize: 9 }} />
                  
                  {/* Puntos de estándares */}
                  <Scatter name="Estándares" data={chartData.points?.filter((p: any) => p.type === "Estándar")} fill="#a855f7" />
                  {/* Punto problema */}
                  <Scatter name="Muestra Lote" data={chartData.points?.filter((p: any) => p.type === "Muestra Lote")} fill="#f87171" />
                  
                  {/* Línea de regresión */}
                  {chartData.linePoints?.length > 0 && (
                    <Scatter name="Recta" data={chartData.linePoints} line={{ stroke: "#a855f7", strokeWidth: 1.5 }} shape={() => <div />} />
                  )}
                  
                  {/* Interpolación */}
                  {!isNaN(parseFloat(inputs.x_interpolated)) && (
                    <ReferenceLine x={parseFloat(inputs.x_interpolated)} stroke="#f87171" strokeDasharray="3 3" />
                  )}
                </ScatterChart>
              </ResponsiveContainer>
            </div>

            {/* CHECKLIST DE IDONEIDAD USP 49 */}
            <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-2">
              <span className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1 block">
                Idoneidad Cuantitativa USP 49
              </span>
              <div className="space-y-1.5 text-[10px]">
                <div className="flex justify-between items-center border-b border-[#1b2028] pb-1">
                  <span className="text-slate-500">Linealidad Curva (R² ≥ 0.995):</span>
                  {parseFloat(inputs.r_squared) >= 0.995 ? (
                    <span className="text-emerald-400 font-bold">Cumple (R²={parseFloat(inputs.r_squared).toFixed(5)})</span>
                  ) : (
                    <span className="text-red-400">No cumple</span>
                  )}
                </div>
                <div className="flex justify-between items-center border-b border-[#1b2028] pb-1">
                  <span className="text-slate-500">Rango (Sin extrapolación):</span>
                  {caseData && parseFloat(inputs.x_interpolated) >= caseData.concentrations[0] &&
                   parseFloat(inputs.x_interpolated) <= caseData.concentrations[caseData.concentrations.length - 1] ? (
                    <span className="text-emerald-400 font-bold">Interpolación Lineal ✓</span>
                  ) : (
                    <span className="text-red-400">Extrapolación ✗</span>
                  )}
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Incertidumbre Relativa (≤ 5%):</span>
                  {caseData && (parseFloat(inputs.uncertainty) / (parseFloat(inputs.x_interpolated) || 1.0)) * 100 <= 5.0 ? (
                    <span className="text-emerald-400 font-bold">Alta Precisión ({(parseFloat(inputs.uncertainty) / (parseFloat(inputs.x_interpolated) || 1.0) * 100).toFixed(2)}%)</span>
                  ) : (
                    <span className="text-red-400">Alta Dispersión</span>
                  )}
                </div>
              </div>
            </div>

            {/* RESULTADO DE LA VALIDACIÓN */}
            {validationResult && (
              <div className={`border rounded-xl p-3 space-y-2 animate-fadeIn ${
                validationResult.score_final >= 3.0 ? "bg-emerald-950/20 border-emerald-800" : "bg-red-950/20 border-red-800"
              }`}>
                <div className="flex justify-between items-center border-b border-white/10 pb-1">
                  <span className="font-bold">Resultado de Validación</span>
                  <span className={`font-extrabold text-sm ${validationResult.score_final >= 3.0 ? "text-emerald-400" : "text-red-400"}`}>
                    {validationResult.score_final.toFixed(2)} / 5.00
                  </span>
                </div>
                <p className="text-[10px] text-slate-300 leading-relaxed font-sans">
                  {validationResult.feedback}
                </p>
                {validationResult.score_final < 3.0 && (
                  <p className="text-[9px] text-red-400 italic">
                    * Revisa tus fórmulas estadísticas y vuelve a validar.
                  </p>
                )}
              </div>
            )}

          </div>

        </div>
      )}

    </div>
  );
}
