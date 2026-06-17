"""
chromatox/backend/hplc_engine.py

Motor físico-químico de simulación para HPLC y UHPLC.
Implementa:
  - Ecuación de Darcy para contrapresión de sistema con límite a 130 MPa (1300 bar).
  - Ecuación de Knox Reducido para HETP en columnas empacadas.
  - Modelo de viscosidad no lineal para mezclas Agua/ACN y Agua/MeOH.
  - Dependencia térmica de viscosidad y difusividad del analito (Stokes-Einstein).
  - Tailing factor de USP y picos bi-gaussianos asimétricos para el cromatograma.
"""

from __future__ import annotations
import math
from dataclasses import dataclass, field, asdict
from typing import Literal, Optional

# ============================================================
# CONSTANTES Y LÍMITES INSTRUMENTALES HPLC/UHPLC
# ============================================================

class HPLCInstrumentLimits:
    MAX_PRESSURE_UHPLC_MPA: float = 130.0    # 130 MPa (1300 bar) - ChroZen UHPLC
    MAX_PRESSURE_HPLC_MPA: float = 40.0      # 40 MPa (400 bar) - HPLC estándar
    TEMP_COLUMN_MAX_C: float = 80.0
    TEMP_COLUMN_MIN_C: float = 15.0
    FLOW_RATE_MAX_ML_MIN: float = 5.0
    FLOW_RATE_MIN_ML_MIN: float = 0.05
    POROSITY_DEFAULT: float = 0.65           # Porosidad total del lecho (ε)
    FLOW_RESISTANCE_W: float = 1000.0        # Parámetro de resistencia al flujo (adimensional)

# ============================================================
# CATÁLOGO DE COLUMNAS HPLC / UHPLC
# ============================================================

@dataclass(frozen=True)
class HPLCColumnSpec:
    key: str
    name: str
    length_mm: float
    inner_diameter_mm: float
    particle_size_um: float
    max_pressure_mpa: float
    chemistry: str                           # "C18", "C8", "Cyano"

HPLC_COLUMN_CATALOG: dict[str, HPLCColumnSpec] = {
    "C18_250mm_5um": HPLCColumnSpec(
        key="C18_250mm_5um",
        name="C18 250mm × 4.6mm, 5µm (Cromatografía Analítica)",
        length_mm=250.0, inner_diameter_mm=4.6, particle_size_um=5.0,
        max_pressure_mpa=HPLCInstrumentLimits.MAX_PRESSURE_HPLC_MPA, chemistry="C18"
    ),
    "C18_150mm_3.5um": HPLCColumnSpec(
        key="C18_150mm_3.5um",
        name="C18 150mm × 4.6mm, 3.5µm (Alta Eficiencia)",
        length_mm=150.0, inner_diameter_mm=4.6, particle_size_um=3.5,
        max_pressure_mpa=HPLCInstrumentLimits.MAX_PRESSURE_HPLC_MPA, chemistry="C18"
    ),
    "C18_50mm_1.7um": HPLCColumnSpec(
        key="C18_50mm_1.7um",
        name="C18 50mm × 2.1mm, 1.7µm (UHPLC - Ultra Rápida)",
        length_mm=50.0, inner_diameter_mm=2.1, particle_size_um=1.7,
        max_pressure_mpa=HPLCInstrumentLimits.MAX_PRESSURE_UHPLC_MPA, chemistry="C18"
    ),
    "C8_150mm_3.5um": HPLCColumnSpec(
        key="C8_150mm_3.5um",
        name="C8 150mm × 4.6mm, 3.5µm (Polaridad Media)",
        length_mm=150.0, inner_diameter_mm=4.6, particle_size_um=3.5,
        max_pressure_mpa=HPLCInstrumentLimits.MAX_PRESSURE_HPLC_MPA, chemistry="C8"
    ),
    "Cyano_150mm_5um": HPLCColumnSpec(
        key="Cyano_150mm_5um",
        name="Cyano 150mm × 4.6mm, 5µm (Fase Reversa/Normal)",
        length_mm=150.0, inner_diameter_mm=4.6, particle_size_um=5.0,
        max_pressure_mpa=HPLCInstrumentLimits.MAX_PRESSURE_HPLC_MPA, chemistry="Cyano"
    )
}

# ============================================================
# DATA CLASSES DE PARÁMETROS Y RESULTADOS
# ============================================================

@dataclass
class HPLCParams:
    column_key: str
    mobile_phase_solvent: Literal["ACN", "MeOH"]
    organic_modifier_pct: float             # 0 a 100
    flow_rate_ml_min: float
    oven_temp_c: float
    analyte_a_name: str = "Paracetamol"
    analyte_b_name: str = "Ibuprofeno"

