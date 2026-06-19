/**
 * HPLCSimulatorPanel.tsx
 *
 * Panel completo de simulación física y termodinámica para HPLC y UHPLC.
 * Diseñado bajo estética de laboratorio oscuro (premium).
 * Incorpora:
 *   - Darcy & Knox para cálculo de presión y eficiencia HETP.
 *   - Simulación de cromatograma con asimetría USP en tiempo real.
 *   - Límite de seguridad ChroZen UHPLC a 130 MPa con advertencias catastróficas.
 *   - Conexión vía WebSocket con backend y API de consulta RAG.
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { BACKEND_URL, WS_BACKEND_URL } from "../config";
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

// ─── TIPOS ───────────────────────────────────────────────────

type SolventType = "ACN" | "MeOH";
type SorbentChemistry = "C18" | "C8" | "Cyano";

interface HPLCState {
  columnKey: string;
  mobilePhaseSolvent: SolventType;
  organicModifierPct: number;
  flowRateMlMin: number;
  ovenTempC: number;
  analyteMixture?: string;
}

interface HPLCPeak {
  analyte_name: string;
  retention_time_min: number;
  retention_factor_k: number;
  peak_width_min: number;
  peak_width_half_min: number;
  tailing_factor_usp: number;
  height_signal: number;
  area_signal: number;
}

interface HPLCMetrics {
  linear_velocity_u_mm_s: number;
  viscosity_cp: number;
  backpressure_mpa: number;
  backpressure_bar: number;
  pressure_ok: boolean;
  temperature_ok: boolean;
  reduced_velocity_nu: number;
  reduced_hetp_h: number;
  hetp_mm: number;
  n_plates: number;
  rs: number;
  peak_a: HPLCPeak;
  peak_b: HPLCPeak;
  warnings: string[];
  errors: string[];
}

interface ChromPoint {
  t: number;
  signal: number;
  peak_a: number;
  peak_b: number;
}

// ─── CATÁLOGOS INLINE ─────────────────────────────────────────

const HPLC_COLUMNS = [
  { key: "C18_250mm_5um",   label: "C18 250mm × 4.6mm, 5µm (Estándar)",      L: 250, dc: 4.6, dp: 5.0, maxP: 40, chem: "C18" },
  { key: "C18_150mm_3.5um", label: "C18 150mm × 4.6mm, 3.5µm (Eficiencia)",   L: 150, dc: 4.6, dp: 3.5, maxP: 40, chem: "C18" },
  { key: "C18_50mm_1.7um",  label: "C18 50mm × 2.1mm, 1.7µm (ChroZen UHPLC)", L: 50,  dc: 2.1, dp: 1.7, maxP: 130, chem: "C18" },
  { key: "C8_150mm_3.5um",  label: "C8 150mm × 4.6mm, 3.5µm (Medio)",        L: 150, dc: 4.6, dp: 3.5, maxP: 40, chem: "C8" },
  { key: "Cyano_150mm_5um", label: "Cyano 150mm × 4.6mm, 5µm (Polar)",       L: 150, dc: 4.6, dp: 5.0, maxP: 40, chem: "Cyano" }
];

const SOLVENT_INFO: Record<SolventType, { label: string; color: string; desc: string }> = {
  ACN: { label: "Acetonitrilo (ACN)", color: "#c084fc", desc: "Solvente aprótico, baja viscosidad y alta fuerza eluyente." },
  MeOH: { label: "Metanol (MeOH)", color: "#38bdf8", desc: "Solvente prótico, mayor viscosidad mezcla, elución más lenta." }
};

const ANALYTE_MIXTURES: Record<string, { analyte_a: string; analyte_b: string; ACN: { k_w_A: number; S_A: number; k_w_B: number; S_B: number }; MeOH: { k_w_A: number; S_A: number; k_w_B: number; S_B: number } }> = {
  "Paracetamol + Ibuprofeno": {
    analyte_a: "Paracetamol", analyte_b: "Ibuprofeno",
    ACN: { k_w_A: 12.0, S_A: 2.6, k_w_B: 45.0, S_B: 3.1 },
    MeOH: { k_w_A: 16.0, S_A: 1.9, k_w_B: 65.0, S_B: 2.4 }
  },
  "Cafeína + Loratadina": {
    analyte_a: "Cafeína", analyte_b: "Loratadina",
    ACN: { k_w_A: 8.0, S_A: 2.3, k_w_B: 85.0, S_B: 3.5 },
    MeOH: { k_w_A: 11.0, S_A: 1.7, k_w_B: 110.0, S_B: 2.8 }
  },
  "Ácido Acetilsalicílico + Naproxeno": {
    analyte_a: "Ácido Acetilsalicílico", analyte_b: "Naproxeno",
    ACN: { k_w_A: 15.0, S_A: 2.8, k_w_B: 35.0, S_B: 2.9 },
    MeOH: { k_w_A: 20.0, S_A: 2.1, k_w_B: 50.0, S_B: 2.2 }
  },
  "Ranitidina + Omeprazol": {
    analyte_a: "Ranitidina", analyte_b: "Omeprazol",
    ACN: { k_w_A: 6.0, S_A: 2.2, k_w_B: 28.0, S_B: 2.7 },
    MeOH: { k_w_A: 9.0, S_A: 1.6, k_w_B: 40.0, S_B: 2.1 }
  }
};

const HPLC_INITIAL: HPLCState = {
  columnKey: "C18_150mm_3.5um",
  mobilePhaseSolvent: "ACN",
  organicModifierPct: 55.0,
  flowRateMlMin: 1.0,
  ovenTempC: 30.0,
  analyteMixture: "Paracetamol + Ibuprofeno"
};

// ─── MOTOR LOCAL FALLBACK HPLC ────────────────────────────────
// Implementa exactamente el mismo modelo matemático del backend en el cliente
// para asegurar responsividad instantánea en caso de microcortes del WebSocket.

function localHPLCSimulation(s: HPLCState): HPLCMetrics {
  const col = HPLC_COLUMNS.find(c => c.key === s.columnKey)!;
  const C = s.organicModifierPct / 100.0;
  
  // Viscosidad mezcla a 25C
  const eta_water = 0.89;
  const eta_org = s.mobilePhaseSolvent === "ACN" ? 0.34 : 0.54;
  const k_mix = s.mobilePhaseSolvent === "ACN" ? 0.60 : 3.20;
  const eta_25 = eta_water * (1 - C) + eta_org * C + k_mix * C * (1 - C);
  const eta = eta_25 * Math.exp(-0.018 * (s.ovenTempC - 25.0));

  // Velocidad lineal u (mm/s)
  const r = col.dc / 2.0;
  const area = Math.PI * (r ** 2);
  const F_mm3 = (s.flowRateMlMin * 1000.0) / 60.0;
  const u = Math.max(F_mm3 / (area * 0.65), 0.01);

  // Darcy ΔP
  const pressure_mpa = (1000.0 * eta * col.L * u) / (1000.0 * (col.dp ** 2));
  const pressure_bar = pressure_mpa * 10.0;

  // Difusión Stokes-Einstein
  const Dm = 1.0e-3 * ((s.ovenTempC + 273.15) / 298.15) * (0.89 / eta);
  const dp_mm = col.dp * 1e-3;
  const nu = (u * dp_mm) / Dm;

  // Knox
  const A_knox = 1.2, B_knox = 1.8, C_knox = 0.08;
  const h = A_knox * Math.pow(nu, 1/3) + B_knox / nu + C_knox * nu;
  const hetp = h * dp_mm;
  const N = Math.max(Math.floor(col.L / hetp), 50);

  // Retención
  const mult = { C18: 1.0, C8: 0.75, Cyano: 0.45 }[col.chem as SorbentChemistry] || 1.0;
  const mixKey = s.analyteMixture || "Paracetamol + Ibuprofeno";
  const mix = ANALYTE_MIXTURES[mixKey] || ANALYTE_MIXTURES["Paracetamol + Ibuprofeno"];
  const analyte_a_name = mix.analyte_a;
  const analyte_b_name = mix.analyte_b;
  const solvData = mix[s.mobilePhaseSolvent];
  
  const k_w_A = solvData.k_w_A;
  const S_A = solvData.S_A;
  const k_w_B = solvData.k_w_B;
  const S_B = solvData.S_B;

  const k_A = k_w_A * mult * Math.pow(10, -S_A * C);
  const k_B = k_w_B * mult * Math.pow(10, -S_B * C);

  // Tiempos
  const dead_vol = (area * col.L * 0.65) / 1000.0;
  const tM = dead_vol / s.flowRateMlMin;
  const t_R_A = tM * (1 + k_A);
  const t_R_B = tM * (1 + k_B);

  // Tailing USP
  const u_opt = Math.sqrt(B_knox / C_knox) * (Dm / dp_mm);
  const u_ratio = u > u_opt ? u / u_opt : u_opt / u;
  const t_usp_a = Math.max(1.0, 1.05 + 0.05 * (u_ratio - 1));
  const t_usp_b = Math.max(1.0, 1.20 + 0.12 * (u_ratio - 1) + 0.15 * (1.0 - C));

  // Anchos
  const sigma_a = t_R_A / Math.sqrt(N);
  const sigma_b = t_R_B / Math.sqrt(N);
  const w_a = 4.0 * sigma_a;
  const w_b = 4.0 * sigma_b;
  const rs = (t_R_B - t_R_A) / (2.0 * (sigma_a + sigma_b));

  const warnings: string[] = [];
  const errors: string[] = [];

  const is_uhplc = col.dp < 2.0;
  let pressure_ok = true;
  let temperature_ok = true;

  if (is_uhplc) {
    temperature_ok = s.ovenTempC <= 60.0;
    if (!temperature_ok) {
      errors.push(`¡ERROR DE TEMPERATURA CRÍTICA! La temperatura del horno (${s.ovenTempC}°C) excede los 60°C permitidos para la técnica UHPLC.`);
    }
  } else {
    temperature_ok = s.ovenTempC <= 45.0;
    if (!temperature_ok) {
      errors.push(`¡ERROR DE TEMPERATURA CRÍTICA! La temperatura del horno (${s.ovenTempC}°C) excede los 45°C permitidos para la técnica HPLC estándar.`);
    }
  }

  if (is_uhplc) {
    pressure_ok = pressure_mpa <= 130.0;
    if (!pressure_ok) {
      errors.push(`¡ERROR DE PRESIÓN CRÍTICA! La contrapresión de ${pressure_bar.toFixed(1)} bar excede el límite estructural de UHPLC (1300 bar). Peligro de daño físico.`);
    } else if (pressure_bar > 1000.0) {
      warnings.push(`¡ADVERTENCIA DE PRESIÓN CRÍTICA! La contrapresión de ${pressure_bar.toFixed(1)} bar supera el límite de operación normal (1000 bar) de UHPLC.`);
    }
  } else {
    pressure_ok = pressure_mpa <= 40.0;
    if (!pressure_ok) {
      errors.push(`¡ERROR DE PRESIÓN CRÍTICA! La contrapresión de ${pressure_bar.toFixed(1)} bar excede los 400 bar permitidos para HPLC estándar. Flujo interrumpido.`);
    }
  }

  if (rs < 1.50) {
    warnings.push(`Rs = ${rs.toFixed(2)} — Baja resolución (USP exige Rs ≥ 1.50).`);
  }
  if (t_usp_b > 2.0) {
    warnings.push(`Tailing B = ${t_usp_b.toFixed(2)} — Deformación severa (USP exige T ≤ 2.0).`);
  }
  if (pressure_mpa > col.maxP * 0.85 && pressure_ok) {
    warnings.push(`Aviso hidráulico: Presión al 85% de la resistencia física de la columna.`);
  }

  return {
    linear_velocity_u_mm_s: u,
    viscosity_cp: eta,
    backpressure_mpa: pressure_mpa,
    backpressure_bar: pressure_bar,
    pressure_ok,
    temperature_ok,
    reduced_velocity_nu: nu,
    reduced_hetp_h: h,
    hetp_mm: hetp,
    n_plates: N,
    rs,
    peak_a: {
      analyte_name: analyte_a_name,
      retention_time_min: t_R_A,
      retention_factor_k: k_A,
      peak_width_min: w_a,
      peak_width_half_min: 2.355 * sigma_a,
      tailing_factor_usp: t_usp_a,
      height_signal: 0.90,
      area_signal: 10.0
    },
    peak_b: {
      analyte_name: analyte_b_name,
      retention_time_min: t_R_B,
      retention_factor_k: k_B,
      peak_width_min: w_b,
      peak_width_half_min: 2.355 * sigma_b,
      tailing_factor_usp: t_usp_b,
      height_signal: 1.10,
      area_signal: 15.0
    },
    warnings,
    errors
  };
}

function buildLocalChromatogram(m: HPLCMetrics): ChromPoint[] {
  const pa = m.peak_a;
  const pb = m.peak_b;
  const t_end = pb.retention_time_min * 1.5;
  const n = 160;
  
  const sig_a_l = pa.peak_width_min / 4.0;
  const sig_a_r = sig_a_l * (2.0 * pa.tailing_factor_usp - 1.0);

  const sig_b_l = pb.peak_width_min / 4.0;
  const sig_b_r = sig_b_l * (2.0 * pb.tailing_factor_usp - 1.0);

  return Array.from({ length: n }, (_, i) => {
    const t = (t_end * i) / (n - 1);
    
    // Peak A
    const ya = t <= pa.retention_time_min
      ? pa.height_signal * Math.exp(-0.5 * Math.pow((t - pa.retention_time_min) / sig_a_l, 2))
      : pa.height_signal * Math.exp(-0.5 * Math.pow((t - pa.retention_time_min) / sig_a_r, 2));

    // Peak B
    const yb = t <= pb.retention_time_min
      ? pb.height_signal * Math.exp(-0.5 * Math.pow((t - pb.retention_time_min) / sig_b_l, 2))
      : pb.height_signal * Math.exp(-0.5 * Math.pow((t - pb.retention_time_min) / sig_b_r, 2));

    return {
      t: parseFloat(t.toFixed(3)),
      signal: parseFloat((ya + yb).toFixed(5)),
      peak_a: parseFloat(ya.toFixed(5)),
      peak_b: parseFloat(yb.toFixed(5))
    };
  });
}

function localVanDeemterCurve(s: HPLCState): any[] {
  const col = HPLC_COLUMNS.find(c => c.key === s.columnKey)!;
  const C = s.organicModifierPct / 100.0;
  const eta_water = 0.89;
  const eta_org = s.mobilePhaseSolvent === "ACN" ? 0.34 : 0.54;
  const k_mix = s.mobilePhaseSolvent === "ACN" ? 0.60 : 3.20;
  const eta_25 = eta_water * (1 - C) + eta_org * C + k_mix * C * (1 - C);
  const eta = eta_25 * Math.exp(-0.018 * (s.ovenTempC - 25.0));
  const Dm = 1.0e-3 * ((s.ovenTempC + 273.15) / 298.15) * (0.89 / eta);
  const dp_mm = col.dp * 1e-3;

  const A = 1.2, B = 1.8, C_coef = 0.08;
  const u_opt = Math.sqrt(B / C_coef) * (Dm / dp_mm);

  return Array.from({ length: 80 }, (_, i) => {
    const u = 0.1 + (8.0 - 0.1) * (i / 79);
    const nu = (u * dp_mm) / Dm;
    const h = A * Math.pow(nu, 1/3) + B / nu + C_coef * nu;
    const hetp = h * dp_mm;
    return {
      u_mm_s: u,
      hetp_total_mm: hetp,
      A_contribution: A * Math.pow(nu, 1/3) * dp_mm,
      B_contribution: (B / nu) * dp_mm,
      C_contribution: (C_coef * nu) * dp_mm,
      u_optimal_mm_s: u_opt,
      is_optimal: Math.abs(u - u_opt) < 0.1
    };
  });
}

// ─── COMPONENTE METRICBOX ─────────────────────────────────────

function MetricBox({ label, value, unit, status }: { label: string; value: string; unit?: string; status: "ok" | "warn" | "bad" | "neutral" }) {
  const borderClr = {
    ok: "border-emerald-800 text-emerald-400 bg-emerald-950/20",
    warn: "border-amber-800 text-amber-400 bg-amber-950/20",
    bad: "border-red-800 text-red-400 bg-red-950/20",
    neutral: "border-slate-800 text-slate-300 bg-slate-900/50"
  }[status];

  return (
    <div className={`flex flex-col items-center border rounded-lg p-2 transition-all hover:scale-[1.02] ${borderClr}`}>
      <span className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">{label}</span>
      <span className="text-lg font-extrabold font-mono mt-0.5">{value}</span>
      {unit && <span className="text-[9px] text-slate-400 mt-0.5">{unit}</span>}
    </div>
  );
}

// ─── PANTALLA DE EXPLOSIÓN HIDRÁULICA ──────────────────────────

function BlowoutOverlay({ pressure, onReset }: { pressure: number; onReset: () => void }) {
  return (
    <div className="absolute inset-0 bg-red-950/95 border-2 border-red-500 rounded-xl z-50 flex flex-col items-center justify-center p-8 text-center animate-pulse">
      <span className="text-8xl mb-6">💥</span>
      <h2 className="text-red-500 text-2xl font-extrabold tracking-wider uppercase mb-2">
        ¡SOBREPRESIÓN CRÍTICA: ESTALLIDO HIDRÁULICO!
      </h2>
      <p className="text-red-300 font-mono text-sm max-w-lg mb-6 leading-relaxed">
        La contrapresión del sistema alcanzó los <strong className="text-white text-lg">{pressure.toFixed(1)} MPa</strong> (1300+ bar), 
        superando el límite hidráulico del equipo <strong>ChroZen UHPLC</strong>. 
        Los sellos de zafiro se han fisurado y se detectan fugas de fase móvil en el inyector.
      </p>
      <div className="bg-[#110101] border border-red-800 rounded px-4 py-3 text-left font-mono text-xs max-w-md mb-6 space-y-2">
        <p className="text-red-400">💡 <strong>Consejo del Tutor RAG (Darcy):</strong></p>
        <p className="text-slate-400">
          Revisa la Ecuación de Darcy: la presión es proporcional a la longitud (L) y velocidad lineal (u), 
          pero aumenta de forma cuadrática al reducir el tamaño de partícula ($d_p^2$).
          Para usar partículas de 1.7 µm en UHPLC, debes reducir el caudal o utilizar fases móviles de menor viscosidad (como Acetonitrilo).
        </p>
      </div>
      <button
        onClick={onReset}
        className="bg-red-700 hover:bg-red-600 border border-red-500 text-white font-bold rounded-lg px-6 py-2.5 cursor-pointer transition-colors shadow-lg"
      >
        Reemplazar sellos y Reiniciar Flujo
      </button>
    </div>
  );
}

// ─── MAIN COMPONENT ──────────────────────────────────────────

export default function HPLCSimulatorPanel({
  sessionId,
  caseNumber = 1,
  onGateValidated: _onGateValidated,
  onSimulationUpdate
}: {
  sessionId: string;
  caseNumber?: number;
  onGateValidated?: (gateNum: number) => void;
  onSimulationUpdate?: (metrics: any) => void;
}) {
  const [state, setState] = useState<HPLCState>(HPLC_INITIAL);
  const [metrics, setMetrics] = useState<HPLCMetrics>(() => localHPLCSimulation(HPLC_INITIAL));
  const [chrom, setChrom] = useState<ChromPoint[]>([]);
  const [activeTab, setActiveTab] = useState<"instrument" | "vandeemter" | "rag_tutor">("instrument");
  const [elapsed, setElapsed] = useState(0);
  const [simCount, setSimCount] = useState(0);
  
  // RAG feedback cache
  const [ragFeedback, setRagFeedback] = useState<string>("");
  const [showRagPopup, setShowRagPopup] = useState<boolean>(false);
  const [showBlowout, setShowBlowout] = useState(false);
  const [wsStatus, setWsStatus] = useState<"connected" | "disconnected" | "connecting">("connecting");

  // Timer para la sesión
  useEffect(() => {
    const t = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Simulación y WebSocket
  useEffect(() => {
    // 1. Simulación física local instantánea
    const m = localHPLCSimulation(state);
    setMetrics(m);
    setChrom(buildLocalChromatogram(m));
    setSimCount(c => c + 1);
    onSimulationUpdate?.(m);

    if (m.backpressure_mpa > 130.0) {
      setShowBlowout(true);
    }

    // 2. Intentar comunicar con WebSocket
    const wsUrl = `${WS_BACKEND_URL}/api/hplc/ws/${sessionId}`;
    let ws: WebSocket | null = null;
    
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        setWsStatus("connected");
        ws?.send(JSON.stringify({
          type: "HPLC_RUN",
          params: {
            column_key: state.columnKey,
            mobile_phase_solvent: state.mobilePhaseSolvent,
            organic_modifier_pct: state.organicModifierPct,
            flow_rate_ml_min: state.flowRateMlMin,
            oven_temp_c: state.ovenTempC,
            analyte_mixture: state.analyteMixture || "Paracetamol + Ibuprofeno"
          }
        }));
      };
      
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "HPLC_RESULT") {
          // El backend confirma el cálculo físico
          // Si el WebSocket responde, sincronizamos el cálculo
          setMetrics(data.result);
          setChrom(data.chromatogram);
          onSimulationUpdate?.(data.result);
        } else if (data.type === "PRESSURE_BLOWOUT") {
          setShowBlowout(true);
        }
      };

      ws.onerror = () => setWsStatus("disconnected");
      ws.onclose = () => setWsStatus("disconnected");
    } catch (e) {
      setWsStatus("disconnected");
    }

    return () => {
      ws?.close();
    };
  }, [state, sessionId]);

  // Consulta asíncrona de Feedback RAG si hay advertencias
  const fetchRAGFeedback = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/telemetry/rag-feedback/${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.ok && data.data) {
          setRagFeedback(data.data.feedback);
          setShowRagPopup(true);
          setActiveTab("rag_tutor");
        }
      }
    } catch (e) {
      console.log("Error consultando RAG feedback:", e);
    }
  }, [sessionId]);

  // Consultar RAG periódicamente si hay advertencias activas
  useEffect(() => {
    if (metrics.warnings.length > 0) {
      const interval = setInterval(fetchRAGFeedback, 3000);
      return () => clearInterval(interval);
    } else {
      setRagFeedback("");
    }
  }, [metrics.warnings, fetchRAGFeedback]);

  const updateState = useCallback((patch: Partial<HPLCState>) => {
    setState(prev => ({ ...prev, ...patch }));
  }, []);

  const handleResetBlowout = () => {
    setShowBlowout(false);
    updateState({
      flowRateMlMin: 0.8,
      organicModifierPct: 60.0,
      columnKey: "C18_150mm_3.5um" // Cambiar a columna menos restrictiva
    });
  };

  const colInfo = HPLC_COLUMNS.find(c => c.key === state.columnKey)!;
  const solventInfo = SOLVENT_INFO[state.mobilePhaseSolvent];

  const pressureStatus = metrics.backpressure_mpa > colInfo.maxP ? "bad" : metrics.backpressure_mpa > colInfo.maxP * 0.85 ? "warn" : "ok";
  const rsStatus = metrics.rs >= 1.50 ? "ok" : metrics.rs >= 1.0 ? "warn" : "bad";
  
  const vandeemterPoints = useMemo(() => localVanDeemterCurve(state), [state]);

  const activeTabStyle = (tab: typeof activeTab) =>
    `px-4 py-2 text-xs font-mono font-bold rounded-lg border cursor-pointer transition-colors ${
      activeTab === tab
        ? "bg-[#21262d] border-[#30363d] text-purple-400 shadow-md"
        : "border-transparent text-slate-500 hover:text-slate-300 hover:bg-[#161b22]"
    }`;

  return (
    <div className="relative bg-[#0d1117] text-slate-300 font-mono text-xs rounded-xl p-4 border border-[#21262d] overflow-hidden min-h-[500px]">
      
      {/* OVERLAY DE EXPLOSIÓN HIDRÁULICA */}
      {showBlowout && (
        <BlowoutOverlay pressure={metrics.backpressure_mpa} onReset={handleResetBlowout} />
      )}

      {/* TOPBAR */}
      <div className="flex items-center justify-between border-b border-[#21262d] pb-3 mb-4">
        <div className="flex items-center gap-2">
          <span className="text-purple-400 text-sm">● HPLC/UHPLC Simulator</span>
          <span className="bg-[#161b22] border border-[#30363d] rounded px-2.5 py-0.5 text-slate-500 text-[10px]">
            {caseNumber === 1 ? "Unidad 3: Fase Reversa" : "Unidad 4: UHPLC vs HPLC"}
          </span>
          <span className="bg-[#161b22] border border-[#30363d] rounded px-2.5 py-0.5 text-[10px]"
            style={{ color: solventInfo.color, borderColor: solventInfo.color }}>
            {solventInfo.label.split(" ")[0]}
          </span>
          <span className="text-[10px] text-slate-600 font-sans">
            WS: {wsStatus === "connected" ? "🟢 En línea" : "🟡 Modo Local Fallback"}
          </span>
        </div>
        <div className="flex gap-3 items-center">
          <span className="text-amber-500 font-bold">⏱ {String(Math.floor(elapsed/60)).padStart(2,"0")}:{String(elapsed%60).padStart(2,"0")}</span>
          <span className="text-slate-600 text-[10px]">Run #{simCount}</span>
        </div>
      </div>

      {/* FILA DE MÉTRICAS */}
      <div className="grid grid-cols-5 gap-3 mb-4">
        <MetricBox label="Presión (Darcy)" value={`${metrics.backpressure_mpa.toFixed(1)} MPa`} unit={`${metrics.backpressure_bar.toFixed(0)} bar`} status={pressureStatus} />
        <MetricBox label="Resolución (Rs)" value={metrics.rs.toFixed(2)} unit="mín: 1.50" status={rsStatus} />
        <MetricBox label="N (Platos)" value={metrics.n_plates.toLocaleString()} unit="Eficiencia N" status={metrics.n_plates > 10000 ? "ok" : "warn"} />
        <MetricBox label="Viscosidad (η)" value={`${metrics.viscosity_cp.toFixed(3)} cP`} unit="Mezcla solventes" status="neutral" />
        <MetricBox label="Velocidad (u)" value={`${metrics.linear_velocity_u_mm_s.toFixed(2)} mm/s`} unit="Fase Móvil" status="neutral" />
      </div>

      {/* LAYOUT DOS COLUMNAS */}
      <div className="grid grid-cols-[1fr_290px] gap-4">
        
        {/* COLUMNA IZQUIERDA: GRÁFICOS Y MENÚS */}
        <div className="space-y-4">
          
          {/* CROMATOGRAMA */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3">
            <div className="flex justify-between items-center mb-2">
              <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                Cromatograma en Tiempo Real — Espectrofotómetro UV-Vis (254 nm)
              </span>
              {metrics.rs < 1.5 && (
                <span className="text-amber-400 text-[9px] animate-pulse bg-amber-950/20 border border-amber-900 rounded px-2 py-0.5">
                  ⚠️ Solapamiento: Rs = {metrics.rs.toFixed(2)}
                </span>
              )}
            </div>
            <ResponsiveContainer width="100%" height={170}>
              <AreaChart data={chrom} margin={{ top: 5, right: 10, left: -25, bottom: 5 }}>
                <defs>
                  <linearGradient id="pA" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f87171" stopOpacity={0.4}/>
                    <stop offset="95%" stopColor="#f87171" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="pB" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={solventInfo.color} stopOpacity={0.4}/>
                    <stop offset="95%" stopColor={solventInfo.color} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#21262d"/>
                <XAxis dataKey="t" stroke="#484f58" tick={{ fontSize: 9, fill: "#8b949e" }}
                  label={{ value: "Tiempo (min)", position: "insideBottom", fill: "#8b949e", fontSize: 9, offset: -2 }}/>
                <YAxis stroke="#484f58" tick={{ fontSize: 9, fill: "#8b949e" }}/>
                <Tooltip contentStyle={{ background: "#0d1117", border: "1px solid #30363d", fontSize: 10 }}/>
                <Area type="monotone" dataKey="peak_a" stroke="#f87171" strokeWidth={1.5}
                  fill="url(#pA)" name={`${metrics.peak_a.analyte_name || "Paracetamol"} (Polar)`}/>
                <Area type="monotone" dataKey="peak_b" stroke={solventInfo.color} strokeWidth={1.5}
                  fill="url(#pB)" name={`${metrics.peak_b.analyte_name || "Ibuprofeno"} (Apolar)`}/>
              </AreaChart>
            </ResponsiveContainer>
            <div className="flex gap-6 justify-center mt-2">
              <span className="text-red-400 text-[10px] font-bold">── {metrics.peak_a.analyte_name || "Paracetamol"} (k' = {metrics.peak_a.retention_factor_k.toFixed(2)})</span>
              <span className="text-[10px] font-bold" style={{ color: solventInfo.color }}>
                ── {metrics.peak_b.analyte_name || "Ibuprofeno"} (k' = {metrics.peak_b.retention_factor_k.toFixed(2)})
              </span>
            </div>
          </div>

          {/* TABS CONFIGURACIÓN */}
          <div className="flex gap-2">
            <button className={activeTabStyle("instrument")} onClick={() => setActiveTab("instrument")}>⚙ Parámetros Físicos</button>
            <button className={activeTabStyle("vandeemter")} onClick={() => setActiveTab("vandeemter")}>📈 van Deemter Líquida</button>
            {ragFeedback && (
              <button className={`${activeTabStyle("rag_tutor")} animate-bounce bg-purple-950/20 border-purple-500`} onClick={() => setActiveTab("rag_tutor")}>
                🔮 Microcápsula RAG (+1)
              </button>
            )}
          </div>

          {/* TAB: PARAMETROS INSTRUMENTALES */}
          {activeTab === "instrument" && (
            <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-3">
              <p className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1">Configuración Hidráulica</p>
              
              {/* Columna */}
              <div className="flex items-center gap-3">
                <label className="text-slate-500 w-28 font-bold text-[10px]">Columna Sorbente:</label>
                <select
                  className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1.5 text-slate-300 text-[11px] outline-none"
                  value={state.columnKey}
                  onChange={e => updateState({ columnKey: e.target.value })}
                >
                  {HPLC_COLUMNS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </div>

              {/* Mezcla de Analitos */}
              <div className="flex items-center gap-3">
                <label className="text-slate-500 w-28 font-bold text-[10px]">Mezcla USP (Muestra):</label>
                <select
                  className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1.5 text-slate-300 text-[11px] outline-none"
                  value={state.analyteMixture || "Paracetamol + Ibuprofeno"}
                  onChange={e => updateState({ analyteMixture: e.target.value })}
                >
                  {Object.keys(ANALYTE_MIXTURES).map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>

              {/* Solvente */}
              <div className="flex items-center gap-3">
                <label className="text-slate-500 w-28 font-bold text-[10px]">Modificador Orgánico:</label>
                <div className="flex gap-2">
                  {(["ACN", "MeOH"] as SolventType[]).map(s => (
                    <button
                      key={s}
                      onClick={() => updateState({ mobilePhaseSolvent: s })}
                      className={`px-3 py-1.5 rounded-lg border text-[10px] font-mono font-bold transition-colors cursor-pointer
                        ${state.mobilePhaseSolvent === s ? "border-purple-500 text-purple-400 bg-purple-950/20" : "border-[#30363d] text-slate-500"}`}
                    >
                      {SOLVENT_INFO[s].label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Sliders */}
              <div className="space-y-2.5 pt-1 border-t border-[#21262d]">
                {/* Caudal */}
                <div className="flex items-center gap-3">
                  <label className="text-slate-500 w-28 text-[10px]">Caudal (mL/min):</label>
                  <input type="range" min={0.1} max={4.0} step={0.05}
                    value={state.flowRateMlMin}
                    onChange={e => updateState({ flowRateMlMin: Number(e.target.value) })}
                    className="flex-1 accent-purple-500"/>
                  <span className="text-purple-400 w-16 text-right font-mono font-bold">{state.flowRateMlMin.toFixed(2)} mL/min</span>
                </div>

                {/* Porcentaje Orgánico */}
                <div className="flex items-center gap-3">
                  <label className="text-slate-500 w-28 text-[10px]">% Solvente Orgánico:</label>
                  <input type="range" min={5} max={95} step={1}
                    value={state.organicModifierPct}
                    onChange={e => updateState({ organicModifierPct: Number(e.target.value) })}
                    className="flex-1 accent-purple-500"/>
                  <span className="text-purple-400 w-16 text-right font-mono font-bold">{state.organicModifierPct.toFixed(0)}%</span>
                </div>

                {/* Temperatura */}
                <div className="flex items-center gap-3">
                  <label className="text-slate-500 w-28 text-[10px]">Temp. Horno (°C):</label>
                  <input type="range" min={20} max={80} step={1}
                    value={state.ovenTempC}
                    onChange={e => updateState({ ovenTempC: Number(e.target.value) })}
                    className="flex-1 accent-purple-500"/>
                  <span className="text-purple-400 w-16 text-right font-mono font-bold">{state.ovenTempC.toFixed(0)}°C</span>
                </div>
              </div>
            </div>
          )}

          {/* TAB: VAN DEEMTER CHART */}
          {activeTab === "vandeemter" && (
            <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-2">
              <p className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1">Curva de Knox / van Deemter Líquida ($H$ vs $u$)</p>
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={vandeemterPoints} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#21262d"/>
                  <XAxis dataKey="u_mm_s" tick={{ fontSize: 8, fill: "#8b949e" }}
                    label={{ value: "u (mm/s)", position: "insideBottom", fill: "#8b949e", fontSize: 8, offset: -2 }}/>
                  <YAxis tick={{ fontSize: 8, fill: "#8b949e" }}/>
                  <Tooltip contentStyle={{ background: "#0d1117", border: "1px solid #30363d", fontSize: 8 }}/>
                  <Line type="monotone" dataKey="hetp_total_mm" stroke="#a855f7" strokeWidth={2} dot={false} name=" Knox HETP total"/>
                  <Line type="monotone" dataKey="A_contribution" stroke="#f87171" strokeWidth={1} strokeDasharray="3 3" dot={false} name=" A (dif. eddy)"/>
                  <Line type="monotone" dataKey="B_contribution" stroke="#38bdf8" strokeWidth={1} strokeDasharray="3 3" dot={false} name=" B/u (dif. long.)"/>
                  <Line type="monotone" dataKey="C_contribution" stroke="#fbbf24" strokeWidth={1} strokeDasharray="3 3" dot={false} name=" C*u (transf. masa)"/>
                  <ReferenceLine x={metrics.linear_velocity_u_mm_s} stroke="#c084fc" label={{ value: "Punto de operación", fill: "#c084fc", fontSize: 8 }} />
                </LineChart>
              </ResponsiveContainer>
              <p className="text-[10px] text-slate-500 text-center">
                Velocidad óptima calculada ({"$u_{opt}$"}): <strong>{vandeemterPoints[0]?.u_optimal_mm_s?.toFixed(2)} mm/s</strong>. 
                Velocidad lineal actual: <strong>{metrics.linear_velocity_u_mm_s.toFixed(2)} mm/s</strong>.
              </p>
            </div>
          )}

          {/* TAB: RAG TUTOR */}
          {activeTab === "rag_tutor" && (
            <div className="bg-[#13112c] border border-purple-800 rounded-xl p-4 space-y-2 animate-fadeIn">
              <div className="flex items-center gap-2 text-purple-400">
                <span className="text-lg">🔮</span>
                <span className="text-[10px] font-bold uppercase tracking-widest">Tutor RAG — Microcápsula Pedagógica</span>
              </div>
              <p className="text-slate-300 text-xs italic leading-relaxed">
                "{ragFeedback}"
              </p>
              <div className="text-[9px] text-purple-500 font-bold text-right mt-1">
                Fundamento: USP 49 & Guías Generales HPLC
              </div>
            </div>
          )}

        </div>

        {/* COLUMNA DERECHA: ESTADO COLUMNA Y ALERTAS */}
        <div className="space-y-3">
          
          {/* ESTRUCTURA COLUMNA */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-2">
            <p className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1">Especificaciones Columna</p>
            <div className="space-y-1 text-[10px] font-mono">
              <div className="flex justify-between border-b border-[#1b2028] pb-1">
                <span className="text-slate-500">Longitud (L):</span>
                <span className="text-slate-300">{colInfo.L} mm</span>
              </div>
              <div className="flex justify-between border-b border-[#1b2028] pb-1">
                <span className="text-slate-500">Diámetro (dc):</span>
                <span className="text-slate-300">{colInfo.dc} mm</span>
              </div>
              <div className="flex justify-between border-b border-[#1b2028] pb-1">
                <span className="text-slate-500">Partícula (dp):</span>
                <span className="text-slate-300">{colInfo.dp} µm</span>
              </div>
              <div className="flex justify-between border-b border-[#1b2028] pb-1">
                <span className="text-slate-500">Fase Activa:</span>
                <span className="text-purple-400 font-bold">{colInfo.chem}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Límite Presión:</span>
                <span className="text-red-400">{colInfo.maxP} MPa</span>
              </div>
            </div>
          </div>

          {/* DETALLES DE PICOS */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-2">
            <p className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1">Idoneidad USP 49</p>
            
            <div className="space-y-2 text-[10px]">
              {/* Analito A */}
              <div className="border-b border-[#1b2028] pb-2">
                <p className="text-red-400 font-bold">{metrics.peak_a.analyte_name || "Paracetamol"} (Pico A)</p>
                <div className="grid grid-cols-2 gap-1 text-[9px] text-slate-400 mt-1">
                  <span>tR: <strong>{metrics.peak_a.retention_time_min.toFixed(2)} min</strong></span>
                  <span>T (cola): <strong>{metrics.peak_a.tailing_factor_usp.toFixed(2)}</strong></span>
                  <span>W (base): <strong>{metrics.peak_a.peak_width_min.toFixed(2)} s</strong></span>
                  <span>W_1/2: <strong>{metrics.peak_a.peak_width_half_min.toFixed(2)} s</strong></span>
                </div>
              </div>

              {/* Analito B */}
              <div>
                <p className="text-blue-400 font-bold">{metrics.peak_b.analyte_name || "Ibuprofeno"} (Pico B)</p>
                <div className="grid grid-cols-2 gap-1 text-[9px] text-slate-400 mt-1">
                  <span>tR: <strong>{metrics.peak_b.retention_time_min.toFixed(2)} min</strong></span>
                  <span>T (cola): <strong>{metrics.peak_b.tailing_factor_usp.toFixed(2)}</strong></span>
                  <span>W (base): <strong>{metrics.peak_b.peak_width_min.toFixed(2)} s</strong></span>
                  <span>W_1/2: <strong>{metrics.peak_b.peak_width_half_min.toFixed(2)} s</strong></span>
                </div>
              </div>
            </div>
          </div>

          {/* CUADRO DE ALERTAS */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3">
            <p className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1 mb-2">Advertencias del Sistema</p>
            {metrics.warnings.length === 0 && metrics.errors.length === 0 ? (
              <p className="text-emerald-500 font-bold text-[10px] flex items-center gap-1">
                ✓ Todo el sistema opera óptimo
              </p>
            ) : (
              <div className="space-y-1.5 max-h-36 overflow-y-auto">
                {metrics.errors.map((e, i) => (
                  <p key={i} className="text-red-400 text-[9px] leading-relaxed">
                    🚨 {e}
                  </p>
                ))}
                {metrics.warnings.map((w, i) => (
                  <p key={i} className="text-amber-500 text-[9px] leading-relaxed">
                    ⚠️ {w}
                  </p>
                ))}
              </div>
            )}
          </div>

        </div>

      </div>

      {/* POPUP HOLOGRÁFICO TUTOR RAG */}
      {showRagPopup && ragFeedback && (
        <div className="fixed bottom-6 right-6 z-[99] max-w-sm bg-[#13112c]/90 border border-purple-500 rounded-xl p-4 shadow-[0_0_25px_rgba(168,85,247,0.3)] backdrop-blur-md animate-fadeIn flex flex-col space-y-2 text-slate-200">
          <div className="flex justify-between items-center border-b border-purple-800 pb-1.5 font-mono text-[10px] font-bold text-purple-400">
            <span className="flex items-center gap-1.5">🔮 Tutoría Académica RAG</span>
            <button
              onClick={() => setShowRagPopup(false)}
              className="text-slate-500 hover:text-white font-bold text-xs cursor-pointer px-1 hover:bg-purple-950/40 rounded transition-colors"
            >
              ×
            </button>
          </div>
          <p className="text-[11px] leading-relaxed italic text-slate-300">
            "{ragFeedback}"
          </p>
          <div className="flex items-center justify-between text-[9px] text-purple-500 font-bold font-mono">
            <span>Fundamento: Knox / Darcy / USP</span>
            <button
              onClick={() => {
                setActiveTab("rag_tutor");
                setShowRagPopup(false);
              }}
              className="text-purple-400 hover:text-purple-300 underline cursor-pointer"
            >
              Ver en detalles
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
