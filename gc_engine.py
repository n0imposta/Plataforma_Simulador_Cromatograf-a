"""
chromatox/backend/physics/gc_engine.py

Motor físico-químico para Cromatografía de Gases (GC).
Implementa:
  - Ecuación de Golay (análogo de van Deemter para columnas capilares)
  - Selección y optimización de gas portador (He, H₂, N₂)
  - Modelos de detectores: FID, TCD, MS, ECD
  - Modos de inyección: split, splitless, on-column, SPME
  - Programación de temperatura (rampas lineales)
  - Factor de compresibilidad de James-Martin
  - Presión de columna y velocidad media corregida

Referencia:
  - Golay (1958) Gas Chromatography, Butterworths
  - McNair & Miller (2009) Basic Gas Chromatography, Wiley
  - Blumberg (2010) Temperature-Programmed GC, Wiley
"""

from __future__ import annotations
import math
from dataclasses import dataclass, field, asdict
from typing import Literal, Optional
from enum import Enum


# ============================================================
# CONSTANTES Y LÍMITES INSTRUMENTALES GC
# ============================================================

class GCInstrumentLimits:
    """Límites típicos de un GC de laboratorio (ej. Shimadzu GC-2010 Plus)."""
    PRESSURE_INLET_MAX_KPA: float = 970.0    # kPa (≈ 140 psi)
    PRESSURE_INLET_MIN_KPA: float = 1.0
    TEMP_COLUMN_MAX_C: float = 450.0
    TEMP_COLUMN_MIN_C: float = -60.0         # con criostato
    TEMP_INJECTOR_MAX_C: float = 450.0
    TEMP_DETECTOR_MAX_C: float = 450.0
    SPLIT_RATIO_MIN: float = 1.0
    SPLIT_RATIO_MAX: float = 1000.0
    COLUMN_LENGTH_MIN_M: float = 5.0
    COLUMN_LENGTH_MAX_M: float = 100.0
    COLUMN_ID_MIN_MM: float = 0.1
    COLUMN_ID_MAX_MM: float = 0.53


# ============================================================
# PROPIEDADES DE GASES PORTADORES
# (a 25°C, 1 atm — ajustadas por temperatura en runtime)
# ============================================================

@dataclass(frozen=True)
class CarrierGasProperties:
    name: str
    symbol: str
    viscosity_25c_upas: float     # μPa·s a 25°C
    viscosity_exp: float          # exponente para corrección de T (η ∝ T^exp)
    # Difusividad binaria típica con vapores orgánicos (cm²/s a 25°C, 1 atm)
    diffusivity_ref_cm2_s: float
    optimal_velocity_range: tuple[float, float]  # cm/s (u_opt típico)
    min_hetp_factor: float        # h_mín relativo (He=1.0, referencia)
    safety_note: str


CARRIER_GASES: dict[str, CarrierGasProperties] = {
    "He": CarrierGasProperties(
        name="Helio", symbol="He",
        viscosity_25c_upas=19.9, viscosity_exp=0.67,
        diffusivity_ref_cm2_s=0.42,
        optimal_velocity_range=(20.0, 35.0),
        min_hetp_factor=1.0,
        safety_note="Gas inerte, seguro. Alta difusividad → velocidades óptimas moderadas.",
    ),
    "H2": CarrierGasProperties(
        name="Hidrógeno", symbol="H₂",
        viscosity_25c_upas=8.9,  viscosity_exp=0.67,
        diffusivity_ref_cm2_s=0.68,
        optimal_velocity_range=(35.0, 60.0),
        min_hetp_factor=0.85,
        safety_note="⚠ Gas inflamable. Requiere detector de fuga. Mayor rango de velocidades óptimas.",
    ),
    "N2": CarrierGasProperties(
        name="Nitrógeno", symbol="N₂",
        viscosity_25c_upas=17.9, viscosity_exp=0.67,
        diffusivity_ref_cm2_s=0.18,
        optimal_velocity_range=(10.0, 20.0),
        min_hetp_factor=1.35,
        safety_note="Gas barato y seguro. Menor Dm → curva muy sensible. Rango óptimo estrecho.",
    ),
}


# ============================================================
# ESPECIFICACIONES DE COLUMNA CAPILAR GC
# ============================================================

