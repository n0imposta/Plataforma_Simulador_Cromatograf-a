/**
 * VanDeemterChart.tsx
 *
 * Visualizador interactivo de curvas de eficiencia cromatográfica.
 *
 * Modo HPLC: Ecuación de van Deemter  HETP = A + B/u + C·u
 * Modo GC:   Ecuación de Golay        HETP = B/u + (Cm + Cs)·u
 *
 * Características:
 *   - Curva total + 3 contribuciones individuales en colores distintos
 *   - Marcador interactivo de punto óptimo (u_opt, HETP_mín)
 *   - Comparación simultánea He / H₂ / N₂ en modo GC
 *   - Superposición del punto de operación actual del estudiante
 *   - Panel educativo: explicación de cada término al hacer hover
 *   - Integración con Gate HITL: desbloqueado solo tras Gate #1 validado
 *   - Tooltip técnico con todos los valores en el cursor
 */

import { useState, useEffect, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
  Legend,
} from "recharts";

// ─── TIPOS ───────────────────────────────────────────────────

type Technique = "HPLC" | "UHPLC" | "GC";
type CarrierGas = "He" | "H2" | "N2";

interface VDPoint {
  u: number;
  total: number;
  A?: number;      // solo HPLC
  B_term: number;
  C_term?: number; // solo HPLC
  Cm_term?: number;// solo GC
  Cs_term?: number;// solo GC
  u_opt?: boolean;
}

interface GasComparePoint {
  u: number;
  He?: number;
  H2?: number;
  N2?: number;
}

interface ColumnOption {
  key: string;
  label: string;
  particleUm?: number;
  lengthMm?: number;
  idMm?: number;
  filmUm?: number;
  phase: string;
}

interface OperatingPoint {
  u: number;
  hetp: number;
  label: string;
}

// ─── CONSTANTES FÍSICAS (motor JS inline) ────────────────────

const GAS_PROPS: Record<CarrierGas, { Dm25: number; eta25: number; etaExp: number; color: string; label: string; symbol: string }> = {
  He: { Dm25: 0.42, eta25: 19.9, etaExp: 0.67, color: "#58a6ff", label: "Helio", symbol: "He" },
  H2: { Dm25: 0.68, eta25: 8.9,  etaExp: 0.67, color: "#3fb950", label: "Hidrógeno", symbol: "H₂" },
  N2: { Dm25: 0.18, eta25: 17.9, etaExp: 0.67, color: "#d29922", label: "Nitrógeno", symbol: "N₂" },
};

const HPLC_COLUMNS: ColumnOption[] = [
  { key: "C18_3um",  label: "C18 150×4.6mm, 3μm", particleUm: 3.0, lengthMm: 150, idMm: 4.6, phase: "C18" },
  { key: "C18_5um",  label: "C18 150×4.6mm, 5μm", particleUm: 5.0, lengthMm: 150, idMm: 4.6, phase: "C18" },
  { key: "C18_1.7um",label: "C18 100×2.1mm, 1.7μm (UHPLC)", particleUm: 1.7, lengthMm: 100, idMm: 2.1, phase: "C18" },
];

const GC_COLUMNS: ColumnOption[] = [
  { key: "DB5_30m",  label: "DB-5 30m×0.25mm×0.25μm",  idMm: 0.25, filmUm: 0.25, lengthMm: 30000, phase: "DB-5" },
  { key: "DB5_60m",  label: "DB-1 60m×0.25mm×0.25μm",  idMm: 0.25, filmUm: 0.25, lengthMm: 60000, phase: "DB-1" },
  { key: "DBWAX",    label: "DB-WAX 30m×0.25mm×0.25μm", idMm: 0.25, filmUm: 0.25, lengthMm: 30000, phase: "DB-WAX" },
];

// ─── MOTOR FÍSICO INLINE (JS) ─────────────────────────────────

function computeDm(gas: CarrierGas, tempC: number): number {
  const g = GAS_PROPS[gas];
  const T = tempC + 273.15;
  return g.Dm25 * (T / 298.15) ** 1.75; // cm²/s (P≈1 atm)
}

function hplcVanDeemter(u_mm_min: number, dp_mm: number, Dm_cm2_s: number): VDPoint {
  const Dm = Dm_cm2_s * 100; // mm²/min
  const A = 2.0 * dp_mm;
  const B = 2.0 * 0.6 * Dm;
  const C = dp_mm ** 2 / (30.0 * Dm);
  const total = A + B / u_mm_min + C * u_mm_min;
  return {
    u: u_mm_min,
    total,
    A,
    B_term: B / u_mm_min,
    C_term: C * u_mm_min,
  };
}