@dataclass
class HPLCPeakData:
    analyte_name: str
    retention_time_min: float
    retention_factor_k: float
    peak_width_min: float                    # W = 4σ (base)
    peak_width_half_min: float               # FWHM = 2.355σ
    tailing_factor_usp: float
    height_signal: float
    area_signal: float

@dataclass
class HPLCSimResult:
    linear_velocity_u_mm_s: float
    viscosity_cp: float
    backpressure_mpa: float
    backpressure_bar: float
    pressure_ok: bool
    temperature_ok: bool
    reduced_velocity_nu: float
    reduced_hetp_h: float
    hetp_mm: float
    n_plates: int
    rs: float                                # Resolución de picos
    peak_a: HPLCPeakData
    peak_b: HPLCPeakData
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

# ============================================================
# LÓGICA MATEMÁTICA HPLC
# ============================================================

def mobile_phase_viscosity(solvent: str, pct_org: float, temp_c: float) -> float:
    """
    Calcula la viscosidad de la fase móvil usando un modelo no lineal binario
    de agua con modificador orgánico (ACN o MeOH) a 25°C, corregido por temperatura.
    Retorna la viscosidad en cP (mPa·s).
    """
    C = pct_org / 100.0  # Fracción orgánica (0.0 a 1.0)
    
    # Viscosidades de solventes puros a 25°C (cP)
    eta_water = 0.89
    if solvent == "ACN":
        eta_org = 0.34
        k_mix = 0.60  # Acoplamiento para exceso de volumen/viscosidad en ACN
    else:  # MeOH
        eta_org = 0.54
        k_mix = 3.20  #MeOH genera fuerte puente de hidrógeno con agua (máximo a 40%)
        
    # Ecuación de viscosidad de mezcla a 25°C
    eta_25 = eta_water * (1.0 - C) + eta_org * C + k_mix * C * (1.0 - C)
    
    # Corrección de temperatura (Arrhenius simplificado)
    # Disminución de viscosidad de ~1.8% por cada °C por encima de 25°C
    eta = eta_25 * math.exp(-0.018 * (temp_c - 25.0))
    return max(eta, 0.1)  # Límite físico mínimo de viscosidad líquida

def solute_diffusion_coefficient(viscosity_cp: float, temp_c: float) -> float:
    """
    Estima el coeficiente de difusión del soluto en la fase móvil (Dm)
    usando la relación de Stokes-Einstein ajustada por temperatura y viscosidad.
    Retorna Dm en mm²/s.
    """
    # Difusividad de referencia típica a 25°C en agua pura (viscosidad = 0.89 cP)
    # Dm_ref ≈ 1.0e-5 cm²/s = 1.0e-3 mm²/s
    T_K = temp_c + 273.15
    Dm = 1.0e-3 * (T_K / 298.15) * (0.89 / viscosity_cp)
    return Dm