@dataclass
class GCColumnSpec:
    name: str
    length_m: float                # ej. 30 m
    inner_diameter_mm: float       # ej. 0.25 mm
    film_thickness_um: float       # df: espesor de fase estacionaria (μm)
    phase_type: str                # "DB-5", "DB-1", "DB-WAX", "DB-17", etc.
    polarity: str                  # "nonpolar", "midpolar", "polar"
    max_temp_c: float              # temperatura máxima de la columna
    phase_ratio: Optional[float] = None   # β = r / (2·df)

    def __post_init__(self):
        if self.phase_ratio is None:
            r_um = (self.inner_diameter_mm / 2) * 1000   # μm
            self.phase_ratio = r_um / (2 * self.film_thickness_um)

    @property
    def column_volume_ml(self) -> float:
        r_cm = self.inner_diameter_mm / 2 / 10
        return math.pi * r_cm**2 * self.length_m * 100   # mL

    @property
    def dead_volume_ml(self) -> float:
        return self.column_volume_ml   # capilares: todo es volumen muerto geométrico


GC_COLUMN_CATALOG: dict[str, GCColumnSpec] = {
    "DB5_30m_025mm_025um": GCColumnSpec(
        "DB-5 (5% fenil polisil.) 30m×0.25mm×0.25μm",
        30.0, 0.25, 0.25, "DB-5", "nonpolar", 325.0
    ),
    "DB1_60m_025mm_025um": GCColumnSpec(
        "DB-1 (100% DMS) 60m×0.25mm×0.25μm",
        60.0, 0.25, 0.25, "DB-1", "nonpolar", 325.0
    ),
    "DB5_30m_032mm_025um": GCColumnSpec(
        "DB-5 30m×0.32mm×0.25μm",
        30.0, 0.32, 0.25, "DB-5", "nonpolar", 325.0
    ),
    "DBWAX_30m_025mm_025um": GCColumnSpec(
        "DB-WAX (PEG) 30m×0.25mm×0.25μm",
        30.0, 0.25, 0.25, "DB-WAX", "polar", 260.0
    ),
    "DB17_30m_025mm_025um": GCColumnSpec(
        "DB-17 (50% fenil) 30m×0.25mm×0.25μm",
        30.0, 0.25, 0.25, "DB-17", "midpolar", 300.0
    ),
    "DB5MS_15m_025mm_010um": GCColumnSpec(
        "DB-5ms 15m×0.25mm×0.10μm (GC-MS)",
        15.0, 0.25, 0.10, "DB-5ms", "nonpolar", 325.0
    ),
}


# ============================================================
# MODOS DE INYECCIÓN
# ============================================================

class InjectionMode(str, Enum):
    SPLIT       = "SPLIT"        # alta concentración, fracción al inlet
    SPLITLESS   = "SPLITLESS"    # trazas, todo pasa a columna (purga ~1 min)
    ON_COLUMN   = "ON_COLUMN"    # termolábiles, inyección directa fría
    PTV         = "PTV"          # temperatura programada, mayor versatilidad
    SPME        = "SPME"         # micro-extracción en fase sólida + desorción


@dataclass
class InjectionParams:
    mode: InjectionMode
    injector_temp_c: float
    split_ratio: float = 50.0       # solo aplica a SPLIT
    purge_time_min: float = 1.0     # SPLITLESS: tiempo antes de abrir purga
    injection_vol_ul: float = 1.0
    # SPME
    spme_fiber_type: Optional[str] = None
    desorption_time_min: Optional[float] = None


# ============================================================
# MODELOS DE DETECTORES GC
# ============================================================

@dataclass(frozen=True)
class GCDetectorSpec:
    name: str
    abbreviation: str
    principle: str
    min_detectable_g_s: float      # MDQ en g/s
    linear_range_decades: int      # rango lineal (órdenes de magnitud)
    selective_for: list[str]
    temp_max_c: float
    carrier_gas_compatible: list[str]


