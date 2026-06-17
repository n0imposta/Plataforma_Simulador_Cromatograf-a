"""
chromatox/backend/quantitative_engine.py

Motor de cálculos estadísticos y simulación cuantitativa (Unidad 6).
Genera curvas de calibración para fármacos USP y calcula:
- Regresión lineal (m, b, R²)
- Desviación estándar de la regresión (s_y/x)
- Concentración interpolada (C_unk)
- Incertidumbre de interpolación de muestra problema.
"""

from __future__ import annotations
import math
import random
from dataclasses import dataclass
from typing import TypedDict

@dataclass(frozen=True)
class USPCompoundSpec:
    name: str
    min_conc: float            # mg/L
    max_conc: float            # mg/L
    slope_base: float          # m física del detector
    intercept_base: float      # b residual
    noise_sigma: float         # desv. estándar del ruido en área
    target_unk_conc: float     # concentración teórica del lote problema

USP_COMPOUNDS: dict[str, USPCompoundSpec] = {
    "Paracetamol": USPCompoundSpec(
        name="Paracetamol",
        min_conc=5.0, max_conc=50.0,
        slope_base=245.8, intercept_base=42.1,
        noise_sigma=15.0, target_unk_conc=28.5
    ),
    "Ibuprofeno": USPCompoundSpec(
        name="Ibuprofeno",
        min_conc=10.0, max_conc=100.0,
        slope_base=122.4, intercept_base=18.5,
        noise_sigma=25.0, target_unk_conc=65.2
    ),
    "Ácido Acetilsalicílico": USPCompoundSpec(
        name="Ácido Acetilsalicílico",
        min_conc=20.0, max_conc=200.0,
        slope_base=78.2, intercept_base=-8.4,
        noise_sigma=35.0, target_unk_conc=135.0
    ),
    "Naproxeno": USPCompoundSpec(
        name="Naproxeno",
        min_conc=2.0, max_conc=25.0,
        slope_base=585.3, intercept_base=95.2,
        noise_sigma=45.0, target_unk_conc=14.8
    ),
    "Diclofenaco": USPCompoundSpec(
        name="Diclofenaco",
        min_conc=5.0, max_conc=80.0,
        slope_base=178.6, intercept_base=32.4,
        noise_sigma=20.0, target_unk_conc=42.0
    )
}

class RegressionResult(TypedDict):
    slope: float
    intercept: float
    r_squared: float
    s_yx: float
    x_interpolated: float
    uncertainty: float

def generate_calibration_data(compound_name: str, seed: int | None = None) -> dict:
    """
    Genera concentraciones estándares y áreas de inyección para el estudiante,
    así como las 3 áreas réplicas de la muestra problema del lote.
    """
    if seed is not None:
        random.seed(seed)
        
    spec = USP_COMPOUNDS.get(compound_name, USP_COMPOUNDS["Paracetamol"])
    
    # 5 concentraciones distribuidas en el rango lineal
    step = (spec.max_conc - spec.min_conc) / 4.0
    concentrations = [round(spec.min_conc + step * i, 1) for i in range(5)]
    
    # Generar áreas con ruido gaussiano
    areas = []
    for c in concentrations:
        noise = random.normalvariate(0.0, spec.noise_sigma)
        area = spec.slope_base * c + spec.intercept_base + noise
        areas.append(round(max(area, 10.0), 1))
        
    # Generar 3 inyecciones para el lote problema (reproducción k=3)
    unk_areas = []
    for _ in range(3):
        noise = random.normalvariate(0.0, spec.noise_sigma)
        area = spec.slope_base * spec.target_unk_conc + spec.intercept_base + noise
        unk_areas.append(round(max(area, 10.0), 1))
        
    return {
        "compound_name": spec.name,
        "concentrations": concentrations,
        "areas": areas,
        "unk_areas": unk_areas,
        "target_unk_conc": spec.target_unk_conc,
        "noise_sigma": spec.noise_sigma
    }

def calculate_regression(x: list[float], y: list[float], y_unk_list: list[float]) -> RegressionResult:
    """
    Realiza los cálculos estadísticos completos de regresión lineal ordinaria
    por mínimos cuadrados (OLS) e interpola la muestra problema con su incertidumbre.
    """
    n = len(x)
    sum_x = sum(x)
    sum_y = sum(y)
    sum_xx = sum(xi**2 for xi in x)
    sum_yy = sum(yi**2 for yi in y)
    sum_xy = sum(xi * yi for xi, yi in zip(x, y))
    
    # Promedios
    x_bar = sum_x / n
    y_bar = sum_y / n
    
    # Pendiente (m) e Intercepto (b)
    denominator = (n * sum_xx - sum_x**2)
    if abs(denominator) < 1e-9:
        slope = 0.0
        intercept = 0.0
    else:
        slope = (n * sum_xy - sum_x * sum_y) / denominator
        intercept = y_bar - slope * x_bar
        
    # Coeficiente de Determinación R²
    ss_xx = sum_xx - (sum_x**2) / n
    ss_yy = sum_yy - (sum_y**2) / n
    ss_xy = sum_xy - (sum_x * sum_y) / n
    
    if ss_xx * ss_yy <= 0:
        r_squared = 0.0
    else:
        r_squared = (ss_xy**2) / (ss_xx * ss_yy)
        
    # Desviación Estándar de la Regresión (s_y/x)
    # y_hat_i = m * x_i + b
    if n > 2:
        sum_residuals_sq = sum((yi - (slope * xi + intercept))**2 for xi, yi in zip(x, y))
        s_yx = math.sqrt(sum_residuals_sq / (n - 2))
    else:
        s_yx = 0.0
        
    # Interpolación de muestra problema
    y_unk = sum(y_unk_list) / len(y_unk_list)
    if abs(slope) > 1e-9:
        x_interpolated = (y_unk - intercept) / slope
    else:
        x_interpolated = 0.0
        
    # Incertidumbre de interpolación de muestra problema (s_x_unk)
    # s_x = (s_yx / |m|) * sqrt(1/k + 1/n + (y_unk - y_bar)^2 / (m^2 * sum(xi - x_bar)^2))
    k = len(y_unk_list)
    sum_x_deviations_sq = sum((xi - x_bar)**2 for xi in x)
    
    if abs(slope) > 1e-9 and sum_x_deviations_sq > 0:
        term_k = 1.0 / k
        term_n = 1.0 / n
        term_deviation = ((y_unk - y_bar)**2) / ((slope**2) * sum_x_deviations_sq)
        uncertainty = (s_yx / abs(slope)) * math.sqrt(term_k + term_n + term_deviation)
    else:
        uncertainty = 0.0
        
    return {
        "slope": round(slope, 4),
        "intercept": round(intercept, 4),
        "r_squared": round(r_squared, 6),
        "s_yx": round(s_yx, 4),
        "x_interpolated": round(x_interpolated, 4),
        "uncertainty": round(uncertainty, 4)
    }