function gcGolay(
  u_cm_s: number,
  dc_mm: number,
  df_um: number,
  gas: CarrierGas,
  tempC: number,
  kPrime: number,
): VDPoint {
  const Dm = computeDm(gas, tempC) * 100; // mm²/s
  const Ds = Dm / 1000;
  const dc = dc_mm;
  const df = df_um * 1e-3; // μm → mm
  const u = u_cm_s * 10;  // cm/s → mm/s

  const B  = 2 * Dm;
  const Cm = dc**2 * (1 + 6*kPrime + 11*kPrime**2) / (96 * Dm * (1 + kPrime)**2);
  const Cs = 2 * kPrime * df**2 / (3 * Ds * (1 + kPrime)**2);
  const total = B / u + (Cm + Cs) * u;

  return {
    u: u_cm_s,
    total,
    B_term: B / u,
    Cm_term: Cm * u,
    Cs_term: Cs * u,
  };
}

function findUopt(points: VDPoint[]): number {
  let minH = Infinity, uOpt = 0;
  for (const p of points) {
    if (p.total < minH) { minH = p.total; uOpt = p.u; }
  }
  return uOpt;
}

// ─── SUB-COMPONENTS ──────────────────────────────────────────

/** Tooltip personalizado para la curva */
function VDTooltip({
  active, payload, label, technique,
}: {
  active?: boolean; payload?: any[]; label?: string; technique: Technique;
}) {
  if (!active || !payload?.length) return null;
  const isGC = technique === "GC";
  const uUnit = isGC ? "cm/s" : "mm/min";
  return (
    <div className="bg-[#161b22] border border-[#30363d] rounded px-3 py-2 font-mono text-[11px] shadow-xl">
      <p className="text-slate-400 border-b border-[#21262d] pb-1 mb-1">
        u = {Number(label).toFixed(2)} {uUnit}
      </p>
      {payload.map((p: any) => (
        <p key={p.dataKey} style={{ color: p.color }} className="leading-relaxed">
          {p.name}: {Number(p.value).toFixed(4)} mm
        </p>
      ))}
    </div>
  );
}