GC_DETECTORS: dict[str, GCDetectorSpec] = {
    "FID": GCDetectorSpec(
        "Detector de Ionización de Llama", "FID",
        "Ionización de compuestos orgánicos en llama H₂/aire",
        min_detectable_g_s=1e-13,
        linear_range_decades=7,
        selective_for=["orgánicos con C-H", "hidrocarburos"],
        temp_max_c=450,
        carrier_gas_compatible=["He", "N2", "H2"],
    ),
    "TCD": GCDetectorSpec(
        "Detector de Conductividad Térmica", "TCD",
        "Cambio de conductividad térmica del gas portador",
        min_detectable_g_s=1e-10,
        linear_range_decades=5,
        selective_for=["universal", "gases permanentes", "agua", "CO₂"],
        temp_max_c=400,
        carrier_gas_compatible=["He", "H2"],
    ),
    "ECD": GCDetectorSpec(
        "Detector de Captura de Electrones", "ECD",
        "Captura de electrones por compuestos electronegativos (⁶³Ni)",
        min_detectable_g_s=1e-15,
        linear_range_decades=4,
        selective_for=["halogenados", "nitrocompuestos", "pesticidas organoclorados"],
        temp_max_c=400,
        carrier_gas_compatible=["N2", "Ar/CH4"],
    ),
    "MS": GCDetectorSpec(
        "Detector de Masas (cuadrupolo)", "MS",
        "Ionización por electrones (EI 70 eV) + separación m/z",
        min_detectable_g_s=1e-13,
        linear_range_decades=5,
        selective_for=["identificación estructural", "cuantificación selectiva SIM"],
        temp_max_c=350,
        carrier_gas_compatible=["He"],
    ),
    "NPD": GCDetectorSpec(
        "Detector Nitrógeno-Fósforo", "NPD",
        "Termoiónico selectivo para N y P",
        min_detectable_g_s=1e-14,
        linear_range_decades=5,
        selective_for=["pesticidas organofosforados", "alcaloides N"],
        temp_max_c=400,
        carrier_gas_compatible=["He", "N2"],
    ),
}


# ============================================================
# DATA CLASSES DE PARÁMETROS Y RESULTADOS
# ============================================================

@dataclass
class GCParams:
    """Parámetros completos de entrada al motor GC."""
    column: GCColumnSpec
    carrier_gas: str                # clave en CARRIER_GASES
    inlet_pressure_kpa: float
    oven_temp_c: float              # temperatura isotérmica (simplificado)
    injector_temp_c: float
    detector_type: str              # clave en GC_DETECTORS
    detector_temp_c: float
    injection: InjectionParams
    # Propiedades de analito (para Caso GC)
    k_prime_a: float
    k_prime_b: float
    # Programación de temperatura (opcional — Fase 2)
    temp_program: Optional[list[dict]] = None


@dataclass
class GCPeakData:
    analyte_name: str
    retention_time_min: float
    peak_width_min: float
    peak_width_half_min: float
    height_signal: float
    k_prime: float
    boiling_point_c: Optional[float] = None


@dataclass
class GCSimResult:
    """Resultado completo del motor GC."""
    # Parámetros de la columna
    average_velocity_cm_s: float     # ū (corregida por compresión)
    james_martin_factor: float       # j = factor de compresibilidad
    # Van Deemter / Golay
    hetp_mm: float
    n_plates: int
    reduced_hetp: float              # h = HETP / dc (adimensional para capilares)
    # Coeficientes Golay individuales
    golay_B_term: float              # difusión longitudinal
    golay_Cm_term: float             # resistencia a transferencia de masa (fase móvil)
    golay_Cs_term: float             # resistencia a transferencia de masa (fase estacionaria)
    # Selectividad y resolución
    alpha: float
    rs: float
    # Estado del instrumento
    inlet_pressure_kpa: float
    pressure_ok: bool
    column_temp_ok: bool
    # Picos
    peak_a: GCPeakData
    peak_b: GCPeakData
    # Alertas
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ============================================================
# MOTOR FÍSICO GC — ECUACIÓN DE GOLAY
# ============================================================

def carrier_gas_viscosity(gas_key: str, temp_c: float) -> float:
    """
    Viscosidad del gas portador corregida por temperatura.
    η(T) = η(25°C) · (T/298)^exp    [μPa·s]
    """
    g = CARRIER_GASES[gas_key]
    T_K = temp_c + 273.15
    return g.viscosity_25c_upas * (T_K / 298.15) ** g.viscosity_exp


def carrier_gas_diffusivity(gas_key: str, temp_c: float, pressure_kpa: float) -> float:
    """
    Difusividad binaria gas portador–analito orgánico típico.
    Chapman-Enskog simplificado: Dm ∝ T^1.75 / P
    Retorna Dm en cm²/s.
    """
    g = CARRIER_GASES[gas_key]
    T_K = temp_c + 273.15
    P_atm = pressure_kpa / 101.325
    return g.diffusivity_ref_cm2_s * (T_K / 298.15) ** 1.75 / P_atm


