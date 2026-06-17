import asyncio
from hplc_engine import run_hplc_simulation, HPLCParams
from spe_engine import run_spe_simulation, SPEParams

def test_hplc():
    print("Testing HPLC simulation...")
    # Test standard column
    params = HPLCParams(
        column_key="C18_150mm_3.5um",
        mobile_phase_solvent="ACN",
        organic_modifier_pct=50.0,
        flow_rate_ml_min=1.0,
        oven_temp_c=25.0
    )
    res = run_hplc_simulation(params)
    print(f"Viscosity: {res.viscosity_cp} cP")
    print(f"Pressure: {res.backpressure_mpa} MPa")
    print(f"Plates: {res.n_plates}")
    print(f"Rs: {res.rs}")
    print(f"Tailing A: {res.peak_a.tailing_factor_usp}")
    print(f"Tailing B: {res.peak_b.tailing_factor_usp}")
    assert res.pressure_ok == True
    print("HPLC test passed!")

def test_spe():
    print("Testing SPE simulation...")
    params = SPEParams(
        sorbent_type="C18",
        conditioning_solvent="MeOH",
        conditioning_volume_ml=2.0,
        equilibrating_volume_ml=2.0,
        loading_volume_ml=1.0,
        loading_sample_matrix="Water",
        washing_solvent="H2O",
        washing_organic_pct=0.0,
        washing_volume_ml=1.0,
        elution_solvent="MeOH",
        elution_organic_pct=80.0,
        elution_volume_ml=2.0
    )
    res = run_spe_simulation(params)
    print(f"Conditioning factor: {res.conditioning_factor}")
    print(f"Paracetamol recovered: {res.analyte_a.percent_recovered}%")
    print(f"Ibuprofen recovered: {res.analyte_b.percent_recovered}%")
    print(f"Ibuprofen purity: {res.purity_b_pct}%")
    print("SPE test passed!")

if __name__ == "__main__":
    test_hplc()
    test_spe()
