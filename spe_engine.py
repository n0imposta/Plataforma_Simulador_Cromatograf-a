"""
chromatox/backend/spe_engine.py

Motor de simulación físico-química para Extracción en Fase Sólida (SPE).
Simula los 4 pasos críticos del método:
  1. Acondicionamiento (solvatación y equilibrado)
  2. Carga (adsorción de analitos en matriz acuosa)
  3. Lavado (elución selectiva de interferentes / retención de analito)
  4. Elución (recuperación del analito de interés en solvente fuerte)

Calcula los porcentajes de recuperación y pureza para Paracetamol (polar)
e Ibuprofeno (apolar) en cartuchos C18 (fase reversa) y Sílice (fase normal).
"""

from __future__ import annotations
import math
from dataclasses import dataclass, field
from typing import Literal

@dataclass
class SPEStep:
    solvent: str                             # "MeOH", "ACN", "H2O", "Hexano", "EtOAc"
    volume_ml: float
    organic_pct: float = 0.0                 # Solo para mezclas hidroorgánicas

@dataclass
class SPEParams:
    sorbent_type: Literal["C18", "Silica"]
    conditioning_solvent: str                # "MeOH", "ACN", "Hexano", etc.
    conditioning_volume_ml: float
    equilibrating_volume_ml: float           # Volumen de H2O posterior al solvente orgánico
    loading_volume_ml: float
    loading_sample_matrix: Literal["Water", "Organic"] # Muestra en agua o solvente orgánico
    washing_solvent: str                     # "H2O", "MeOH", "ACN", "Hexano"
    washing_organic_pct: float
    washing_volume_ml: float
    elution_solvent: Literal["MeOH", "ACN", "EtOAc"]
    elution_organic_pct: float
    elution_volume_ml: float
    analyte_a_name: str = "Paracetamol"       # Polar (logP ≈ 0.46)
    analyte_b_name: str = "Ibuprofeno"        # Apolar (logP ≈ 3.5)
    analyte_mixture: str = "Paracetamol + Ibuprofeno"

@dataclass
class SPEAnalyteResult:
    name: str
    percent_adsorbed: float                  # % retenido en carga
    percent_washed_out: float                # % perdido en lavado
    percent_recovered: float                 # % recuperado en elución final
    percent_remaining: float                 # % que se quedó pegado en el cartucho

@dataclass
class SPESimResult:
    sorbent_type: str
    conditioning_factor: float               # Estado de activación del cartucho (0 a 1)
    analyte_a: SPEAnalyteResult
    analyte_b: SPEAnalyteResult
    purity_a_pct: float                      # Pureza del extracto A (si se eluyó fraccionado)
    purity_b_pct: float                      # Pureza del extracto B
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "sorbent_type": self.sorbent_type,
            "conditioning_factor": round(self.conditioning_factor, 3),
            "analyte_a": self.analyte_a.__dict__,
            "analyte_b": self.analyte_b.__dict__,
            "purity_a_pct": round(self.purity_a_pct, 2),
            "purity_b_pct": round(self.purity_b_pct, 2),
            "warnings": self.warnings,
            "errors": self.errors
        }

# Función de distribución acumulativa normal aproximada (CDF) para modelar fugas cromatográficas
def _normal_cdf(x: float, mean: float, std: float) -> float:
    if std <= 0:
        return 1.0 if x >= mean else 0.0
    return 0.5 * (1.0 + math.erf((x - mean) / (std * math.sqrt(2.0))))

SPE_ANALYTE_COEFFS = {
    "Paracetamol + Ibuprofeno": {
        "C18": {"k_w_A": 15.0, "S_A": 2.6, "k_w_B": 180.0, "S_B": 3.2},
        "Silica": {"k_w_A": 120.0, "S_A": 3.0, "k_w_B": 5.0, "S_B": 1.2}
    },
    "Cafeína + Loratadina": {
        "C18": {"k_w_A": 10.0, "S_A": 2.3, "k_w_B": 300.0, "S_B": 3.5},
        "Silica": {"k_w_A": 100.0, "S_A": 2.5, "k_w_B": 3.0, "S_B": 1.0}
    },
    "Ácido Acetilsalicílico + Naproxeno": {
        "C18": {"k_w_A": 18.0, "S_A": 2.8, "k_w_B": 140.0, "S_B": 2.9},
        "Silica": {"k_w_A": 110.0, "S_A": 2.8, "k_w_B": 6.0, "S_B": 1.1}
    },
    "Ranitidina + Omeprazol": {
        "C18": {"k_w_A": 8.0, "S_A": 2.2, "k_w_B": 110.0, "S_B": 2.7},
        "Silica": {"k_w_A": 90.0, "S_A": 2.4, "k_w_B": 8.0, "S_B": 1.2}
    }
}

