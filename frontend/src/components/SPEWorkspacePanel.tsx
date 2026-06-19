/**
 * SPEWorkspacePanel.tsx
 *
 * Panel interactivo para simulación de Extracción en Fase Sólida (SPE).
 * Cubre la Unidad 2 del microcurrículo de Química Farmacéutica:
 *   - Pasos de acondicionamiento, equilibrado, carga de muestra, lavado y elución.
 *   - Selección de tipo de sorbente (C18 y Sílice).
 *   - Visualización de la partición/adsorción cromatográfica de compuestos de polaridades opuestas.
 *   - Cálculo de recuperación y pureza del extracto.
 */

import { useState, useCallback } from "react";
import { BACKEND_URL } from "../config";

// ─── TIPOS ───────────────────────────────────────────────────

type SorbentType = "C18" | "Silica";
type SampleMatrix = "Water" | "Organic";

interface SPEState {
  sorbentType: SorbentType;
  conditioningSolvent: string;
  conditioningVolumeMl: number;
  equilibratingVolumeMl: number;
  loadingVolumeMl: number;
  loadingSampleMatrix: SampleMatrix;
  washingSolvent: string;
  washingOrganicPct: number;
  washingVolumeMl: number;
  elutionSolvent: "MeOH" | "ACN" | "EtOAc";
  elutionOrganicPct: number;
  elutionVolumeMl: number;
  analyteMixture?: string;
}

interface AnalyteResult {
  name: string;
  percent_adsorbed: number;
  percent_washed_out: number;
  percent_recovered: number;
  percent_remaining: number;
}

interface SPEMetrics {
  sorbent_type: string;
  conditioning_factor: number;
  analyte_a: AnalyteResult;
  analyte_b: AnalyteResult;
  purity_a_pct: number;
  purity_b_pct: number;
  warnings: string[];
  errors: string[];
}

const ANALYTE_MIXTURES: Record<string, { analyte_a: string; analyte_b: string }> = {
  "Paracetamol + Ibuprofeno": { analyte_a: "Paracetamol", analyte_b: "Ibuprofeno" },
  "Cafeína + Loratadina": { analyte_a: "Cafeína", analyte_b: "Loratadina" },
  "Ácido Acetilsalicílico + Naproxeno": { analyte_a: "Ácido Acetilsalicílico", analyte_b: "Naproxeno" },
  "Ranitidina + Omeprazol": { analyte_a: "Ranitidina", analyte_b: "Omeprazol" }
};

const SPE_ANALYTE_COEFFS: Record<string, Record<SorbentType, { k_w_A: number; S_A: number; k_w_B: number; S_B: number }>> = {
  "Paracetamol + Ibuprofeno": {
    C18: { k_w_A: 15.0, S_A: 2.6, k_w_B: 180.0, S_B: 3.2 },
    Silica: { k_w_A: 120.0, S_A: 3.0, k_w_B: 5.0, S_B: 1.2 }
  },
  "Cafeína + Loratadina": {
    C18: { k_w_A: 10.0, S_A: 2.3, k_w_B: 300.0, S_B: 3.5 },
    Silica: { k_w_A: 100.0, S_A: 2.5, k_w_B: 3.0, S_B: 1.0 }
  },
  "Ácido Acetilsalicílico + Naproxeno": {
    C18: { k_w_A: 18.0, S_A: 2.8, k_w_B: 140.0, S_B: 2.9 },
    Silica: { k_w_A: 110.0, S_A: 2.8, k_w_B: 6.0, S_B: 1.1 }
  },
  "Ranitidina + Omeprazol": {
    C18: { k_w_A: 8.0, S_A: 2.2, k_w_B: 110.0, S_B: 2.7 },
    Silica: { k_w_A: 90.0, S_A: 2.4, k_w_B: 8.0, S_B: 1.2 }
  }
};

const SPE_INITIAL: SPEState = {
  sorbentType: "C18",
  conditioningSolvent: "MeOH",
  conditioningVolumeMl: 2.0,
  equilibratingVolumeMl: 2.0,
  loadingVolumeMl: 1.0,
  loadingSampleMatrix: "Water",
  washingSolvent: "H2O",
  washingOrganicPct: 5.0,
  washingVolumeMl: 1.5,
  elutionSolvent: "MeOH",
  elutionOrganicPct: 80.0,
  elutionVolumeMl: 2.0,
  analyteMixture: "Paracetamol + Ibuprofeno"
};

