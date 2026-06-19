/**
 * GCSimulatorPanel.tsx
 *
 * Panel completo del simulador de Cromatografía de Gases.
 * Cubre Unidad 5 del microcurrículo:
 *   - Fundamento GC (Golay, gas portador, fase estacionaria)
 *   - Modos de inyección: Split / Splitless / On-column / SPME
 *   - Selección de detector: FID / TCD / ECD / MS / NPD
 *   - Programación de temperatura (rampas lineales)
 *   - Cromatograma en tiempo real con picos gaussianos
 *   - Gates HITL integrados (Unidad 5 — Caso GC)
 *   - Comparador de gases portadores
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

// ─── TIPOS ───────────────────────────────────────────────────

type CarrierGas  = "He" | "H2" | "N2";
type InjMode     = "SPLIT" | "SPLITLESS" | "ON_COLUMN" | "SPME";
type DetectorKey = "FID" | "TCD" | "ECD" | "MS" | "NPD";
type GateStatus  = "LOCKED" | "PENDING" | "VALIDATED" | "FAILED";

interface TempRamp { startC: number; endC: number; rateC_min: number }

interface GCState {
  columnKey: string;
  carrierGas: CarrierGas;
  inletPressureKpa: number;
  ovenTempC: number;
  injectorTempC: number;
  detectorType: DetectorKey;
  detectorTempC: number;
  injectionMode: InjMode;
  splitRatio: number;
  purgeTimeMin: number;
  kPrimeA: number;
  kPrimeB: number;
  tempProgram: TempRamp[];
  useTempProgram: boolean;
}

interface GCMetrics {
  rs: number;
  alpha: number;
  nPlates: number;
  hetpMm: number;
  reducedHetp: number;
  avgVelocityCmS: number;
  jamesMartin: number;
  pressureOk: boolean;
  golay_B: number;
  golay_Cm: number;
  golay_Cs: number;
  warnings: string[];
  errors: string[];
}

interface ChromPoint { t: number; signal: number; peak_a: number; peak_b: number }

// ─── CATÁLOGOS INLINE ─────────────────────────────────────────

const GC_COLUMNS = [
  { key: "DB5_30m",   label: "DB-5  30m×0.25mm×0.25μm (apolar)",   dc: 0.25, df: 0.25, L: 30, maxT: 325 },
  { key: "DB1_60m",   label: "DB-1  60m×0.25mm×0.25μm (apolar)",   dc: 0.25, df: 0.25, L: 60, maxT: 325 },
  { key: "DB5_032",   label: "DB-5  30m×0.32mm×0.25μm",            dc: 0.32, df: 0.25, L: 30, maxT: 325 },
  { key: "DBWAX",     label: "DB-WAX 30m×0.25mm×0.25μm (polar)",   dc: 0.25, df: 0.25, L: 30, maxT: 260 },
  { key: "DB17",      label: "DB-17  30m×0.25mm×0.25μm (medio)",   dc: 0.25, df: 0.25, L: 30, maxT: 300 },
  { key: "DB5MS_15m", label: "DB-5ms 15m×0.25mm×0.10μm (GC-MS)",  dc: 0.25, df: 0.10, L: 15, maxT: 325 },
];

const GAS_INFO: Record<CarrierGas, { label: string; color: string; optRange: string; dm25: number }> = {
  He: { label: "Helio",      color: "#58a6ff", optRange: "20–35 cm/s", dm25: 0.42 },
  H2: { label: "Hidrógeno",  color: "#3fb950", optRange: "35–60 cm/s", dm25: 0.68 },
  N2: { label: "Nitrógeno",  color: "#d29922", optRange: "10–20 cm/s", dm25: 0.18 },
};

const DETECTOR_INFO: Record<DetectorKey, {
  label: string; mdq: string; selectivity: string;
  color: string; compatibleGas: CarrierGas[];
}> = {
  FID: { label: "FID — Ionización de llama",      mdq: "~10⁻¹³ g/s", selectivity: "Orgánicos C-H",        color: "#f85149", compatibleGas: ["He","N2","H2"] },
  TCD: { label: "TCD — Conductividad térmica",    mdq: "~10⁻¹⁰ g/s", selectivity: "Universal (gases)",    color: "#58a6ff", compatibleGas: ["He","H2"] },
  ECD: { label: "ECD — Captura de electrones",    mdq: "~10⁻¹⁵ g/s", selectivity: "Halogenados / OC",     color: "#a371f7", compatibleGas: ["N2"] },
  MS:  { label: "MS  — Espectrometría de masas",  mdq: "~10⁻¹³ g/s", selectivity: "Universal + SIM",      color: "#3fb950", compatibleGas: ["He"] },
  NPD: { label: "NPD — Nitrógeno-fósforo",        mdq: "~10⁻¹⁴ g/s", selectivity: "N/P (pesticidas)",     color: "#d29922", compatibleGas: ["He","N2"] },
};

const INJ_MODE_INFO: Record<InjMode, { label: string; use: string; icon: string }> = {
  SPLIT:      { label: "Split",      use: "Muestras concentradas (1:10 – 1:1000)", icon: "⚡" },
  SPLITLESS:  { label: "Splitless",  use: "Trazas / pesticidas (purga ~1 min)",    icon: "🔬" },
  ON_COLUMN:  { label: "On-column",  use: "Termolábiles / alta PM",                icon: "🌡" },
  SPME:       { label: "SPME",       use: "Muestras complejas / headspace",         icon: "🪡" },
};

const GC_INITIAL: GCState = {
  columnKey: "DB5_30m",
  carrierGas: "He",
  inletPressureKpa: 120.0,
  ovenTempC: 150.0,
  injectorTempC: 250.0,
  detectorType: "FID",
  detectorTempC: 280.0,
  injectionMode: "SPLIT",
  splitRatio: 50,
  purgeTimeMin: 1.0,
  kPrimeA: 5.0,
  kPrimeB: 8.5,
  tempProgram: [
    { startC: 60,  endC: 180, rateC_min: 10 },
    { startC: 180, endC: 280, rateC_min: 20 },
  ],
  useTempProgram: false,
};

// ─── MOTOR FÍSICO GC INLINE ───────────────────────────────────

function computeGCMetrics(s: GCState): GCMetrics {
  const col = GC_COLUMNS.find(c => c.key === s.columnKey)!;
  const dm  = GAS_INFO[s.carrierGas].dm25 * (((s.ovenTempC + 273.15) / 298.15) ** 1.75);
  const Dm  = dm * 100; // mm²/s

  const dc = col.dc; // mm
  const df = col.df * 1e-3; // μm → mm
  const L  = col.L * 1000;  // m → mm

  // James-Martin compressibility
  const r = s.inletPressureKpa / 101.325;
  const j = Math.abs(r - 1) < 1e-4 ? 1.0 : (3/2) * (r**2 - 1) / (r**3 - 1);

  // Average linear velocity (Hagen-Poiseuille)
  const eta_uPa = 19.9 * (((s.ovenTempC + 273.15) / 298.15) ** 0.67);
  const eta = eta_uPa * 1e-6; // Pa·s
  const dc_cm = col.dc / 10;
  const L_cm  = col.L * 100;
  const dP    = (s.inletPressureKpa - 101.325) * 1e3; // Pa
  const u_cm_s = Math.max((dc_cm**2 * dP * j) / (32 * eta * L_cm), 0.5);
  const u = u_cm_s * 10; // mm/s

  // Golay per analyte (use kA for conservative estimate)
  const k = (s.kPrimeA + s.kPrimeB) / 2;
  const Ds = Dm / 1000;
  const B  = 2 * Dm;
  const Cm = dc**2 * (1 + 6*k + 11*k**2) / (96 * Dm * (1 + k)**2);
  const Cs = 2 * k * df**2 / (3 * Ds * (1 + k)**2);
  const hetp = B / u + (Cm + Cs) * u;

  const N     = Math.max(Math.floor(L / hetp), 100);
  const kMax  = Math.max(s.kPrimeA, s.kPrimeB);
  const kMin  = Math.min(s.kPrimeA, s.kPrimeB);
  const alpha = kMax / Math.max(kMin, 0.001);
  const rs    = (Math.sqrt(N) / 4) * ((alpha - 1) / alpha) * (kMax / (1 + kMax));

  const warnings: string[] = [];
  const errors:   string[] = [];

  if (s.ovenTempC > col.maxT) errors.push(`T horno ${s.ovenTempC}°C supera máx. columna ${col.maxT}°C`);
  if (!DETECTOR_INFO[s.detectorType].compatibleGas.includes(s.carrierGas)) {
    warnings.push(`${s.detectorType} no recomendado con ${s.carrierGas}`);
  }
  if (s.detectorTempC < s.ovenTempC) warnings.push("T detector < T horno — riesgo de condensación");
  if (rs < 1.5) warnings.push(`Rs = ${rs.toFixed(2)} — separación insuficiente (objetivo ≥ 1.50)`);

  return {
    rs: parseFloat(rs.toFixed(4)),
    alpha: parseFloat(alpha.toFixed(4)),
    nPlates: N,
    hetpMm: parseFloat(hetp.toFixed(5)),
    reducedHetp: parseFloat((hetp / col.dc).toFixed(3)),
    avgVelocityCmS: parseFloat(u_cm_s.toFixed(3)),
    jamesMartin: parseFloat(j.toFixed(4)),
    pressureOk: s.inletPressureKpa <= 970,
    golay_B: parseFloat(B.toFixed(6)),
    golay_Cm: parseFloat(Cm.toFixed(6)),
    golay_Cs: parseFloat(Cs.toFixed(6)),
    warnings,
    errors,
  };
}

function buildChromatogram(s: GCState, m: GCMetrics): ChromPoint[] {
  const col = GC_COLUMNS.find(c => c.key === s.columnKey)!;
  const u_cm_s = m.avgVelocityCmS;
  const u_mm_s = u_cm_s * 10;
  const L_mm   = col.L * 1000;
  const tM     = L_mm / (u_mm_s * 60); // min

  const tRA = tM * (1 + s.kPrimeA);
  const tRB = tM * (1 + s.kPrimeB);
  const sigA = tRA / Math.sqrt(Math.max(m.nPlates, 1));
  const sigB = tRB / Math.sqrt(Math.max(m.nPlates, 1));
  const tEnd = tRB * 1.6;

  return Array.from({ length: 160 }, (_, i) => {
    const t = (tEnd * i) / 159;
    const pA = 0.85 * Math.exp(-0.5 * ((t - tRA) / sigA) ** 2);
    const pB = 1.00 * Math.exp(-0.5 * ((t - tRB) / sigB) ** 2);
    return { t: parseFloat(t.toFixed(4)), signal: parseFloat((pA + pB).toFixed(5)), peak_a: parseFloat(pA.toFixed(5)), peak_b: parseFloat(pB.toFixed(5)) };
  });
}

function buildTempogram(program: TempRamp[]): { t: number; temp: number }[] {
  const pts: { t: number; temp: number }[] = [{ t: 0, temp: program[0]?.startC ?? 60 }];
  let t = 0;
  for (const ramp of program) {
    const duration = (ramp.endC - ramp.startC) / ramp.rateC_min;
    const steps = Math.max(Math.ceil(duration * 2), 2);
    for (let i = 1; i <= steps; i++) {
      t += duration / steps;
      pts.push({ t: parseFloat(t.toFixed(2)), temp: parseFloat((ramp.startC + (ramp.endC - ramp.startC) * i / steps).toFixed(1)) });
    }
    // Isothermal hold (1 min)
    pts.push({ t: parseFloat((t + 1).toFixed(2)), temp: ramp.endC });
    t += 1;
  }
  return pts;
}

// ─── SUB-COMPONENTS ──────────────────────────────────────────

function MetricBox({ label, value, unit, status }: { label: string; value: string; unit?: string; status: "ok" | "warn" | "bad" | "neutral" }) {
  const clr = { ok: "text-emerald-400 border-emerald-900", warn: "text-amber-400 border-amber-900", bad: "text-red-400 border-red-900", neutral: "text-slate-400 border-slate-800" }[status];
  return (
    <div className={`flex flex-col items-center border rounded px-2 py-1.5 bg-[#0d1117] ${clr}`}>
      <span className="text-[9px] uppercase tracking-widest text-slate-600 mb-0.5">{label}</span>
      <span className="text-base font-bold font-mono leading-none">{value}</span>
      {unit && <span className="text-[9px] text-slate-700 mt-0.5">{unit}</span>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] uppercase tracking-widest text-slate-500 border-b border-[#21262d] pb-1 mb-2">{children}</p>;
}

function ParamRow({ label, value, locked }: { label: string; value: string; locked?: boolean }) {
  return (
    <div className="flex justify-between py-0.5 border-b border-[#1a1f27] last:border-0">
      <span className="text-slate-500 text-[10px]">{label}</span>
      <span className={`text-[10px] font-mono ${locked ? "text-slate-700" : "text-slate-300"}`}>{value}</span>
    </div>
  );
}

// ─── HITL GATE COMPONENT ──────────────────────────────────────

function GCHITLGate({ gateNum, status, question, equation, onSubmit, attemptCount, onHint }: {
  gateNum: number;
  status: GateStatus;
  question: string;
  equation?: string;
  onSubmit: (text: string) => void;
  attemptCount: number;
  onHint: () => void;
}) {
  const [text, setText] = useState("");
  const [feedback, setFeedback] = useState("");

  if (status === "VALIDATED") {
    return (
      <div className="bg-emerald-900/20 border border-emerald-800 rounded-md p-2 flex items-center gap-2">
        <span className="text-emerald-400 text-lg">✅</span>
        <span className="text-emerald-400 text-xs">Gate #{gateNum} validado — parámetros desbloqueados</span>
      </div>
    );
  }

  if (status === "LOCKED") {
    return (
      <div className="bg-[#161b22] border border-[#30363d] rounded-md p-2 flex items-center gap-2 opacity-50">
        <span className="text-slate-600 text-lg">🔒</span>
        <span className="text-slate-600 text-xs">Gate #{gateNum} — bloqueado hasta superar gate anterior</span>
      </div>
    );
  }

  const handleSubmit = () => {
    if (text.trim().length < 30) { setFeedback("⚠ Mínimo 30 caracteres"); return; }
    onSubmit(text);
    setFeedback("Evaluando…");
  };

  return (
    <div className="bg-[#1c1408] border border-amber-800 rounded-md p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-amber-400">🔒</span>
        <span className="text-amber-400 text-[10px] uppercase tracking-widest">Gate HITL #{gateNum}</span>
        {status === "FAILED" && <span className="text-red-400 text-[10px] ml-auto">FALLIDO — intervención docente</span>}
      </div>
      <p className="text-slate-300 text-xs leading-relaxed">{question}</p>
      {equation && (
        <div className="bg-[#0d1117] border border-[#30363d] rounded px-3 py-1.5 text-blue-300 text-xs text-center font-mono tracking-wide">
          {equation}
        </div>
      )}
      <textarea
        className="w-full bg-[#0d1117] border border-[#30363d] focus:border-amber-700
                   rounded p-2 text-slate-200 text-xs font-mono resize-none outline-none transition-colors"
        rows={3}
        placeholder="Justificación físico-química (mín. 30 caracteres)…"
        value={text}
        onChange={e => setText(e.target.value)}
        disabled={status === "FAILED"}
      />
      {feedback && <p className="text-[10px] text-amber-400">{feedback}</p>}
      <div className="flex gap-2 items-center">
        <button
          onClick={handleSubmit}
          disabled={text.length < 30 || status === "FAILED"}
          className="bg-[#238636] hover:bg-[#2ea043] disabled:opacity-40 border border-[#2ea043]
                     text-white rounded px-3 py-1 text-xs cursor-pointer"
        >
          ✔ Validar
        </button>
        <button onClick={onHint} className="bg-[#161b22] border border-[#30363d] hover:border-amber-700
                    text-slate-500 hover:text-amber-400 rounded px-3 py-1 text-xs cursor-pointer">
          ⚡ Pista (−5 pts)
        </button>
        <span className="ml-auto text-slate-700 text-[10px]">
          {attemptCount}/3 intentos
        </span>
      </div>
    </div>
  );
}

// ─── MAIN COMPONENT ──────────────────────────────────────────

export default function GCSimulatorPanel({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<GCState>(GC_INITIAL);
  const [metrics, setMetrics] = useState<GCMetrics>(() => computeGCMetrics(GC_INITIAL));
  const [chrom, setChrom] = useState<ChromPoint[]>([]);
  const [activeTab, setActiveTab] = useState<"instrument" | "injection" | "temp_program" | "detector">("instrument");
  const [gates, setGates] = useState<{ g1: GateStatus; g2: GateStatus }>({ g1: "PENDING", g2: "LOCKED" });
  const [attempts, setAttempts] = useState({ g1: 0, g2: 0 });
  const [elapsed, setElapsed] = useState(0);
  const [simCount, setSimCount] = useState(0);

  // Timer
  useEffect(() => {
    const t = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Recalculate on state change
  useEffect(() => {
    const m = computeGCMetrics(state);
    setMetrics(m);
    setChrom(buildChromatogram(state, m));
    setSimCount(c => c + 1);
  }, [state]);

  const updateState = useCallback((patch: Partial<GCState>) => {
    setState(prev => ({ ...prev, ...patch }));
  }, []);

  const rsStatus = metrics.rs >= 1.5 ? "ok" : metrics.rs >= 1.0 ? "warn" : "bad";
  const tempogram = useMemo(() => state.useTempProgram ? buildTempogram(state.tempProgram) : [], [state.tempProgram, state.useTempProgram]);

  const handleGateSubmit = (gate: 1 | 2) => (text: string) => {
    const kw = ["golay", "difusion", "difusión", "velocidad", "gas portador", "dm", "hetp",
                 "transferencia de masa", "b/u", "cm", "cs", "columbia", "columna", "selectividad",
                 "temperatura", "fase estacionaria", "alfa", "alpha", "rs"];
    const found = kw.filter(k => text.toLowerCase().includes(k));
    const pass  = found.length >= 2;
    if (gate === 1) {
      setAttempts(a => ({ ...a, g1: a.g1 + 1 }));
      if (pass) setGates(g => ({ ...g, g1: "VALIDATED", g2: "PENDING" }));
      else if (attempts.g1 >= 2) setGates(g => ({ ...g, g1: "FAILED" }));
    } else {
      setAttempts(a => ({ ...a, g2: a.g2 + 1 }));
      if (pass) setGates(g => ({ ...g, g2: "VALIDATED" }));
      else if (attempts.g2 >= 2) setGates(g => ({ ...g, g2: "FAILED" }));
    }
  };

  const colInfo = GC_COLUMNS.find(c => c.key === state.columnKey)!;
  const detInfo = DETECTOR_INFO[state.detectorType];
  const gasInfo = GAS_INFO[state.carrierGas];
  const TAB = (t: typeof activeTab) =>
    `px-3 py-1.5 text-[10px] font-mono rounded cursor-pointer transition-colors ${
      activeTab === t
        ? "bg-[#21262d] border border-[#30363d] text-slate-200"
        : "text-slate-600 hover:text-slate-400"
    }`;

  return (
    <div className="bg-[#0d1117] text-slate-300 font-mono text-xs rounded-xl p-3 border border-[#21262d]">

      {/* TOPBAR */}
      <div className="flex items-center justify-between border-b border-[#21262d] pb-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-emerald-400">● CHROMATOX·EDU</span>
          <span className="bg-[#161b22] border border-[#30363d] rounded px-2 py-0.5 text-slate-500">
            GC — Unidad 5
          </span>
          <span className="bg-[#161b22] border border-[#30363d] rounded px-2 py-0.5 text-[10px]"
            style={{ color: detInfo.color, borderColor: detInfo.color }}>
            {state.detectorType}
          </span>
          <span className="bg-[#161b22] border border-[#30363d] rounded px-2 py-0.5 text-[10px]"
            style={{ color: gasInfo.color }}>
            {gasInfo.label}
          </span>
        </div>
        <div className="flex gap-2 items-center">
          <span className="text-amber-400">⏱ {String(Math.floor(elapsed/60)).padStart(2,"0")}:{String(elapsed%60).padStart(2,"0")}</span>
          <span className="text-slate-700 text-[10px]">#{simCount}</span>
        </div>
      </div>

      {/* METRICS ROW */}
      <div className="grid grid-cols-5 gap-2 mb-3">
        <MetricBox label="Rs" value={metrics.rs.toFixed(2)} unit="mín: 1.50" status={rsStatus} />
        <MetricBox label="α" value={metrics.alpha.toFixed(3)} unit="selectividad"
          status={metrics.alpha >= 1.15 ? "ok" : metrics.alpha >= 1.05 ? "warn" : "bad"} />
        <MetricBox label="N (platos)" value={metrics.nPlates.toLocaleString()} unit={colInfo.label.split(" ")[0]}
          status={metrics.nPlates > 50000 ? "ok" : "warn"} />
        <MetricBox label="ū (cm/s)" value={metrics.avgVelocityCmS.toFixed(1)} unit={gasInfo.optRange}
          status="neutral" />
        <MetricBox label="HETP (mm)" value={metrics.hetpMm.toFixed(4)} unit={`h=${metrics.reducedHetp}`}
          status="neutral" />
      </div>

      <div className="grid grid-cols-[1fr_260px] gap-3">
        {/* ── LEFT ── */}
        <div className="space-y-3">

          {/* CROMATOGRAMA */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-md p-2">
            <div className="flex justify-between items-center mb-1">
              <span className="text-[10px] uppercase tracking-widest text-slate-500">
                Cromatograma GC — {state.detectorType}
              </span>
              {metrics.rs < 1.5 && (
                <span className="text-amber-400 text-[10px] animate-pulse">
                  ⚠ Rs = {metrics.rs.toFixed(2)}
                </span>
              )}
            </div>
            <ResponsiveContainer width="100%" height={165}>
              <AreaChart data={chrom} margin={{ top: 5, right: 5, left: -25, bottom: 15 }}>
                <defs>
                  <linearGradient id="gGA" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f85149" stopOpacity={0.4}/>
                    <stop offset="95%" stopColor="#f85149" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="gGB" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={gasInfo.color} stopOpacity={0.4}/>
                    <stop offset="95%" stopColor={gasInfo.color} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#21262d"/>
                <XAxis dataKey="t" stroke="#484f58" tick={{ fontSize: 9, fill: "#6e7681" }}
                  label={{ value: "Tiempo (min)", position: "insideBottom", fill: "#6e7681", fontSize: 9 }}/>
                <YAxis stroke="#484f58" tick={{ fontSize: 9, fill: "#6e7681" }}/>
                <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 10 }}/>
                <Area type="monotone" dataKey="peak_a" stroke="#f85149" strokeWidth={1.5}
                  fill="url(#gGA)" name="Analito A"/>
                <Area type="monotone" dataKey="peak_b" stroke={gasInfo.color} strokeWidth={1.5}
                  fill="url(#gGB)" name="Analito B"/>
              </AreaChart>
            </ResponsiveContainer>
            <div className="flex gap-4 justify-center mt-1">
              <span className="text-red-400 text-[10px]">── Analito A (k'={state.kPrimeA})</span>
              <span className="text-[10px]" style={{ color: gasInfo.color }}>── Analito B (k'={state.kPrimeB})</span>
            </div>
          </div>

          {/* TABS DE CONFIGURACIÓN */}
          <div className="flex gap-1 flex-wrap">
            {([["instrument","⚙ Instrumento"],["injection","💉 Inyección"],["temp_program","🌡 T Programa"],["detector","🔍 Detector"]] as const).map(([t, label]) => (
              <button key={t} className={TAB(t)} onClick={() => setActiveTab(t)}>{label}</button>
            ))}
          </div>

          {/* TAB: INSTRUMENTO */}
          {activeTab === "instrument" && (
            <div className="bg-[#161b22] border border-[#21262d] rounded-md p-3 space-y-2">
              <SectionTitle>Configuración del instrumento</SectionTitle>

              {/* Columna */}
              <div className="flex items-center gap-2">
                <label className="text-slate-500 w-28 shrink-0">Columna:</label>
                <select
                  className="flex-1 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1
                             text-slate-300 text-[11px] outline-none"
                  value={state.columnKey}
                  onChange={e => updateState({ columnKey: e.target.value })}
                >
                  {GC_COLUMNS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </div>

              {/* Gas portador */}
              <div className="flex items-center gap-2">
                <label className="text-slate-500 w-28 shrink-0">Gas portador:</label>
                <div className="flex gap-2">
                  {(["He","H2","N2"] as CarrierGas[]).map(g => (
                    <button key={g}
                      onClick={() => updateState({ carrierGas: g })}
                      className={`px-3 py-1 rounded border text-[10px] transition-colors cursor-pointer
                        ${state.carrierGas === g ? "border-current font-bold" : "border-[#30363d] text-slate-600"}`}
                      style={state.carrierGas === g ? { color: GAS_INFO[g].color, borderColor: GAS_INFO[g].color } : {}}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>

              {/* Presión */}
              <div className="flex items-center gap-2">
                <label className="text-slate-500 w-28 shrink-0">Presión entrada:</label>
                <input type="range" min={10} max={970} step={5}
                  value={state.inletPressureKpa}
                  onChange={e => updateState({ inletPressureKpa: Number(e.target.value) })}
                  className="flex-1"/>
                <span className="text-slate-300 w-20 text-right">{state.inletPressureKpa} kPa</span>
              </div>

              {/* T horno */}
              <div className="flex items-center gap-2">
                <label className="text-slate-500 w-28 shrink-0">T horno (iso.):</label>
                <input type="range" min={30} max={colInfo.maxT} step={5}
                  value={state.ovenTempC}
                  disabled={state.useTempProgram}
                  onChange={e => updateState({ ovenTempC: Number(e.target.value) })}
                  className="flex-1 disabled:opacity-30"/>
                <span className="text-slate-300 w-20 text-right">{state.ovenTempC}°C</span>
              </div>

              {/* k' analitos */}
              <div className="grid grid-cols-2 gap-3 pt-1 border-t border-[#21262d]">
                {([["kPrimeA","k' Analito A",1,20],["kPrimeB","k' Analito B",1,30]] as const).map(([key,label,mn,mx]) => (
                  <div key={key} className="flex items-center gap-2">
                    <label className="text-slate-500 text-[10px] w-24 shrink-0">{label}:</label>
                    <input type="range" min={mn} max={mx} step={0.5}
                      value={state[key]}
                      onChange={e => updateState({ [key]: Number(e.target.value) })}
                      className="flex-1"/>
                    <span className="text-slate-300 w-8 text-right">{state[key]}</span>
                  </div>
                ))}
              </div>

              {metrics.errors.map((e,i) => <p key={i} className="text-red-400 text-[10px]">{e}</p>)}
              {metrics.warnings.map((w,i) => <p key={i} className="text-amber-400 text-[10px]">{w}</p>)}
            </div>
          )}

          {/* TAB: INYECCIÓN */}
          {activeTab === "injection" && (
            <div className="bg-[#161b22] border border-[#21262d] rounded-md p-3 space-y-3">
              <SectionTitle>Modo de inyección</SectionTitle>
              <div className="grid grid-cols-2 gap-2">
                {(Object.entries(INJ_MODE_INFO) as [InjMode, typeof INJ_MODE_INFO[InjMode]][]).map(([k,info]) => (
                  <button key={k}
                    onClick={() => updateState({ injectionMode: k })}
                    className={`text-left p-2 rounded border transition-colors cursor-pointer
                      ${state.injectionMode === k
                        ? "border-blue-700 bg-blue-900/30 text-blue-300"
                        : "border-[#30363d] bg-[#0d1117] text-slate-500"
                      }`}
                  >
                    <p className="font-bold text-[11px]">{info.icon} {info.label}</p>
                    <p className="text-[10px] mt-0.5">{info.use}</p>
                  </button>
                ))}
              </div>

              {state.injectionMode === "SPLIT" && (
                <div className="flex items-center gap-2 pt-1">
                  <label className="text-slate-500 w-28 shrink-0">Split ratio 1:</label>
                  <input type="range" min={1} max={500} step={10}
                    value={state.splitRatio}
                    onChange={e => updateState({ splitRatio: Number(e.target.value) })}
                    className="flex-1"/>
                  <span className="text-slate-300 w-12 text-right">{state.splitRatio}</span>
                </div>
              )}
              {state.injectionMode === "SPLITLESS" && (
                <div className="flex items-center gap-2">
                  <label className="text-slate-500 w-28 shrink-0">T purga (min):</label>
                  <input type="range" min={0.5} max={3.0} step={0.1}
                    value={state.purgeTimeMin}
                    onChange={e => updateState({ purgeTimeMin: Number(e.target.value) })}
                    className="flex-1"/>
                  <span className="text-slate-300 w-12 text-right">{state.purgeTimeMin} min</span>
                </div>
              )}

              {/* T inyector */}
              <div className="flex items-center gap-2">
                <label className="text-slate-500 w-28 shrink-0">T inyector:</label>
                <input type="range" min={50} max={450} step={10}
                  value={state.injectorTempC}
                  onChange={e => updateState({ injectorTempC: Number(e.target.value) })}
                  className="flex-1"/>
                <span className="text-slate-300 w-16 text-right">{state.injectorTempC}°C</span>
              </div>

              {/* Nota educativa */}
              <div className="bg-[#0f1923] border border-[#1d3a5c] rounded p-2">
                <p className="text-blue-400 text-[10px] mb-1">💡 Concepto clave</p>
                <p className="text-slate-400 text-[10px] leading-relaxed">
                  {state.injectionMode === "SPLIT" && "Split: solo 1/ratio llega a la columna. Ideal para muestras concentradas. Split > 50:1 para GC-MS."}
                  {state.injectionMode === "SPLITLESS" && "Splitless: todo el vapor entra a la columna en ~60 s. Esencial para pesticidas en trazas. La purga elimina el disolvente residual."}
                  {state.injectionMode === "ON_COLUMN" && "On-column: inyección fría directa. Sin discriminación de compuestos de alto PM ni descomposición térmica."}
                  {state.injectionMode === "SPME" && "SPME: fibra extrae analitos del headspace o solución. Desorción térmica en el inyector caliente. Sin disolvente."}
                </p>
              </div>
            </div>
          )}

          {/* TAB: TEMPERATURA PROGRAMADA */}
          {activeTab === "temp_program" && (
            <div className="bg-[#161b22] border border-[#21262d] rounded-md p-3 space-y-2">
              <SectionTitle>Programación de temperatura</SectionTitle>
              <div className="flex items-center gap-3 mb-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={state.useTempProgram}
                    onChange={e => updateState({ useTempProgram: e.target.checked })}
                    className="accent-blue-500"/>
                  <span className="text-slate-300 text-[11px]">Activar temperatura programada</span>
                </label>
              </div>

              {state.useTempProgram && (
                <>
                  {state.tempProgram.map((ramp, i) => (
                    <div key={i} className="grid grid-cols-3 gap-2 bg-[#0d1117] border border-[#21262d] rounded p-2">
                      <div>
                        <label className="text-slate-600 text-[10px]">T inicial (°C)</label>
                        <input type="number" min={30} max={colInfo.maxT}
                          className="w-full bg-[#161b22] border border-[#30363d] rounded px-2 py-0.5 text-slate-200 text-[11px] outline-none"
                          value={ramp.startC}
                          onChange={e => {
                            const pr = [...state.tempProgram];
                            pr[i] = { ...pr[i], startC: Number(e.target.value) };
                            updateState({ tempProgram: pr });
                          }}/>
                      </div>
                      <div>
                        <label className="text-slate-600 text-[10px]">T final (°C)</label>
                        <input type="number" min={ramp.startC} max={colInfo.maxT}
                          className="w-full bg-[#161b22] border border-[#30363d] rounded px-2 py-0.5 text-slate-200 text-[11px] outline-none"
                          value={ramp.endC}
                          onChange={e => {
                            const pr = [...state.tempProgram];
                            pr[i] = { ...pr[i], endC: Number(e.target.value) };
                            updateState({ tempProgram: pr });
                          }}/>
                      </div>
                      <div>
                        <label className="text-slate-600 text-[10px]">Rampa (°C/min)</label>
                        <input type="number" min={1} max={60}
                          className="w-full bg-[#161b22] border border-[#30363d] rounded px-2 py-0.5 text-slate-200 text-[11px] outline-none"
                          value={ramp.rateC_min}
                          onChange={e => {
                            const pr = [...state.tempProgram];
                            pr[i] = { ...pr[i], rateC_min: Number(e.target.value) };
                            updateState({ tempProgram: pr });
                          }}/>
                      </div>
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <button
                      onClick={() => updateState({ tempProgram: [...state.tempProgram, { startC: state.tempProgram.at(-1)?.endC ?? 100, endC: 280, rateC_min: 15 }] })}
                      className="bg-[#21262d] border border-[#30363d] text-slate-400 hover:text-slate-200 rounded px-2 py-1 text-[10px] cursor-pointer">
                      + Rampa
                    </button>
                    {state.tempProgram.length > 1 && (
                      <button
                        onClick={() => updateState({ tempProgram: state.tempProgram.slice(0,-1) })}
                        className="bg-[#21262d] border border-[#30363d] text-slate-600 hover:text-red-400 rounded px-2 py-1 text-[10px] cursor-pointer">
                        − Quitar
                      </button>
                    )}
                  </div>

                  {/* Gráfico del programa de temperatura */}
                  {tempogram.length > 0 && (
                    <div className="bg-[#0d1117] border border-[#21262d] rounded p-2">
                      <p className="text-[10px] text-slate-600 mb-1">Perfil de temperatura</p>
                      <ResponsiveContainer width="100%" height={100}>
                        <LineChart data={tempogram} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#21262d"/>
                          <XAxis dataKey="t" tick={{ fontSize: 8, fill: "#6e7681" }}
                            label={{ value: "t (min)", position: "insideBottom", fill: "#6e7681", fontSize: 8 }}/>
                          <YAxis tick={{ fontSize: 8, fill: "#6e7681" }}/>
                          <Line type="monotone" dataKey="temp" stroke="#f85149" strokeWidth={2} dot={false}/>
                          <ReferenceLine y={colInfo.maxT} stroke="#da3633" strokeDasharray="4 2"
                            label={{ value: `Tmáx ${colInfo.maxT}°C`, fill: "#da3633", fontSize: 8 }}/>
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* TAB: DETECTOR */}
          {activeTab === "detector" && (
            <div className="bg-[#161b22] border border-[#21262d] rounded-md p-3 space-y-2">
              <SectionTitle>Selección de detector</SectionTitle>
              <div className="grid grid-cols-1 gap-1.5">
                {(Object.entries(DETECTOR_INFO) as [DetectorKey, typeof DETECTOR_INFO[DetectorKey]][]).map(([k,d]) => {
                  const compatible = d.compatibleGas.includes(state.carrierGas);
                  return (
                    <button key={k}
                      onClick={() => updateState({ detectorType: k })}
                      className={`text-left p-2 rounded border transition-colors cursor-pointer w-full
                        ${state.detectorType === k
                          ? "border-current bg-[#0d1117]"
                          : "border-[#21262d] bg-[#0d1117] hover:border-[#30363d]"
                        } ${!compatible ? "opacity-50" : ""}`}
                      style={state.detectorType === k ? { borderColor: d.color } : {}}
                    >
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-[11px]" style={{ color: d.color }}>{d.label}</span>
                        {!compatible && <span className="text-red-400 text-[9px]">⚠ incompatible con {state.carrierGas}</span>}
                      </div>
                      <div className="flex gap-3 mt-0.5">
                        <span className="text-slate-600 text-[10px]">MDQ: {d.mdq}</span>
                        <span className="text-slate-600 text-[10px]">Selectivo: {d.selectivity}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2 pt-1 border-t border-[#21262d]">
                <label className="text-slate-500 w-24 shrink-0">T detector:</label>
                <input type="range" min={50} max={450} step={10}
                  value={state.detectorTempC}
                  onChange={e => updateState({ detectorTempC: Number(e.target.value) })}
                  className="flex-1"/>
                <span className="text-slate-300 w-16 text-right">{state.detectorTempC}°C</span>
              </div>
            </div>
          )}

          {/* GATES HITL */}
          <GCHITLGate gateNum={1} status={gates.g1}
            question="Con la ecuación de Golay, ¿por qué en GC capilar no existe el término A (eddy diffusion)? ¿Qué impacto tiene esto en la forma de la curva HETP vs ū comparada con van Deemter?"
            equation="HETP = B/ū + (Cm + Cs)·ū     (sin término A)"
            onSubmit={handleGateSubmit(1)} attemptCount={attempts.g1}
            onHint={() => alert("Pista: Las columnas capilares no tienen empaque — no hay múltiples caminos para el analito.")}/>

          {gates.g1 === "VALIDATED" && (
            <GCHITLGate gateNum={2} status={gates.g2}
              question={`Rs actual = ${metrics.rs.toFixed(2)}. Propón un cambio de parámetro (gas portador, columna, temperatura o k') y justifica el mecanismo por el que aumenta α o N para lograr Rs ≥ 1.50.`}
              onSubmit={handleGateSubmit(2)} attemptCount={attempts.g2}
              onHint={() => alert("Pista: H₂ tiene Dm ~1.6× mayor que He. Esto desplaza u_opt hacia velocidades más altas, manteniendo HETP bajo.")}/>
          )}
        </div>

        {/* ── RIGHT COLUMN ── */}
        <div className="space-y-3">

          {/* Parámetros del sistema */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-md p-2">
            <SectionTitle>Sistema actual</SectionTitle>
            <ParamRow label="Columna"        value={colInfo.label.split("×")[0].trim()}/>
            <ParamRow label="L × dc × df"    value={`${colInfo.L}m × ${colInfo.dc}mm × ${colInfo.df}μm`}/>
            <ParamRow label="Fase"            value={colInfo.label.split(" ").slice(-1)[0].replace(/[()]/g,"")}/>
            <ParamRow label="Gas portador"    value={`${gasInfo.label} (${state.inletPressureKpa} kPa)`}/>
            <ParamRow label="j James-Martin"  value={metrics.jamesMartin.toFixed(4)}/>
            <ParamRow label="T horno"         value={`${state.ovenTempC} °C`}/>
            <ParamRow label="T inyector"      value={`${state.injectorTempC} °C`}/>
            <ParamRow label="T detector"      value={`${state.detectorTempC} °C`}/>
            <ParamRow label="Modo inyección"  value={INJ_MODE_INFO[state.injectionMode].label}/>
          </div>

          {/* Coeficientes de Golay */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-md p-2">
            <SectionTitle>Coeficientes Golay</SectionTitle>
            {[
              ["B (Long. diff.)",  metrics.golay_B.toExponential(3),  "mm²/s"],
              ["Cm (FM trans.)",   metrics.golay_Cm.toExponential(3), "s"],
              ["Cs (FS trans.)",   metrics.golay_Cs.toExponential(3), "s"],
              ["B/ū contrib.",     (metrics.golay_B / (metrics.avgVelocityCmS * 10)).toFixed(4), "mm"],
              ["(Cm+Cs)·ū contr.", ((metrics.golay_Cm + metrics.golay_Cs) * metrics.avgVelocityCmS * 10).toFixed(4), "mm"],
            ].map(([k, v, u]) => (
              <div key={k as string} className="flex justify-between py-0.5 border-b border-[#1a1f27] last:border-0">
                <span className="text-slate-500 text-[10px]">{k}</span>
                <span className="text-emerald-400 text-[10px] font-mono">{v} <span className="text-slate-700">{u}</span></span>
              </div>
            ))}
          </div>

          {/* Trazabilidad */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-md p-2">
            <SectionTitle>Trazabilidad HITL</SectionTitle>
            {[
              ["Sesión",       sessionId.slice(0,10) + "…"],
              ["⏱ Tiempo",    `${String(Math.floor(elapsed/60)).padStart(2,"0")}:${String(elapsed%60).padStart(2,"0")}`],
              ["Gate GC #1",  gates.g1],
              ["Gate GC #2",  gates.g2],
              ["Corridas",    String(simCount)],
              ["Intentos G1", String(attempts.g1)],
            ].map(([k, v]) => (
              <div key={k as string} className="flex justify-between py-0.5 border-b border-[#1a1f27] last:border-0">
                <span className="text-slate-500 text-[10px]">{k}</span>
                <span className={`text-[10px] font-mono ${
                  v === "VALIDATED" ? "text-emerald-400" :
                  v === "FAILED"    ? "text-red-400" :
                  v === "PENDING"   ? "text-amber-400" :
                  "text-slate-300"
                }`}>{v}</span>
              </div>
            ))}
          </div>

          {/* Tutor IA */}
          <div className="bg-[#0f1923] border border-[#1d3a5c] rounded-md p-2">
            <p className="text-blue-400 text-[10px] uppercase tracking-widest mb-2">🤖 Tutor IA — GC</p>
            <div className="flex gap-1">
              <input
                disabled={gates.g1 !== "VALIDATED"}
                className="flex-1 bg-[#0d1117] border border-[#21262d] rounded px-2 py-1
                           text-xs text-slate-300 outline-none focus:border-blue-800 disabled:opacity-30"
                placeholder={gates.g1 === "VALIDATED" ? "Pregunta sobre GC…" : "Disponible tras Gate #1"}
              />
              <button disabled={gates.g1 !== "VALIDATED"}
                className="bg-[#1d3a5c] border border-[#1f6feb] text-blue-400 rounded px-2 py-1
                           text-xs disabled:opacity-30 cursor-pointer">↑</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