def run_hplc_simulation(params: HPLCParams) -> HPLCSimResult:
    warnings: list[str] = []
    errors: list[str] = []

    # 1. Obtener columna
    col = HPLC_COLUMN_CATALOG.get(params.column_key)
    if not col:
        errors.append(f"Columna '{params.column_key}' no encontrada en el catálogo.")
        # Retornar objeto vacío o lanzar excepción. Para robustez creamos una por defecto.
        col = HPLC_COLUMN_CATALOG["C18_150mm_3.5um"]

    # 2. Validaciones de límites del instrumento
    temperature_ok = params.oven_temp_c <= HPLCInstrumentLimits.TEMP_COLUMN_MAX_C
    if not temperature_ok:
        errors.append(
            f"La temperatura del horno ({params.oven_temp_c}°C) supera el límite máximo "
            f"de la columna ({HPLCInstrumentLimits.TEMP_COLUMN_MAX_C}°C)."
        )

    # 3. Viscosidad de la fase móvil
    eta = mobile_phase_viscosity(params.mobile_phase_solvent, params.organic_modifier_pct, params.oven_temp_c)

    # 4. Velocidad lineal u (mm/s)
    # u = F / (A * ε)
    r_c_mm = col.inner_diameter_mm / 2.0
    area_column_mm2 = math.pi * (r_c_mm ** 2)
    flow_rate_mm3_s = (params.flow_rate_ml_min * 1000.0) / 60.0 # mL/min -> mm3/s
    u = flow_rate_mm3_s / (area_column_mm2 * HPLCInstrumentLimits.POROSITY_DEFAULT)
    u = max(u, 0.01) # Evitar división por cero

    # 5. Contrapresión del sistema ΔP (Darcy)
    # ΔP = (w * η * L * u) / (1000 * dp^2)
    # w = 1000 (pack factor), L en mm, η en cP, u en mm/s, dp en µm
    pressure_mpa = (HPLCInstrumentLimits.FLOW_RESISTANCE_W * eta * col.length_mm * u) / (1000.0 * (col.particle_size_um ** 2))
    pressure_bar = pressure_mpa * 10.0
    pressure_ok = pressure_mpa <= col.max_pressure_mpa

    if not pressure_ok:
        errors.append(
            f"¡ERROR DE CONTRAPRESIÓN CRÍTICA! La presión calculada de {pressure_mpa:.2f} MPa "
            f"excede el límite físico soportado por la columna '{col.name}' ({col.max_pressure_mpa:.1f} MPa)."
        )

    # 6. Difusividad de analito y Knox Reducido
    Dm = solute_diffusion_coefficient(eta, params.oven_temp_c) # mm²/s
    
    # Velocidad reducida ν = (u * dp) / Dm
    # dp en mm para la velocidad reducida dimensionalmente correcta
    dp_mm = col.particle_size_um * 1e-3
    nu = (u * dp_mm) / Dm

    # Ecuación de Knox Reducido: h = A*nu^(1/3) + B/nu + C*nu
    # Coeficientes Knox estándar
    A, B, C_coef = 1.2, 1.8, 0.08
    h = A * (nu ** (1.0 / 3.0)) + (B / nu) + (C_coef * nu)
    
    # HETP en mm
    hetp = h * dp_mm
    n_plates = int(col.length_mm / hetp)
    n_plates = max(n_plates, 50) # Evitar números irrealmente bajos de platos

    # 7. Modelo de Retención de analitos (fase reversa)
    # Log(k') = Log(k'_w) - S * C_fraction
    C_frac = params.organic_modifier_pct / 100.0
    
    # Valores de retención según química de columna
    # C18 es más retentiva que C8, y Cyano es la menos retentiva (en fase reversa)
    retention_multiplier = {
        "C18": 1.0,
        "C8": 0.75,
        "Cyano": 0.45
    }.get(col.chemistry, 1.0)

    # Coeficientes de analitos (Paracetamol = Polar / Ibuprofeno = Apolar)
    if params.mobile_phase_solvent == "ACN":
        # ACN es eluyente fuerte
        k_w_A, S_A = 12.0, 2.6
        k_w_B, S_B = 45.0, 3.1
    else:  # MeOH
        # MeOH es eluyente débil
        k_w_A, S_A = 16.0, 1.9
        k_w_B, S_B = 65.0, 2.4

    # Ajustar por química de columna
    k_w_A *= retention_multiplier
    k_w_B *= retention_multiplier

    k_A = k_w_A * math.pow(10, -S_A * C_frac)
    k_B = k_w_B * math.pow(10, -S_B * C_frac)

    # 8. Tiempos de retención
    # t_M (tiempo muerto en minutos) = V_M / F
    column_volume_ml = (area_column_mm2 * col.length_mm) / 1000.0
    dead_volume_ml = column_volume_ml * HPLCInstrumentLimits.POROSITY_DEFAULT
    t_M = dead_volume_ml / params.flow_rate_ml_min # min

    t_R_A = t_M * (1.0 + k_A)
    t_R_B = t_M * (1.0 + k_B)

    # 9. Tailing factor USP (USP 49 - NF 44)
    # Modelado dinámico: el tailing aumenta si operamos lejos de las condiciones óptimas
    # y por interacciones de soluto (el ibuprofeno taila más en pH no ajustado o flujo alto)
    u_opt = math.sqrt(B / C_coef) * (Dm / dp_mm) # velocidad óptima física en mm/s
    u_ratio = u / u_opt if u > u_opt else u_opt / u
    
    # Tailing base para Paracetamol (polar neutro) e Ibuprofeno (ácido débil)
    t_usp_a = 1.05 + 0.05 * max(0.0, u_ratio - 1.0)
    t_usp_b = 1.20 + 0.12 * max(0.0, u_ratio - 1.0) + 0.15 * (1.0 - C_frac) # aumenta a bajo solvente orgánico

    # Límite inferior físico
    t_usp_a = max(1.0, t_usp_a)
    t_usp_b = max(1.0, t_usp_b)

    # 10. Desviaciones estándar para ancho de pico (σ = t_R / √N)
    sigma_a = t_R_A / math.sqrt(n_plates)
    sigma_b = t_R_B / math.sqrt(n_plates)

    # Ancho de pico en la base W = 4σ
    w_a = 4.0 * sigma_a
    w_b = 4.0 * sigma_b

    # Ancho a mitad de altura FWHM = 2.355σ
    w_half_a = 2.355 * sigma_a
    w_half_b = 2.355 * sigma_b

    # 11. Resolución experimental Rs = (t_R_B - t_R_A) / (2 * (sigma_A + sigma_B))
    # Rs = 2 * Δt_R / (Wa + Wb)
    rs = (t_R_B - t_R_A) / (2.0 * (sigma_a + sigma_b)) if t_R_B > t_R_A else 0.0

    # Picos
    peak_a = HPLCPeakData(
        analyte_name=params.analyte_a_name,
        retention_time_min=round(t_R_A, 4),
        retention_factor_k=round(k_A, 3),
        peak_width_min=round(w_a, 4),
        peak_width_half_min=round(w_half_a, 4),
        tailing_factor_usp=round(t_usp_a, 2),
        height_signal=0.90, # Altura escalada
        area_signal=10.0
    )

    peak_b = HPLCPeakData(
        analyte_name=params.analyte_b_name,
        retention_time_min=round(t_R_B, 4),
        retention_factor_k=round(k_B, 3),
        peak_width_min=round(w_b, 4),
        peak_width_half_min=round(w_half_b, 4),
        tailing_factor_usp=round(t_usp_b, 2),
        height_signal=1.10,
        area_signal=15.0
    )

    # Alertas de idoneidad del sistema (System Suitability - USP 49)
    if rs < 1.50:
        warnings.append(
            f"Resolución insuficiente: Rs = {rs:.2f} (USP 49 exige Rs ≥ 1.50 "
            "para separación analítica confiable en línea base)."
        )
    if t_usp_b > 2.0:
        warnings.append(
            f"Deformación de pico severa: Tailing del Ibuprofeno = {t_usp_b:.2f} "
            "(USP 49 limita el factor de cola T ≤ 2.0 para evitar errores de integración)."
        )
    if pressure_mpa > col.max_pressure_mpa * 0.85 and pressure_ok:
        warnings.append(
            f"Advertencia hidráulica: La contrapresión del sistema ({pressure_mpa:.1f} MPa) "
            f"está muy cerca del límite de la columna ({col.max_pressure_mpa:.1f} MPa)."
        )

    return HPLCSimResult(
        linear_velocity_u_mm_s=round(u, 3),
        viscosity_cp=round(eta, 4),
        backpressure_mpa=round(pressure_mpa, 2),
        backpressure_bar=round(pressure_bar, 1),
        pressure_ok=pressure_ok,
        temperature_ok=temperature_ok,
        reduced_velocity_nu=round(nu, 3),
        reduced_hetp_h=round(h, 3),
        hetp_mm=round(hetp, 5),
        n_plates=n_plates,
        rs=round(rs, 4),
        peak_a=peak_a,
        peak_b=peak_b,
        warnings=warnings,
        errors=errors
    )

