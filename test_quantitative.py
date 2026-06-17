"""
test_quantitative.py

Pruebas unitarias para el motor de cálculos cuantitativos (quantitative_engine.py).
Valida regresiones y cálculo de incertidumbre.
"""

from __future__ import annotations
import math
from quantitative_engine import calculate_regression, generate_calibration_data

def test_regression_math():
    # Datos sintéticos perfectos sin ruido: y = 2 * x + 10
    x = [5.0, 10.0, 20.0, 50.0, 100.0]
    y = [2.0 * xi + 10.0 for xi in x]
    
    # 3 inyecciones del lote problema con área promedio 90 (concentración esperada = 40)
    y_unk = [90.0, 90.0, 90.0]
    
    res = calculate_regression(x, y, y_unk)
    
    # Pendiente esperada = 2.0
    assert abs(res["slope"] - 2.0) < 1e-4, f"Pendiente incorrecta: {res['slope']}"
    # Intercepto esperado = 10.0
    assert abs(res["intercept"] - 10.0) < 1e-4, f"Intercepto incorrecto: {res['intercept']}"
    # R² esperado = 1.0 (calibración perfecta)
    assert abs(res["r_squared"] - 1.0) < 1e-4, f"R² incorrecto: {res['r_squared']}"
    # Concentración esperada = 40.0
    assert abs(res["x_interpolated"] - 40.0) < 1e-4, f"Concentración interpolada incorrecta: {res['x_interpolated']}"
    # Incertidumbre esperada = 0.0 (ya que no hay dispersión en los residuos de la recta)
    assert abs(res["uncertainty"] - 0.0) < 1e-4, f"Incertidumbre incorrecta: {res['uncertainty']}"

def test_generate_data():
    res = generate_calibration_data("Paracetamol")
    assert res["compound_name"] == "Paracetamol"
    assert len(res["concentrations"]) == 5
    assert len(res["areas"]) == 5
    assert len(res["unk_areas"]) == 3
    
    # Comprobar que los rangos estén en el intervalo de Paracetamol (5 a 50)
    assert res["concentrations"][0] == 5.0
    assert res["concentrations"][-1] == 50.0

if __name__ == "__main__":
    try:
        test_regression_math()
        print("test_regression_math: OK")
        test_generate_data()
        print("test_generate_data: OK")
        print("All tests passed successfully!")
    except AssertionError as e:
        print(f"Test failed: {e}")
        import sys
        sys.exit(1)