// ─── MOTOR LOCAL FALLBACK SPE ─────────────────────────────────

function localSPESimulation(s: SPEState): SPEMetrics {
  const V_m = 0.3;
  let cond_factor = 1.0;
  const warnings: string[] = [];
  const errors: string[] = [];

  if (s.sorbentType === "C18") {
    if (!["MeOH", "ACN"].includes(s.conditioningSolvent)) {
      cond_factor = 0.25;
      warnings.push("Acondicionamiento C18 deficiente: Se requieren solventes orgánicos para solvatar las cadenas C18.");
    } else if (s.conditioningVolumeMl < 1.0) {
      cond_factor = 0.5 + 0.5 * s.conditioningVolumeMl;
      warnings.push("Volumen de acondicionamiento muy bajo. Sorbente parcialmente solvatado.");
    }
    if (s.equilibratingVolumeMl < 1.0) {
      cond_factor *= 0.5;
      warnings.push("Falta de equilibrado con agua: El solvente remanente provocará fugas al cargar la muestra.");
    }
  } else {
    if (!["Hexano", "EtOAc"].includes(s.conditioningSolvent)) {
      cond_factor = 0.3;
      warnings.push("Acondicionamiento Sílice deficiente: Solventes polares desactivan los silanoles activos.");
    }
  }

  // Resolve analyte names based on mixture
  const mixKey = s.analyteMixture || "Paracetamol + Ibuprofeno";
  const mix = ANALYTE_MIXTURES[mixKey] || ANALYTE_MIXTURES["Paracetamol + Ibuprofeno"];
  const analyte_a_name = mix.analyte_a;
  const analyte_b_name = mix.analyte_b;

  // Coeficientes de reparto
  const coeffs = SPE_ANALYTE_COEFFS[mixKey]?.[s.sorbentType] || SPE_ANALYTE_COEFFS["Paracetamol + Ibuprofeno"][s.sorbentType];
  const k_w_A = coeffs.k_w_A;
  const S_A = coeffs.S_A;
  const k_w_B = coeffs.k_w_B;
  const S_B = coeffs.S_B;

  // Carga
  let ads_A = 0.0, ads_B = 0.0;
  if (s.sorbentType === "C18" && s.loadingSampleMatrix === "Organic") {
    warnings.push("Error crítico: Cargar muestra en matriz orgánica en C18 eluye todo inmediatamente.");
  } else if (s.sorbentType === "Silica" && s.loadingSampleMatrix === "Water") {
    warnings.push("Error crítico: Cargar muestra acuosa en cartucho de sílice desactiva la fase activa.");
  } else {
    const V_R_load_a = V_m * (1.0 + k_w_A) * cond_factor;
    const V_R_load_b = V_m * (1.0 + k_w_B) * cond_factor;

    const normal_cdf = (x: number, m: number, std: number) => {
      return 0.5 * (1 + Math.sin(Math.min(Math.max((x - m) / (std * 2.5), -Math.PI/2), Math.PI/2)));
    };

    const leak_load_a = normal_cdf(s.loadingVolumeMl, V_R_load_a, 0.2 * V_R_load_a);
    const leak_load_b = normal_cdf(s.loadingVolumeMl, V_R_load_b, 0.2 * V_R_load_b);

    ads_A = 100.0 * (1 - leak_load_a);
    ads_B = 100.0 * (1 - leak_load_b);
  }

  // Lavado
  const C_wash = s.washingOrganicPct / 100.0;
  const k_wash_a = k_w_A * Math.pow(10, -S_A * C_wash);
  const k_wash_b = k_w_B * Math.pow(10, -S_B * C_wash);
  
  const V_R_wash_a = V_m * (1.0 + k_wash_a) * cond_factor;
  const V_R_wash_b = V_m * (1.0 + k_wash_b) * cond_factor;

  const V_total_wash = s.loadingVolumeMl + s.washingVolumeMl;

  const normal_cdf_wash = (x: number, m: number, std: number) => {
    return 0.5 * (1 + Math.sin(Math.min(Math.max((x - m) / (std * 2.5), -Math.PI/2), Math.PI/2)));
  };

  const fuga_wash_a = normal_cdf_wash(V_total_wash, V_R_wash_a, 0.2 * V_R_wash_a);
  const fuga_wash_b = normal_cdf_wash(V_total_wash, V_R_wash_b, 0.2 * V_R_wash_b);

  const lost_wash_A = Math.max(0.0, ads_A * fuga_wash_a);
  const lost_wash_B = Math.max(0.0, ads_B * fuga_wash_b);

  const retained_A = Math.max(0.0, ads_A - lost_wash_A);
  const retained_B = Math.max(0.0, ads_B - lost_wash_B);

  // Elución
  const C_elu = s.elutionOrganicPct / 100.0;
  const k_elu_a = k_w_A * Math.pow(10, -S_A * C_elu);
  const k_elu_b = k_w_B * Math.pow(10, -S_B * C_elu);

  const V_R_elu_a = V_m * (1.0 + k_elu_a) * cond_factor;
  const V_R_elu_b = V_m * (1.0 + k_elu_b) * cond_factor;

  const normal_cdf_elu = (x: number, m: number, std: number) => {
    return 0.5 * (1 + Math.sin(Math.min(Math.max((x - m) / (std * 2.5), -Math.PI/2), Math.PI/2)));
  };

  const elu_a = normal_cdf_elu(s.elutionVolumeMl, V_R_elu_a, 0.25 * V_R_elu_a);
  const elu_b = normal_cdf_elu(s.elutionVolumeMl, V_R_elu_b, 0.25 * V_R_elu_b);

  const recovered_A = retained_A * elu_a;
  const recovered_B = retained_B * elu_b;

  if (s.sorbentType === "C18") {
    if (s.washingOrganicPct > 25.0 && recovered_A < 50.0) {
      warnings.push(`Lavado excesivo: El solvente de lavado eluyó el ${analyte_a_name}, perdiéndose en este paso.`);
    }
    if (s.elutionOrganicPct < 60.0 && recovered_B < 50.0) {
      warnings.push(`Elución débil: % orgánico muy bajo para eluir el ${analyte_b_name}, quedando atrapado en el cartucho.`);
    }
  }

  const total = recovered_A + recovered_B;

  return {
    sorbent_type: s.sorbentType,
    conditioning_factor: cond_factor,
    analyte_a: {
      name: analyte_a_name,
      percent_adsorbed: ads_A,
      percent_washed_out: lost_wash_A,
      percent_recovered: recovered_A,
      percent_remaining: retained_A - recovered_A
    },
    analyte_b: {
      name: analyte_b_name,
      percent_adsorbed: ads_B,
      percent_washed_out: lost_wash_B,
      percent_recovered: recovered_B,
      percent_remaining: retained_B - recovered_B
    },
    purity_a_pct: total > 0 ? (recovered_A / total) * 100.0 : 0.0,
    purity_b_pct: total > 0 ? (recovered_B / total) * 100.0 : 0.0,
    warnings,
    errors
  };
}