def james_martin_compressibility(
    inlet_pressure_kpa: float,
    outlet_pressure_kpa: float = 101.325,
) -> float:
    """
    Factor de compresibilidad de James-Martin:
        j = (3/2) · [(P_i/P_o)² − 1] / [(P_i/P_o)³ − 1]

    Corrige la velocidad media para gas compresible.
    j = 1 cuando P_i = P_o (líquidos).
    """
    r = inlet_pressure_kpa / outlet_pressure_kpa
    if abs(r - 1.0) < 1e-6:
        return 1.0
    return (3/2) * (r**2 - 1) / (r**3 - 1)


def average_linear_velocity(
    col: GCColumnSpec,
    inlet_pressure_kpa: float,
    temp_c: float,
    gas_key: str,
    outlet_kpa: float = 101.325,
) -> float:
    """
    Velocidad lineal media corregida (Hagen-Poiseuille para gas):
        ū = (dc² · ΔP) / (32 · η · L) · j    [cm/s]

    Args:
        col:  especificación de columna
        inlet_pressure_kpa: presión de entrada Pi
        temp_c:   temperatura de columna
        gas_key:  clave del gas portador
        outlet_kpa: presión de salida (atm por defecto)

    Returns:
        velocidad media lineal en cm/s
    """
    dc_cm = col.inner_diameter_mm / 10          # mm → cm
    L_cm  = col.length_m * 100                   # m → cm
    dP_Pa = (inlet_pressure_kpa - outlet_kpa) * 1000  # kPa → Pa
    eta_Pa_s = carrier_gas_viscosity(gas_key, temp_c) * 1e-6  # μPa·s → Pa·s
    j = james_martin_compressibility(inlet_pressure_kpa, outlet_kpa)

    u_mean = (dc_cm**2 * dP_Pa) / (32 * eta_Pa_s * L_cm) * j
    return max(u_mean, 0.1)   # mínimo físico


def golay_hetp(
    u_cm_s: float,
    col: GCColumnSpec,
    gas_key: str,
    temp_c: float,
    inlet_pressure_kpa: float,
    k_prime: float,
) -> tuple[float, float, float, float]:
    """
    Ecuación de Golay para columnas capilares (sin término A):
        HETP = B/u + (Cm + Cs)·u

    Donde:
        B  = 2·Dm            (difusión longitudinal)
        Cm = dc²/(96·Dm) · (1 + 6k' + 11k'²) / (1 + k')²
             (transferencia de masa en fase móvil)
        Cs = 2·k'·df² / (3·Ds·(1 + k')²)
             (transferencia de masa en fase estacionaria)

    Returns:
        (HETP_mm, B, Cm, Cs) — todos en mm y mm·s/mm = s (normalizados)
    """
    Dm = carrier_gas_diffusivity(gas_key, temp_c, inlet_pressure_kpa)  # cm²/s
    Dm_mm2_s = Dm * 100   # cm²/s → mm²/s

    dc_mm = col.inner_diameter_mm
    df_mm = col.film_thickness_um * 1e-3   # μm → mm

    # Difusividad en fase estacionaria (Ds ≈ Dm / 1000 para polímeros típicos)
    Ds_mm2_s = Dm_mm2_s / 1000.0

    u_mm_s = u_cm_s * 10   # cm/s → mm/s

    # Término B
    B = 2 * Dm_mm2_s   # mm²/s

    # Término Cm (resistencia en fase móvil)
    Cm_numerator   = dc_mm**2 * (1 + 6*k_prime + 11*k_prime**2)
    Cm_denominator = 96 * Dm_mm2_s * (1 + k_prime)**2
    Cm = Cm_numerator / Cm_denominator   # s/mm · mm = s (adimensional con u en mm/s → HETP en mm)

    # Término Cs (resistencia en fase estacionaria)
    Cs_numerator   = 2 * k_prime * df_mm**2
    Cs_denominator = 3 * Ds_mm2_s * (1 + k_prime)**2
    Cs = Cs_numerator / Cs_denominator   # s

    hetp_mm = B / u_mm_s + (Cm + Cs) * u_mm_s
    return hetp_mm, B, Cm, Cs