/** Leyenda de términos de la ecuación */
function EquationLegend({ technique, hoveredTerm, onHover }: {
  technique: Technique;
  hoveredTerm: string | null;
  onHover: (term: string | null) => void;
}) {
  const terms = technique === "GC"
    ? [
        { key: "B_term",  color: "#f85149", label: "B/u",  eq: "B/ū = 2Dm/ū", desc: "Difusión longitudinal — dominante a velocidades bajas" },
        { key: "Cm_term", color: "#d29922", label: "Cm·u", eq: "Cm·ū", desc: "Transferencia de masa en fase móvil — depende de dc²/Dm" },
        { key: "Cs_term", color: "#a371f7", label: "Cs·u", eq: "Cs·ū", desc: "Transferencia de masa en fase estacionaria — depende de df²/Ds" },
        { key: "total",   color: "#e6edf3", label: "Total", eq: "HETP", desc: "Suma total — el mínimo define u_opt" },
      ]
    : [
        { key: "A",      color: "#f85149", label: "A",    eq: "A = 2λdp", desc: "Difusión por Eddy — independiente de u, solo de empaque" },
        { key: "B_term", color: "#d29922", label: "B/u",  eq: "B/u = 2γDm/u", desc: "Difusión longitudinal — dominante a u bajas" },
        { key: "C_term", color: "#a371f7", label: "C·u",  eq: "Cu = dp²u/Dm", desc: "Resistencia a transferencia de masa — dominante a u altas" },
        { key: "total",  color: "#e6edf3", label: "Total", eq: "HETP", desc: "van Deemter total — mínimo en u_opt" },
      ];

  return (
    <div className="space-y-1">
      {terms.map(t => (
        <div
          key={t.key}
          className={`flex items-start gap-2 p-1.5 rounded cursor-pointer transition-colors ${
            hoveredTerm === t.key ? "bg-[#21262d]" : "hover:bg-[#161b22]"
          }`}
          onMouseEnter={() => onHover(t.key)}
          onMouseLeave={() => onHover(null)}
        >
          <div className="w-3 h-3 rounded-full mt-0.5 shrink-0" style={{ background: t.color }} />
          <div>
            <p className="font-mono font-bold text-[11px]" style={{ color: t.color }}>
              {t.label} <span className="text-slate-600">— {t.eq}</span>
            </p>
            {hoveredTerm === t.key && (
              <p className="text-slate-400 text-[10px] leading-relaxed mt-0.5">{t.desc}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── MAIN COMPONENT ──────────────────────────────────────────

export default function VanDeemterChart({
  technique,
  initialColumnKey,
  operatingPoint,
  gateUnlocked = false,
  onOptimalVelocityFound,
}: {
  technique: Technique;
  initialColumnKey?: string;
  operatingPoint?: OperatingPoint;
  gateUnlocked?: boolean;
  onOptimalVelocityFound?: (u_opt: number, hetp_min: number) => void;
}) {
  const isGC = technique === "GC";

  // ── State ──
  const [selectedCol, setSelectedCol] = useState(
    initialColumnKey ?? (isGC ? "DB5_30m" : "C18_3um")
  );
  const [kPrime, setKPrime] = useState(isGC ? 5.0 : 3.2);
  const [tempC, setTempC] = useState(isGC ? 150.0 : 30.0);
  const [hoveredTerm, setHoveredTerm] = useState<string | null>(null);
  const [showGasCompare, setShowGasCompare] = useState(false);
  const [selectedGas, setSelectedGas] = useState<CarrierGas>("He");
  const [showOptimalMarker, setShowOptimalMarker] = useState(true);

  // ── Compute curve data ──
  const curveData = useMemo<VDPoint[]>(() => {
    if (isGC) {
      const col = GC_COLUMNS.find(c => c.key === selectedCol) ?? GC_COLUMNS[0];
      const uRange = [5, 80];
      const n = 100;
      return Array.from({ length: n }, (_, i) => {
        const u = uRange[0] + (uRange[1] - uRange[0]) * i / (n - 1);
        return gcGolay(u, col.idMm!, col.filmUm!, selectedGas, tempC, kPrime);
      });
    } else {
      const col = HPLC_COLUMNS.find(c => c.key === selectedCol) ?? HPLC_COLUMNS[0];
      const dp = col.particleUm! * 1e-3;
      const Dm = computeDm("He", tempC);
      const uRange = [0.5, 12.0];
      const n = 100;
      return Array.from({ length: n }, (_, i) => {
        const u = uRange[0] + (uRange[1] - uRange[0]) * i / (n - 1);
        return hplcVanDeemter(u, dp, Dm);
      });
    }
  }, [isGC, selectedCol, kPrime, tempC, selectedGas]);

  // ── Gas comparison data (GC only) ──
  const gasCompareData = useMemo<GasComparePoint[]>(() => {
    if (!isGC || !showGasCompare) return [];
    const col = GC_COLUMNS.find(c => c.key === selectedCol) ?? GC_COLUMNS[0];
    const n = 100;
    const uRange = [5, 80];
    return Array.from({ length: n }, (_, i) => {
      const u = uRange[0] + (uRange[1] - uRange[0]) * i / (n - 1);
      const result: GasComparePoint = { u };
      for (const gas of ["He", "H2", "N2"] as CarrierGas[]) {
        result[gas] = gcGolay(u, col.idMm!, col.filmUm!, gas, tempC, kPrime).total;
      }
      return result;
    });
  }, [isGC, showGasCompare, selectedCol, tempC, kPrime]);

  // ── Optimal point ──
  const uOpt = useMemo(() => {
    const u = findUopt(curveData);
    const hMin = curveData.find(p => p.u === u)?.total ?? 0;
    return { u, hetp: hMin };
  }, [curveData]);

  useEffect(() => {
    if (uOpt.u > 0) onOptimalVelocityFound?.(uOpt.u, uOpt.hetp);
  }, [uOpt]);

  // ── Columns available ──
  const columns = isGC ? GC_COLUMNS : HPLC_COLUMNS;

  // ── HETP display range ──
  const hetpMax = useMemo(() => {
    const max = Math.max(...curveData.map(p => p.total));
    return Math.min(max * 1.2, isGC ? 5.0 : 1.0);
  }, [curveData, isGC]);

  const xUnit = isGC ? "cm/s" : "mm/min";
  const xLabel = `Velocidad lineal ū (${xUnit})`;

  // ── Gate overlay ──
  if (!gateUnlocked) {
    return (
      <div className="bg-[#161b22] border border-[#21262d] rounded-md p-4 flex flex-col items-center justify-center min-h-[300px]">
        <p className="text-4xl mb-3">🔒</p>
        <p className="text-slate-400 font-mono text-sm">Curva de {isGC ? "Golay" : "van Deemter"}</p>
        <p className="text-slate-600 text-xs mt-1">Disponible tras validar Gate #1</p>
      </div>
    );
  }

  return (
    <div className="bg-[#0d1117] border border-[#21262d] rounded-xl p-3 font-mono text-xs">

      {/* HEADER */}
      <div className="flex justify-between items-center mb-3">
        <div>
          <span className="text-slate-300 font-bold">
            Ecuación de {isGC ? "Golay" : "van Deemter"}
          </span>
          <span className="text-slate-600 ml-2 text-[10px]">
            {isGC ? "HETP = B/ū + (Cm + Cs)·ū" : "HETP = A + B/u + C·u"}
          </span>
        </div>
        <div className="flex gap-2">
          {isGC && (
            <button
              onClick={() => setShowGasCompare(g => !g)}
              className={`px-2 py-1 rounded text-[10px] border transition-colors ${
                showGasCompare
                  ? "bg-blue-900/40 border-blue-800 text-blue-400"
                  : "bg-[#161b22] border-[#30363d] text-slate-500"
              }`}
            >
              Comparar gases
            </button>
          )}
          <button
            onClick={() => setShowOptimalMarker(m => !m)}
            className={`px-2 py-1 rounded text-[10px] border transition-colors ${
              showOptimalMarker
                ? "bg-emerald-900/40 border-emerald-800 text-emerald-400"
                : "bg-[#161b22] border-[#30363d] text-slate-500"
            }`}
          >
            u_opt
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_220px] gap-3">
        {/* LEFT: Controles + Gráfico */}
        <div className="space-y-2">

          {/* Controls row */}
          <div className="flex gap-3 flex-wrap">
            {/* Columna */}
            <div className="flex items-center gap-2">
              <label className="text-slate-500 shrink-0">Columna:</label>
              <select
                className="bg-[#161b22] border border-[#30363d] rounded px-2 py-0.5
                           text-slate-300 text-[11px] outline-none focus:border-blue-700"
                value={selectedCol}
                onChange={e => setSelectedCol(e.target.value)}
              >
                {columns.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>

            {/* Gas portador (solo GC) */}
            {isGC && !showGasCompare && (
              <div className="flex items-center gap-2">
                <label className="text-slate-500">Gas:</label>
                {(["He", "H2", "N2"] as CarrierGas[]).map(g => (
                  <button
                    key={g}
                    onClick={() => setSelectedGas(g)}
                    className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                      selectedGas === g
                        ? "text-white border-slate-500 bg-slate-700"
                        : "text-slate-500 border-[#30363d]"
                    }`}
                    style={selectedGas === g ? { borderColor: GAS_PROPS[g].color, color: GAS_PROPS[g].color } : {}}
                  >
                    {GAS_PROPS[g].symbol ?? g}
                  </button>
                ))}
              </div>
            )}

            {/* k' */}
            <div className="flex items-center gap-2">
              <label className="text-slate-500 shrink-0">k' = {kPrime.toFixed(1)}</label>
              <input
                type="range" min={isGC ? 1 : 0.5} max={isGC ? 20 : 10} step={0.5}
                value={kPrime}
                onChange={e => setKPrime(Number(e.target.value))}
                className="w-20"
              />
            </div>

            {/* Temperatura */}
            <div className="flex items-center gap-2">
              <label className="text-slate-500 shrink-0">T = {tempC}°C</label>
              <input
                type="range"
                min={isGC ? 50 : 15} max={isGC ? 300 : 60} step={isGC ? 10 : 5}
                value={tempC}
                onChange={e => setTempC(Number(e.target.value))}
                className="w-20"
              />
            </div>
          </div>

          {/* ── CHART: Curva individual ── */}
          {!showGasCompare && (
            <div className="bg-[#161b22] border border-[#21262d] rounded-md p-2">
              <ResponsiveContainer width="100%" height={230}>
                <LineChart data={curveData} margin={{ top: 8, right: 8, left: -10, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                  <XAxis
                    dataKey="u"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tick={{ fontSize: 9, fill: "#6e7681" }}
                    label={{ value: xLabel, position: "insideBottom", offset: -10, fill: "#6e7681", fontSize: 9 }}
                    tickFormatter={v => v.toFixed(1)}
                  />
                  <YAxis
                    domain={[0, hetpMax]}
                    tick={{ fontSize: 9, fill: "#6e7681" }}
                    label={{ value: "HETP (mm)", angle: -90, position: "insideLeft", fill: "#6e7681", fontSize: 9 }}
                    tickFormatter={v => v.toFixed(3)}
                  />
                  <Tooltip content={<VDTooltip technique={technique} />} />

                  {/* Contribuciones individuales */}
                  {!isGC && (
                    <Line dataKey="A" stroke="#f85149" strokeWidth={1.5}
                      strokeDasharray="4 2" dot={false} name="A (Eddy)"
                      strokeOpacity={hoveredTerm === null || hoveredTerm === "A" ? 1 : 0.2}
                    />
                  )}
                  <Line dataKey="B_term" stroke="#d29922" strokeWidth={1.5}
                    strokeDasharray="4 2" dot={false} name="B/u (Long. diff.)"
                    strokeOpacity={hoveredTerm === null || hoveredTerm === "B_term" ? 1 : 0.2}
                  />
                  {!isGC && (
                    <Line dataKey="C_term" stroke="#a371f7" strokeWidth={1.5}
                      strokeDasharray="4 2" dot={false} name="C·u (Mass transf.)"
                      strokeOpacity={hoveredTerm === null || hoveredTerm === "C_term" ? 1 : 0.2}
                    />
                  )}
                  {isGC && (
                    <>
                      <Line dataKey="Cm_term" stroke="#a371f7" strokeWidth={1.5}
                        strokeDasharray="4 2" dot={false} name="Cm·u (FM)"
                        strokeOpacity={hoveredTerm === null || hoveredTerm === "Cm_term" ? 1 : 0.2}
                      />
                      <Line dataKey="Cs_term" stroke="#ff7b72" strokeWidth={1.5}
                        strokeDasharray="4 2" dot={false} name="Cs·u (FS)"
                        strokeOpacity={hoveredTerm === null || hoveredTerm === "Cs_term" ? 1 : 0.2}
                      />
                    </>
                  )}
                  {/* Curva total */}
                  <Line dataKey="total" stroke="#e6edf3" strokeWidth={2.5}
                    dot={false} name="HETP total"
                    strokeOpacity={hoveredTerm === null || hoveredTerm === "total" ? 1 : 0.3}
                  />

                  {/* Marcador de u_opt */}
                  {showOptimalMarker && (
                    <ReferenceLine
                      x={uOpt.u}
                      stroke="#3fb950"
                      strokeWidth={1.5}
                      strokeDasharray="5 3"
                      label={{
                        value: `u_opt = ${uOpt.u.toFixed(1)} ${xUnit}`,
                        position: "top",
                        fill: "#3fb950",
                        fontSize: 9,
                      }}
                    />
                  )}

                  {/* Punto de operación actual del estudiante */}
                  {operatingPoint && (
                    <ReferenceLine
                      x={operatingPoint.u}
                      stroke="#f85149"
                      strokeWidth={1.5}
                      strokeDasharray="3 3"
                      label={{
                        value: operatingPoint.label,
                        position: "insideTopRight",
                        fill: "#f85149",
                        fontSize: 9,
                      }}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ── CHART: Comparación de gases portadores (GC) ── */}
          {isGC && showGasCompare && gasCompareData.length > 0 && (
            <div className="bg-[#161b22] border border-[#21262d] rounded-md p-2">
              <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">
                Comparación de gases portadores — mismo k' = {kPrime}, T = {tempC}°C
              </p>
              <ResponsiveContainer width="100%" height={230}>
                <LineChart data={gasCompareData} margin={{ top: 8, right: 8, left: -10, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                  <XAxis
                    dataKey="u" type="number" domain={["dataMin", "dataMax"]}
                    tick={{ fontSize: 9, fill: "#6e7681" }}
                    label={{ value: xLabel, position: "insideBottom", offset: -10, fill: "#6e7681", fontSize: 9 }}
                    tickFormatter={v => v.toFixed(0)}
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: "#6e7681" }}
                    label={{ value: "HETP (mm)", angle: -90, position: "insideLeft", fill: "#6e7681", fontSize: 9 }}
                    tickFormatter={v => v.toFixed(3)}
                  />
                  <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 10, color: "#8b949e" }} />
                  {(["He", "H2", "N2"] as CarrierGas[]).map(g => (
                    <Line
                      key={g}
                      dataKey={g}
                      stroke={GAS_PROPS[g].color}
                      strokeWidth={2}
                      dot={false}
                      name={GAS_PROPS[g].label}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
              <div className="bg-[#0d1117] border border-[#21262d] rounded p-2 mt-1">
                <p className="text-[10px] text-slate-500 mb-1">Rangos óptimos de velocidad:</p>
                {(["He", "H2", "N2"] as CarrierGas[]).map(g => (
                  <div key={g} className="flex gap-2 items-center">
                    <div className="w-2 h-2 rounded-full" style={{ background: GAS_PROPS[g].color }} />
                    <span style={{ color: GAS_PROPS[g].color }} className="text-[10px]">
                      {GAS_PROPS[g].label}:
                    </span>
                    <span className="text-slate-500 text-[10px]">
                      {g === "He" ? "20–35" : g === "H2" ? "35–60" : "10–20"} cm/s
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* HITL: pregunta de reflexión */}
          <div className="bg-[#1c1408] border border-amber-900 rounded-md p-2">
            <p className="text-amber-400 text-[10px] uppercase tracking-widest mb-1">
              💡 Reflexión HITL
            </p>
            <p className="text-slate-400 text-[10px] leading-relaxed">
              {isGC
                ? `Con u_opt = ${uOpt.u.toFixed(1)} cm/s para ${GAS_PROPS[selectedGas].label}: ¿por qué H₂ permite operar a mayor velocidad manteniendo la misma eficiencia que He? ¿Qué término de la ecuación de Golay explica esta diferencia?`
                : `Con u_opt = ${uOpt.u.toFixed(1)} mm/min: ¿Qué ocurre con N (platos) si aumentas el flujo un 50% por encima de u_opt? Calcula cuánto aumenta HETP y el impacto en Rs.`
              }
            </p>
          </div>
        </div>

        {/* RIGHT: Panel educativo */}
        <div className="space-y-2">

          {/* Punto óptimo */}
          <div className="bg-[#161b22] border border-emerald-900 rounded-md p-2">
            <p className="text-[10px] uppercase tracking-widest text-emerald-600 mb-2">
              Punto óptimo calculado
            </p>
            <div className="space-y-1">
              {[
                ["u_opt",      `${uOpt.u.toFixed(2)} ${xUnit}`,   "ok"],
                ["HETP_mín",  `${uOpt.hetp.toFixed(4)} mm`,       "ok"],
                ["N_máx",     `${Math.round((isGC ? 30000 : 150) / uOpt.hetp).toLocaleString()}`, "ok"],
              ].map(([k, v, st]) => (
                <div key={k as string} className="flex justify-between">
                  <span className="text-slate-500 text-[10px]">{k}</span>
                  <span className={`font-bold text-[10px] font-mono ${st === "ok" ? "text-emerald-400" : "text-slate-300"}`}>{v}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Leyenda interactiva */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-md p-2">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
              Términos de la ecuación
            </p>
            <EquationLegend
              technique={technique}
              hoveredTerm={hoveredTerm}
              onHover={setHoveredTerm}
            />
          </div>

          {/* Parámetros actuales */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-md p-2">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
              Condiciones actuales
            </p>
            {[
              ["Técnica",   technique],
              ["k'",        kPrime.toFixed(1)],
              ["T columna", `${tempC} °C`],
              ...(isGC
                ? [["Gas portador", GAS_PROPS[selectedGas].label]]
                : [["Fase móvil", "ACN/H₂O"]]
              ),
              [isGC ? "Columna (fase)" : "Fase estacionaria",
               (isGC ? GC_COLUMNS : HPLC_COLUMNS).find(c => c.key === selectedCol)?.phase ?? "—"],
            ].map(([k, v]) => (
              <div key={k as string} className="flex justify-between py-0.5 border-b border-[#21262d] last:border-0">
                <span className="text-slate-500 text-[10px]">{k}</span>
                <span className="text-slate-300 text-[10px] font-mono">{v}</span>
              </div>
            ))}
          </div>

          {/* Nota sobre H₂ vs He vs N₂ */}
          {isGC && (
            <div className="bg-[#0f1923] border border-[#1d3a5c] rounded-md p-2">
              <p className="text-blue-400 text-[10px] uppercase tracking-widest mb-1">
                📚 Concepto clave
              </p>
              <p className="text-slate-400 text-[10px] leading-relaxed">
                H₂ tiene Dm ≈ 1.6× mayor que He. Esto desplaza u_opt a velocidades más altas,
                reduciendo el tiempo de análisis sin sacrificar N.
                N₂ tiene Dm bajo → zona B pronunciada → u_opt estrecho y lento.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