// ─── COMPONENTE BARRA DE RESULTADOS ───────────────────────────

function ResultBar({ name, data }: { name: string; data: AnalyteResult }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px] font-bold">
        <span>{name}</span>
        <span className="text-emerald-400">Recuperado: {data.percent_recovered.toFixed(1)}%</span>
      </div>
      <div className="w-full bg-[#161b22] border border-[#21262d] rounded-lg h-5 flex overflow-hidden">
        {/* Recuperado */}
        <div
          style={{ width: `${data.percent_recovered}%` }}
          className="bg-emerald-600 h-full flex items-center justify-center text-[9px] font-bold text-white transition-all duration-500"
          title="Porcentaje Recuperado en Elución"
        >
          {data.percent_recovered > 10 ? `${data.percent_recovered.toFixed(0)}%` : ""}
        </div>
        {/* Perdido en Lavado */}
        <div
          style={{ width: `${data.percent_washed_out}%` }}
          className="bg-amber-600 h-full flex items-center justify-center text-[9px] font-bold text-white transition-all duration-500"
          title="Perdido en el Lavado"
        >
          {data.percent_washed_out > 10 ? `${data.percent_washed_out.toFixed(0)}%` : ""}
        </div>
        {/* Retenido / No eluido */}
        <div
          style={{ width: `${data.percent_remaining}%` }}
          className="bg-purple-600 h-full flex items-center justify-center text-[9px] font-bold text-white transition-all duration-500"
          title="Quedó en el cartucho"
        >
          {data.percent_remaining > 10 ? `${data.percent_remaining.toFixed(0)}%` : ""}
        </div>
        {/* No adsorbido */}
        <div
          style={{ width: `${100 - data.percent_adsorbed}%` }}
          className="bg-red-800 h-full flex items-center justify-center text-[9px] font-bold text-white transition-all duration-500"
          title="Fuga en la Carga"
        >
          {(100 - data.percent_adsorbed) > 10 ? `${(100 - data.percent_adsorbed).toFixed(0)}%` : ""}
        </div>
      </div>
    </div>
  );
}