def optimal_velocity_golay(
    col: GCColumnSpec,
    gas_key: str,
    temp_c: float,
    inlet_pressure_kpa: float,
    k_prime: float,
) -> float:
    """
    Velocidad óptima donde d(HETP)/du = 0:
        u_opt = √(B / (Cm + Cs))   [mm/s → retorna cm/s]
    """
    Dm = carrier_gas_diffusivity(gas_key, temp_c, inlet_pressure_kpa)
    Dm_mm2_s = Dm * 100
    dc_mm = col.inner_diameter_mm
    df_mm = col.film_thickness_um * 1e-3
    Ds_mm2_s = Dm_mm2_s / 1000.0

    B  = 2 * Dm_mm2_s
    Cm = dc_mm**2 * (1 + 6*k_prime + 11*k_prime**2) / (96 * Dm_mm2_s * (1 + k_prime)**2)
    Cs = 2 * k_prime * df_mm**2 / (3 * Ds_mm2_s * (1 + k_prime)**2)

    denom = Cm + Cs
    if denom <= 0:
        return 30.0
    u_opt_mm_s = math.sqrt(B / denom)
    return u_opt_mm_s / 10   # mm/s → cm/s


def purnell_resolution(alpha: float, n: int, k_prime_b: float) -> float:
    """Ecuación de Purnell — idéntica a HPLC (universal)."""
    if alpha <= 1.0:
        return 0.0
    return (math.sqrt(n) / 4) * ((alpha - 1) / alpha) * (k_prime_b / (1 + k_prime_b))


def gc_retention_time(
    k_prime: float,
    col: GCColumnSpec,
    u_cm_s: float,
) -> float:
    """
    t_R = t_M · (1 + k')
    t_M = L / ū   (tiempo muerto)
    """
    t_M = (col.length_m * 100) / (u_cm_s * 60)   # L en cm, u en cm/s → min
    return t_M * (1 + k_prime)


# ============================================================
# FUNCIÓN PRINCIPAL GC
# ============================================================

def run_gc_simulation(params: GCParams) -> GCSimResult:
    """
    Simula una corrida GC completa.
    Punto de entrada para el endpoint FastAPI /api/gc/run.
    """
    warnings: list[str] = []
    errors: list[str] = []

    col = params.column
    gas = CARRIER_GASES.get(params.carrier_gas)
    detector = GC_DETECTORS.get(params.detector_type)

    if not gas:
        errors.append(f"Gas portador '{params.carrier_gas}' no reconocido")
    if not detector:
        errors.append(f"Detector '{params.detector_type}' no reconocido")

    # Validaciones de temperatura
    column_temp_ok = params.oven_temp_c <= col.max_temp_c
    if not column_temp_ok:
        errors.append(f"T columna {params.oven_temp_c}°C supera máximo {col.max_temp_c}°C")
    if params.detector_temp_c < params.oven_temp_c:
        warnings.append("T detector < T columna — riesgo de condensación en la línea de transferencia")
    if detector and params.carrier_gas not in detector.carrier_gas_compatible:
        warnings.append(
            f"El detector {detector.abbreviation} no es compatible con {gas.symbol}. "
            f"Compatibles: {', '.join(detector.carrier_gas_compatible)}"
        )

    # Presión
    pressure_ok = params.inlet_pressure_kpa <= GCInstrumentLimits.PRESSURE_INLET_MAX_KPA
    if not pressure_ok:
        errors.append(
            f"Presión {params.inlet_pressure_kpa} kPa supera límite "
            f"{GCInstrumentLimits.PRESSURE_INLET_MAX_KPA} kPa"
        )

    # Velocidad lineal media corregida
    u_cm_s = average_linear_velocity(
        col, params.inlet_pressure_kpa, params.oven_temp_c, params.carrier_gas
    )

    # k' promedio para HETP (usar k'_B para condición más exigente)
    k_avg = (params.k_prime_a + params.k_prime_b) / 2

    # Golay para cada analito (HETP depende de k')
    hetp_a, B_a, Cm_a, Cs_a = golay_hetp(
        u_cm_s, col, params.carrier_gas, params.oven_temp_c, params.inlet_pressure_kpa, params.k_prime_a
    )
    hetp_b, B_b, Cm_b, Cs_b = golay_hetp(
        u_cm_s, col, params.carrier_gas, params.oven_temp_c, params.inlet_pressure_kpa, params.k_prime_b
    )
    # HETP representativo (media ponderada)
    hetp_rep = (hetp_a + hetp_b) / 2

    n_plates = int((col.length_m * 1000) / hetp_rep)   # L en mm
    h_reduced = hetp_rep / col.inner_diameter_mm         # h = HETP/dc

    # Selectividad y resolución
    k_max = max(params.k_prime_a, params.k_prime_b)
    k_min = min(params.k_prime_a, params.k_prime_b)
    alpha = k_max / k_min if k_min > 0 else 1.0
    rs = purnell_resolution(alpha, n_plates, k_max)

    # Advertencias de calidad de separación
    if rs < 1.0:
        warnings.append(f"Rs = {rs:.2f}: solapamiento severo en GC")
    elif rs < 1.5:
        warnings.append(f"Rs = {rs:.2f}: separación parcial — objetivo Rs ≥ 1.50")

    # Gas portador no óptimo
    u_opt = optimal_velocity_golay(
        col, params.carrier_gas, params.oven_temp_c, params.inlet_pressure_kpa, k_avg
    )
    if u_cm_s < u_opt * 0.6:
        warnings.append(
            f"Velocidad {u_cm_s:.1f} cm/s muy por debajo del óptimo "
            f"({u_opt:.1f} cm/s) — eficiencia reducida (zona B dominante)"
        )
    elif u_cm_s > u_opt * 2.0:
        warnings.append(
            f"Velocidad {u_cm_s:.1f} cm/s muy por encima del óptimo "
            f"({u_opt:.1f} cm/s) — eficiencia reducida (zona C dominante)"
        )

    # Factor de James-Martin
    j = james_martin_compressibility(params.inlet_pressure_kpa)

    # Tiempos de retención
    t_r_a = gc_retention_time(params.k_prime_a, col, u_cm_s)
    t_r_b = gc_retention_time(params.k_prime_b, col, u_cm_s)

    # Anchos de pico (w = 4σ, σ = t_R/√N)
    sigma_a = t_r_a / math.sqrt(max(n_plates, 1))
    sigma_b = t_r_b / math.sqrt(max(n_plates, 1))

    peak_a = GCPeakData(
        analyte_name="Analito A",
        retention_time_min=round(t_r_a, 4),
        peak_width_min=round(4 * sigma_a, 4),
        peak_width_half_min=round(2.355 * sigma_a, 4),
        height_signal=0.85,
        k_prime=params.k_prime_a,
    )
    peak_b = GCPeakData(
        analyte_name="Analito B",
        retention_time_min=round(t_r_b, 4),
        peak_width_min=round(4 * sigma_b, 4),
        peak_width_half_min=round(2.355 * sigma_b, 4),
        height_signal=1.00,
        k_prime=params.k_prime_b,
    )

    return GCSimResult(
        average_velocity_cm_s=round(u_cm_s, 3),
        james_martin_factor=round(j, 4),
        hetp_mm=round(hetp_rep, 5),
        n_plates=n_plates,
        reduced_hetp=round(h_reduced, 3),
        golay_B_term=round(B_a, 6),
        golay_Cm_term=round(Cm_a, 6),
        golay_Cs_term=round(Cs_a, 6),
        alpha=round(alpha, 4),
        rs=round(rs, 4),
        inlet_pressure_kpa=round(params.inlet_pressure_kpa, 2),
        pressure_ok=pressure_ok,
        column_temp_ok=column_temp_ok,
        peak_a=peak_a,
        peak_b=peak_b,
        warnings=warnings,
        errors=errors,
    )