def run_spe_simulation(params: SPEParams) -> SPESimResult:
    warnings = []
    errors = []

    # Cartucho de 100 mg estándar: volumen muerto de fase móvil (Vm) ≈ 0.3 mL
    V_m = 0.3  

    # Resolve analyte names based on mixture
    mixture_name = params.analyte_mixture or "Paracetamol + Ibuprofeno"
    from hplc_engine import ANALYTE_MIXTURES
    
    if mixture_name in ANALYTE_MIXTURES:
        analyte_a_name = ANALYTE_MIXTURES[mixture_name]["analyte_a"]
        analyte_b_name = ANALYTE_MIXTURES[mixture_name]["analyte_b"]
    else:
        analyte_a_name = params.analyte_a_name
        analyte_b_name = params.analyte_b_name

    # 1. EVALUAR ACONDICIONAMIENTO (Activación de cadenas alquílicas o sitios polares)
    cond_factor = 1.0
    if params.sorbent_type == "C18":
        # C18 necesita solvente orgánico (MeOH o ACN) para "mojar" las cadenas C18 colapsadas
        if params.conditioning_solvent not in ["MeOH", "ACN"]:
            cond_factor = 0.25
            warnings.append(
                f"Acondicionamiento C18 deficiente: El uso de {params.conditioning_solvent} "
                "no solvata las cadenas hidrofóbicas C18, dejándolas colapsadas (Pérdida de retención del 75%)."
            )
        elif params.conditioning_volume_ml < 1.0:
            cond_factor = 0.5 + (0.5 * params.conditioning_volume_ml)
            warnings.append("Volumen de acondicionamiento orgánico muy bajo (< 1 mL). Cartucho activado parcialmente.")

        # Tras mojar con solvente orgánico, se necesita desplazarlo con agua (Equilibrado)
        # Si no se equilibra, el remanente orgánico eluye los compuestos durante la carga
        if params.equilibrating_volume_ml < 1.0:
            cond_factor *= 0.5
            warnings.append(
                "Falta de equilibrado con agua: El solvente orgánico remanente en el cartucho "
                "provocará elución prematura del analito durante el paso de carga."
            )
    else:  # Silica (Fase Normal)
        # Sílice activa sitios silanoles polares. Necesita disolvente no polar para remover humedad.
        if params.conditioning_solvent not in ["Hexano", "EtOAc"]:
            cond_factor = 0.30
            warnings.append(
                f"Acondicionamiento Sílice deficiente: El solvente {params.conditioning_solvent} "
                "es demasiado polar y desactiva los sitios activos silanoles de la sílice."
            )

    # 2. MODELADO DE RETENCIÓN EN CARGA Y LAVADO (Darcy y Partición SPE)
    # Definimos constantes de reparto cromatográficas dinámicas
    coeffs = SPE_ANALYTE_COEFFS.get(mixture_name, SPE_ANALYTE_COEFFS["Paracetamol + Ibuprofeno"])[params.sorbent_type]
    k_w_A = coeffs["k_w_A"]
    S_A = coeffs["S_A"]
    k_w_B = coeffs["k_w_B"]
    S_B = coeffs["S_B"]

    # PASO DE CARGA
    # Matriz del solvente de la muestra
    if params.sorbent_type == "C18" and params.loading_sample_matrix == "Organic":
        warnings.append("ERROR DE DISEÑO: Cargar muestra en solvente orgánico en C18 causa elución total e inmediata.")
        ads_A, ads_B = 0.0, 0.0
    elif params.sorbent_type == "Silica" and params.loading_sample_matrix == "Water":
        warnings.append("ERROR DE DISEÑO: Cargar muestra acuosa en cartucho de Sílice desactiva la fase y eluye todo.")
        ads_A, ads_B = 0.0, 0.0
    else:
        # Retención en carga (se asume carga en fase móvil débil: 0% orgánico en C18, 0% polar en Silica)
        k_load_a = k_w_A
        k_load_b = k_w_B
        
        # Volumen de retención en carga
        V_R_load_a = V_m * (1.0 + k_load_a) * cond_factor
        V_R_load_b = V_m * (1.0 + k_load_b) * cond_factor

        # Fuga durante la carga (analito que percola y se pierde)
        # Si el volumen de muestra supera el volumen de retención, fuga.
        fuga_carga_a = _normal_cdf(params.loading_volume_ml, V_R_load_a, 0.2 * V_R_load_a)
        fuga_carga_b = _normal_cdf(params.loading_volume_ml, V_R_load_b, 0.2 * V_R_load_b)

        ads_A = 100.0 * (1.0 - fuga_carga_a)
        ads_B = 100.0 * (1.0 - fuga_carga_b)

    # PASO DE LAVADO (Washing)
    # El lavado busca eliminar interferentes sin eluir el analito.
    # Evaluamos la fuerza de elución del solvente de lavado.
    if params.sorbent_type == "C18":
        # Fracción orgánica en el lavado
        C_wash = params.washing_organic_pct / 100.0
        # Coeficientes de reparto bajo condiciones de lavado
        k_wash_a = k_w_A * math.pow(10, -S_A * C_wash)
        k_wash_b = k_w_B * math.pow(10, -S_B * C_wash)
    else:  # Silica
        # Para sílice, más orgánico polar eluye más rápido (fuerza eluyente invertida)
        C_wash = params.washing_organic_pct / 100.0
        k_wash_a = k_w_A * math.pow(10, -S_A * C_wash)
        k_wash_b = k_w_B * math.pow(10, -S_B * C_wash)

    # Volumen de retención acumulado durante el lavado
    V_R_wash_a = V_m * (1.0 + k_wash_a) * cond_factor
    V_R_wash_b = V_m * (1.0 + k_wash_b) * cond_factor

    # El volumen total que pasa por el cartucho antes del lavado es V_load + V_wash
    V_total_wash = params.loading_volume_ml + params.washing_volume_ml
    
    # Fracción del compuesto adsorbido que se pierde (se lava)
    # Se calcula la diferencia acumulada
    fuga_lavado_a = _normal_cdf(V_total_wash, V_R_wash_a, 0.2 * V_R_wash_a)
    fuga_lavado_b = _normal_cdf(V_total_wash, V_R_wash_b, 0.2 * V_R_wash_b)

    # El analito perdido en el lavado es el total menos el que ya fugó en carga
    lost_wash_A = max(0.0, ads_A * fuga_lavado_a)
    lost_wash_B = max(0.0, ads_B * fuga_lavado_b)

    # Analito remanente en el cartucho antes de elución
    retained_pre_elute_A = max(0.0, ads_A - lost_wash_A)
    retained_pre_elute_B = max(0.0, ads_B - lost_wash_B)

    # PASO DE ELUCIÓN (Elution)
    # La elución debe desorber todo el analito en el menor volumen posible de solvente fuerte.
    if params.sorbent_type == "C18":
        C_elute = params.elution_organic_pct / 100.0
        k_elute_a = k_w_A * math.pow(10, -S_A * C_elute)
        k_elute_b = k_w_B * math.pow(10, -S_B * C_elute)
    else:  # Silica
        C_elute = params.elution_organic_pct / 100.0
        k_elute_a = k_w_A * math.pow(10, -S_A * C_elute)
        k_elute_b = k_w_B * math.pow(10, -S_B * C_elute)

    # Volumen necesario para elución completa
    V_R_elute_a = V_m * (1.0 + k_elute_a) * cond_factor
    V_R_elute_b = V_m * (1.0 + k_elute_b) * cond_factor

    # Porcentaje eluido dado el volumen de elución
    factor_elu_a = _normal_cdf(params.elution_volume_ml, V_R_elute_a, 0.25 * V_R_elute_a)
    factor_elu_b = _normal_cdf(params.elution_volume_ml, V_R_elute_b, 0.25 * V_R_elute_b)

    recovered_A = retained_pre_elute_A * factor_elu_a
    recovered_B = retained_pre_elute_B * factor_elu_b

    remaining_A = retained_pre_elute_A - recovered_A
    remaining_B = retained_pre_elute_B - recovered_B

    # 3. CÁLCULO DE PUREZA DEL EXTRACTO COLECTADO
    # Si recuperamos el Paracetamol (A) en el lavado (porque queríamos Ibuprofeno en elución),
    # o si se eluyen juntos. Calculemos las purezas relativas en la fase de elución colectada:
    total_recovered = recovered_A + recovered_B
    if total_recovered > 0:
        purity_a = (recovered_A / total_recovered) * 100.0
        purity_b = (recovered_B / total_recovered) * 100.0
    else:
        purity_a = 0.0
        purity_b = 0.0

    # Mensajes pedagógicos / Suitability
    if params.sorbent_type == "C18":
        if params.washing_organic_pct > 30.0 and recovered_A < 40.0:
            warnings.append(
                f"Pérdida en Lavado: El porcentaje orgánico del lavado ({params.washing_organic_pct}%) "
                f"es muy alto para el {analyte_a_name} (polar). Se eluyó y perdió en el lavado en lugar de elución."
            )
        if params.elution_organic_pct < 60.0 and recovered_B < 50.0:
            warnings.append(
                f"Elución incompleta: El solvente de elución ({params.elution_organic_pct}%) es demasiado débil "
                f"para romper la interacción hidrofóbica del {analyte_b_name} con la C18. Aumenta el % orgánico."
            )

    result_a = SPEAnalyteResult(
        name=analyte_a_name,
        percent_adsorbed=round(ads_A, 2),
        percent_washed_out=round(lost_wash_A, 2),
        percent_recovered=round(recovered_A, 2),
        percent_remaining=round(remaining_A, 2)
    )

    result_b = SPEAnalyteResult(
        name=analyte_b_name,
        percent_adsorbed=round(ads_B, 2),
        percent_washed_out=round(lost_wash_B, 2),
        percent_recovered=round(recovered_B, 2),
        percent_remaining=round(remaining_B, 2)
    )

    return SPESimResult(
        sorbent_type=params.sorbent_type,
        conditioning_factor=cond_factor,
        analyte_a=result_a,
        analyte_b=result_b,
        purity_a_pct=purity_a,
        purity_b_pct=purity_b,
        warnings=warnings,
        errors=errors
    )