// ─── MAIN COMPONENT ──────────────────────────────────────────

export default function SPEWorkspacePanel({
  sessionId,
  onSimulationUpdate
}: {
  sessionId: string;
  onSimulationUpdate?: (metrics: any) => void;
}) {
  const [state, setState] = useState<SPEState>(SPE_INITIAL);
  const [metrics, setMetrics] = useState<SPEMetrics>(() => localSPESimulation(SPE_INITIAL));
  const [wsStatus, setWsStatus] = useState<"connected" | "disconnected">("disconnected");

  const runSimulation = useCallback(async (currentState: SPEState) => {
    // 1. Simulación Local Fallback
    const m = localSPESimulation(currentState);
    setMetrics(m);
    onSimulationUpdate?.(m);

    // 2. Intentar API HTTP del Backend
    try {
      const res = await fetch(`${BACKEND_URL}/api/hplc/spe/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          sorbent_type: currentState.sorbentType,
          conditioning_solvent: currentState.conditioningSolvent,
          conditioning_volume_ml: currentState.conditioningVolumeMl,
          equilibrating_volume_ml: currentState.equilibratingVolumeMl,
          loading_volume_ml: currentState.loadingVolumeMl,
          loading_sample_matrix: currentState.loadingSampleMatrix,
          washing_solvent: currentState.washingSolvent,
          washing_organic_pct: currentState.washingOrganicPct,
          washing_volume_ml: currentState.washingVolumeMl,
          elution_solvent: currentState.elutionSolvent,
          elution_organic_pct: currentState.elutionOrganicPct,
          elution_volume_ml: currentState.elutionVolumeMl,
          analyte_mixture: currentState.analyteMixture || "Paracetamol + Ibuprofeno"
        })
      });
      if (res.ok) {
        const data = await res.json();
        setMetrics(data.result);
        onSimulationUpdate?.(data.result);
        setWsStatus("connected");
      }
    } catch (e) {
      setWsStatus("disconnected");
    }
  }, [sessionId, onSimulationUpdate]);

  const updateField = <K extends keyof SPEState>(key: K, value: SPEState[K]) => {
    setState(prev => {
      const next = { ...prev, [key]: value };
      runSimulation(next);
      return next;
    });
  };

  return (
    <div className="bg-[#0d1117] text-slate-300 font-mono text-xs rounded-xl p-4 border border-[#21262d] space-y-4">
      
      {/* HEADER */}
      <div className="flex items-center justify-between border-b border-[#21262d] pb-3">
        <div className="flex items-center gap-2">
          <span className="text-emerald-400 text-sm">🧪 Extracción en Fase Sólida (SPE)</span>
          <span className="bg-[#161b22] border border-[#30363d] rounded px-2.5 py-0.5 text-slate-500 text-[10px]">
            Unidad 2: Preparación de Muestras Farmacéuticas
          </span>
          <span className="text-[10px] text-slate-600 font-sans">
            API: {wsStatus === "connected" ? "🟢 Conectado" : "🟡 Modo Local"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_310px] gap-4">
        
        {/* PARTE IZQUIERDA: CONTROLES POR PASOS */}
        <div className="space-y-3">
          
          {/* PASO 1 Y 2: Sorbente y Acondicionamiento */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-2">
            <p className="text-[10px] text-slate-500 font-bold border-b border-[#21262d] pb-1 uppercase">
              Paso 1: Acondicionamiento y Equilibrado
            </p>
            
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-slate-500 font-bold block mb-1">Tipo de Cartucho:</label>
                <select
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1.5 text-slate-300 outline-none"
                  value={state.sorbentType}
                  onChange={e => updateField("sorbentType", e.target.value as SorbentType)}
                >
                  <option value="C18">Fase Reversa C18 (Octadecilsilano)</option>
                  <option value="Silica">Fase Normal Sílice (Silanoles Activos)</option>
                </select>
              </div>

              <div>
                <label className="text-slate-500 font-bold block mb-1">Solvente Acondicionamiento:</label>
                <select
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1.5 text-slate-300 outline-none"
                  value={state.conditioningSolvent}
                  onChange={e => updateField("conditioningSolvent", e.target.value)}
                >
                  <option value="MeOH">Metanol (MeOH)</option>
                  <option value="ACN">Acetonitrilo (ACN)</option>
                  <option value="H2O">Agua Destilada (H2O)</option>
                  <option value="Hexano">Hexano (Normal Phase)</option>
                </select>
              </div>
            </div>

            <div className="pt-2 border-t border-[#21262d]">
              <label className="text-slate-500 font-bold block mb-1">Mezcla USP (Muestra):</label>
              <select
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1.5 text-slate-300 outline-none"
                value={state.analyteMixture || "Paracetamol + Ibuprofeno"}
                onChange={e => updateField("analyteMixture", e.target.value)}
              >
                {Object.keys(ANALYTE_MIXTURES).map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Vol. Acond. (mL):</span>
                <input
                  type="number" step="0.5" min="0" max="10"
                  className="w-16 bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 text-right text-emerald-400 outline-none"
                  value={state.conditioningVolumeMl}
                  onChange={e => updateField("conditioningVolumeMl", Number(e.target.value))}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Vol. Equil. H2O (mL):</span>
                <input
                  type="number" step="0.5" min="0" max="10"
                  className="w-16 bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 text-right text-emerald-400 outline-none"
                  value={state.equilibratingVolumeMl}
                  onChange={e => updateField("equilibratingVolumeMl", Number(e.target.value))}
                />
              </div>
            </div>
          </div>

          {/* PASO 3: Carga de Muestra */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-2">
            <p className="text-[10px] text-slate-500 font-bold border-b border-[#21262d] pb-1 uppercase">
              Paso 2: Carga del Analito
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-slate-500 font-bold block mb-1">Matriz de Carga:</label>
                <select
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1.5 text-slate-300 outline-none"
                  value={state.loadingSampleMatrix}
                  onChange={e => updateField("loadingSampleMatrix", e.target.value as SampleMatrix)}
                >
                  <option value="Water">Acuosa (Agua/Amortiguador)</option>
                  <option value="Organic">Orgánica (Metanol puro/ACN)</option>
                </select>
              </div>
              <div className="flex items-center justify-between gap-2 pt-4">
                <span className="text-slate-500">Vol. de Carga (mL):</span>
                <input
                  type="number" step="0.5" min="0.1" max="10"
                  className="w-16 bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 text-right text-emerald-400 outline-none"
                  value={state.loadingVolumeMl}
                  onChange={e => updateField("loadingVolumeMl", Number(e.target.value))}
                />
              </div>
            </div>
          </div>

          {/* PASO 4: Lavado */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-2">
            <p className="text-[10px] text-slate-500 font-bold border-b border-[#21262d] pb-1 uppercase">
              Paso 3: Lavado selectivo de Impurezas
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-slate-500 block mb-1">Disolvente de Lavado:</label>
                <select
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1.5 text-slate-300 outline-none"
                  value={state.washingSolvent}
                  onChange={e => updateField("washingSolvent", e.target.value)}
                >
                  <option value="H2O">Agua pura (Debilidad Máxima)</option>
                  <option value="MeOH">Mezcla Metanol/Agua</option>
                  <option value="ACN">Mezcla Acetonitrilo/Agua</option>
                </select>
              </div>

              {state.washingSolvent !== "H2O" && (
                <div>
                  <label className="text-slate-500 block mb-1">% Solvente Orgánico:</label>
                  <input
                    type="range" min="0" max="60" step="5"
                    className="w-full accent-emerald-500"
                    value={state.washingOrganicPct}
                    onChange={e => updateField("washingOrganicPct", Number(e.target.value))}
                  />
                  <p className="text-right text-[10px] text-emerald-400 font-mono mt-0.5">{state.washingOrganicPct}% orgánico</p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-slate-500">Volumen de lavado (mL):</span>
              <input
                type="number" step="0.5" min="0" max="10"
                className="w-16 bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 text-right text-emerald-400 outline-none"
                value={state.washingVolumeMl}
                onChange={e => updateField("washingVolumeMl", Number(e.target.value))}
              />
            </div>
          </div>

          {/* PASO 5: Elución */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-2">
            <p className="text-[10px] text-slate-500 font-bold border-b border-[#21262d] pb-1 uppercase">
              Paso 4: Elución del compuesto purificado
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-slate-500 block mb-1">Disolvente Eluyente:</label>
                <select
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1.5 text-slate-300 outline-none"
                  value={state.elutionSolvent}
                  onChange={e => updateField("elutionSolvent", e.target.value as any)}
                >
                  <option value="MeOH">Metanol (MeOH)</option>
                  <option value="ACN">Acetonitrilo (ACN)</option>
                  <option value="EtOAc">Acetato de Etilo (EtOAc)</option>
                </select>
              </div>

              <div>
                <label className="text-slate-500 block mb-1">% de Elución:</label>
                <input
                  type="range" min="30" max="100" step="5"
                  className="w-full accent-emerald-500"
                  value={state.elutionOrganicPct}
                  onChange={e => updateField("elutionOrganicPct", Number(e.target.value))}
                />
                <p className="text-right text-[10px] text-emerald-400 font-mono mt-0.5">{state.elutionOrganicPct}% orgánico</p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-slate-500">Volumen de elución (mL):</span>
              <input
                type="number" step="0.5" min="0.5" max="10"
                className="w-16 bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 text-right text-emerald-400 outline-none"
                value={state.elutionVolumeMl}
                onChange={e => updateField("elutionVolumeMl", Number(e.target.value))}
              />
            </div>
          </div>

        </div>

        {/* PARTE DERECHA: MONITOREO DEL CARTUCHO Y RESULTADOS */}
        <div className="space-y-3">
          
          {/* ILUSTRACIÓN CARTUCHO */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 flex flex-col items-center">
            <span className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1 w-full text-left mb-3">
              Cartucho SPE (Sorbente {metrics.sorbent_type})
            </span>
            
            <div className="w-14 h-28 border-2 border-slate-500 rounded-b-xl relative bg-slate-900 flex flex-col justify-end overflow-hidden">
              {/* Líquido de solvente arriba */}
              <div className="h-6 w-full bg-emerald-500/20 absolute top-0 animate-pulse border-b border-emerald-700/40" />
              {/* Lecho de C18/Silica */}
              <div className="h-16 w-full border-t border-slate-600 flex flex-col justify-around p-1 text-[8px] font-bold text-center"
                   style={{
                     backgroundColor: state.sorbentType === "C18" ? "#1d2025" : "#ded9d2",
                     color: state.sorbentType === "C18" ? "#888" : "#222"
                   }}>
                <span>{state.sorbentType}</span>
                <span className="text-[7px]">Act: {(metrics.conditioning_factor * 100).toFixed(0)}%</span>
              </div>
            </div>
            
            <p className="text-[10px] text-slate-500 mt-2 text-center leading-relaxed">
              Factor Acondicionamiento: <strong className="text-white">{metrics.conditioning_factor.toFixed(2)}</strong>
            </p>
          </div>

          {/* GRÁFICOS DE RECUPERACIÓN */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3 space-y-3">
            <span className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1 block">
              Resultados de Partición
            </span>

            <ResultBar name={`${metrics.analyte_a.name} (Polar)`} data={metrics.analyte_a} />
            <ResultBar name={`${metrics.analyte_b.name} (Apolar)`} data={metrics.analyte_b} />

            <div className="bg-[#0d1117] border border-[#21262d] rounded-lg p-2 grid grid-cols-2 gap-2 text-[10px]">
              <div>
                <p className="text-slate-500 font-bold">Pureza {metrics.analyte_a.name}:</p>
                <p className="text-emerald-400 font-extrabold text-sm font-mono">{metrics.purity_a_pct.toFixed(1)}%</p>
              </div>
              <div>
                <p className="text-slate-500 font-bold">Pureza {metrics.analyte_b.name}:</p>
                <p className="text-emerald-400 font-extrabold text-sm font-mono">{metrics.purity_b_pct.toFixed(1)}%</p>
              </div>
            </div>
            
            {/* LEYENDA */}
            <div className="grid grid-cols-2 gap-1 text-[8px] text-slate-500 font-mono pt-1">
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />Recuperado</span>
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-600" />Perdido Wash</span>
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-purple-600" />Quedó Cartucho</span>
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-800" />No retenido</span>
            </div>
          </div>

          {/* ADVERTENCIAS PEDAGÓGICAS */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-3">
            <span className="text-[10px] uppercase text-slate-500 font-bold border-b border-[#21262d] pb-1 block mb-2">
              Errores / Feedback
            </span>
            {metrics.warnings.length === 0 ? (
              <p className="text-emerald-500 text-[10px]">✓ Método SPE optimizado.</p>
            ) : (
              <div className="space-y-1 max-h-36 overflow-y-auto">
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

    </div>
  );
}