# ============================================================
# CURVA DE GOLAY (serie de puntos para el gráfico)
# ============================================================

def golay_curve(
    col: GCColumnSpec,
    gas_key: str,
    temp_c: float,
    inlet_pressure_kpa: float,
    k_prime: float,
    u_range_cm_s: tuple[float, float] = (5.0, 80.0),
    n_points: int = 80,
) -> list[dict]:
    """
    Genera puntos (u, HETP) para el gráfico de Golay.
    Incluye las tres contribuciones: B/u, Cm·u, Cs·u.
    """
    u_min, u_max = u_range_cm_s
    u_opt = optimal_velocity_golay(col, gas_key, temp_c, inlet_pressure_kpa, k_prime)
    points = []
    for i in range(n_points):
        u = u_min + (u_max - u_min) * i / (n_points - 1)
        hetp, B, Cm, Cs = golay_hetp(u, col, gas_key, temp_c, inlet_pressure_kpa, k_prime)
        u_mm_s = u * 10
        points.append({
            "u_cm_s": round(u, 3),
            "hetp_total_mm": round(hetp, 5),
            "B_contribution": round(B / u_mm_s, 5),   # B/u
            "Cm_contribution": round(Cm * u_mm_s, 5), # Cm·u
            "Cs_contribution": round(Cs * u_mm_s, 5), # Cs·u
            "u_optimal_cm_s": round(u_opt, 3),
            "is_optimal": abs(u - u_opt) < (u_max - u_min) / n_points,
        })
    return points