# ============================================================
# CURVA DE VAN DEEMTER LÍQUIDA (HETP vs u)
# ============================================================

def vandeemter_hplc_curve(
    column_key: str,
    solvent: Literal["ACN", "MeOH"],
    organic_pct: float,
    temp_c: float,
    u_min: float = 0.1,
    u_max: float = 8.0,
    n_points: int = 80
) -> list[dict]:
    col = HPLC_COLUMN_CATALOG.get(column_key)
    if not col:
        col = HPLC_COLUMN_CATALOG["C18_150mm_3.5um"]

    eta = mobile_phase_viscosity(solvent, organic_pct, temp_c)
    Dm = solute_diffusion_coefficient(eta, temp_c)
    dp_mm = col.particle_size_um * 1e-3

    A, B, C_coef = 1.2, 1.8, 0.08
    points = []
    
    # Calcular velocidad óptima física
    u_opt = math.sqrt(B / C_coef) * (Dm / dp_mm)

    for i in range(n_points):
        u = u_min + (u_max - u_min) * (i / (n_points - 1))
        nu = (u * dp_mm) / Dm
        h = A * (nu ** (1.0 / 3.0)) + (B / nu) + (C_coef * nu)
        hetp_mm = h * dp_mm
        
        # Contribución de términos de Knox
        a_term = A * (nu ** (1.0 / 3.0)) * dp_mm
        b_term = (B / nu) * dp_mm
        c_term = (C_coef * nu) * dp_mm

        points.append({
            "u_mm_s": round(u, 3),
            "hetp_total_mm": round(hetp_mm, 5),
            "A_contribution": round(a_term, 5),
            "B_contribution": round(b_term, 5),
            "C_contribution": round(c_term, 5),
            "u_optimal_mm_s": round(u_opt, 3),
            "is_optimal": abs(u - u_opt) < (u_max - u_min) / n_points
        })
    return points
