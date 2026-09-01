"""Pronostico meteorologico para las carreras futuras (Open-Meteo).

Al entrenar usamos el clima REGISTRADO durante la carrera, que trae FastF1. Para
predecir una carrera que aun no se ha disputado hace falta un pronostico, y ahi
entra Open-Meteo: es gratuito, no pide clave y no exige registro.

Dos conversiones son imprescindibles para que el pronostico sea comparable con
los datos de entrenamiento:

  1. UNIDADES. FastF1 da el viento en m/s y Open-Meteo en km/h. Sin dividir
     entre 3.6, el modelo veria vendavales inexistentes.

  2. TEMPERATURA DE PISTA. Ningun servicio meteorologico la mide: el asfalto se
     calienta muy por encima del aire. La estimamos con el desfase historico
     medio de ese circuito, sacado de nuestros propios datos.
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request

import numpy as np
import pandas as pd

TIMEOUT = 20

# Coordenadas de los circuitos. Van a mano porque geocodificar por nombre de
# ciudad falla justo en los casos raros ("Marina Bay", "Yas Island").
COORDENADAS = {
    "Bahrain Grand Prix":        (26.0325, 50.5106),
    "Saudi Arabian Grand Prix":  (21.6319, 39.1044),
    "Australian Grand Prix":     (-37.8497, 144.9680),
    "Japanese Grand Prix":       (34.8431, 136.5407),
    "Chinese Grand Prix":        (31.3389, 121.2200),
    "Miami Grand Prix":          (25.9581, -80.2389),
    "Emilia Romagna Grand Prix": (44.3439, 11.7167),
    "Monaco Grand Prix":         (43.7347, 7.4206),
    "Canadian Grand Prix":       (45.5000, -73.5228),
    "Spanish Grand Prix":        (41.5700, 2.2611),
    "Barcelona Grand Prix":      (41.5700, 2.2611),
    "Austrian Grand Prix":       (47.2197, 14.7647),
    "Styrian Grand Prix":        (47.2197, 14.7647),
    "British Grand Prix":        (52.0786, -1.0169),
    "Hungarian Grand Prix":      (47.5789, 19.2486),
    "Belgian Grand Prix":        (50.4372, 5.9714),
    "Dutch Grand Prix":          (52.3888, 4.5409),
    "Italian Grand Prix":        (45.6156, 9.2811),
    "Azerbaijan Grand Prix":     (40.3725, 49.8533),
    "Singapore Grand Prix":      (1.2914, 103.8640),
    "United States Grand Prix":  (30.1328, -97.6411),
    "Mexico City Grand Prix":    (19.4042, -99.0907),
    "São Paulo Grand Prix":      (-23.7036, -46.6997),
    "Las Vegas Grand Prix":      (36.1147, -115.1728),
    "Qatar Grand Prix":          (25.4900, 51.4542),
    "Abu Dhabi Grand Prix":      (24.4672, 54.6031),
    "Portuguese Grand Prix":     (37.2270, -8.6267),
    "French Grand Prix":         (43.2506, 5.7917),
    "Russian Grand Prix":        (43.4057, 39.9578),
    "Turkish Grand Prix":        (40.9517, 29.4050),
}


def _pedir(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "f1-predictor/1.0"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def coordenadas_de(event_name: str, location: str = "") -> tuple[float, float] | None:
    """Coordenadas del circuito. Si no esta en la tabla, geocodifica el lugar."""
    if event_name in COORDENADAS:
        return COORDENADAS[event_name]

    if not location:
        return None
    try:
        q = urllib.parse.quote(location)
        d = _pedir(f"https://geocoding-api.open-meteo.com/v1/search?name={q}&count=1")
        r = (d.get("results") or [None])[0]
        return (float(r["latitude"]), float(r["longitude"])) if r else None
    except Exception:
        return None


def desfase_pista(data: pd.DataFrame, event_name: str) -> float:
    """Cuanto mas caliente esta el asfalto que el aire, en ese circuito.

    Se calcula con nuestros propios datos historicos. En Bahrein, con sol y
    arena, el desfase supera los 15 C; en Spa, nublado, ronda los 5 C.
    """
    if not {"TempPista", "TempAire"} <= set(data.columns):
        return 8.0                      # valor de reserva razonable

    dif = data["TempPista"] - data["TempAire"]
    aqui = dif[data["EventName"] == event_name].dropna()
    if len(aqui) >= 2:
        return float(aqui.mean())
    global_ = dif.dropna()
    return float(global_.mean()) if len(global_) else 8.0


def pronostico(event_name: str, fecha: str, location: str = "",
               data: pd.DataFrame | None = None) -> dict | None:
    """Condiciones previstas para un Gran Premio.

    fecha en formato YYYY-MM-DD. Devuelve None si no hay pronostico disponible
    (Open-Meteo llega a ~16 dias vista; mas alla, el modelo usa la media
    historica del circuito).
    """
    coords = coordenadas_de(event_name, location)
    if coords is None:
        return None

    lat, lon = coords
    url = (f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
           "&daily=temperature_2m_max,precipitation_probability_max,windspeed_10m_max"
           "&forecast_days=16&timezone=auto")
    try:
        d = _pedir(url)
        dias = d["daily"]
        i = dias["time"].index(fecha)
    except Exception:
        return None

    temp_aire = dias["temperature_2m_max"][i]
    prob_lluvia = dias["precipitation_probability_max"][i]
    viento_kmh = dias["windspeed_10m_max"][i]

    if temp_aire is None:
        return None

    desfase = desfase_pista(data, event_name) if data is not None else 8.0

    return {
        "TempAire":  float(temp_aire),
        # El asfalto no lo mide nadie: aire + desfase historico del circuito.
        "TempPista": float(temp_aire) + desfase,
        # Open-Meteo da km/h; FastF1 registra m/s.
        "Viento":    float(viento_kmh) / 3.6 if viento_kmh is not None else np.nan,
        # Al entrenar, Lluvia es 0 o 1 (llovio o no). Aqui entra la probabilidad
        # del pronostico, que el arbol interpreta con sus mismos cortes.
        "Lluvia":    (float(prob_lluvia) / 100.0) if prob_lluvia is not None else 0.0,
        "prob_lluvia_pct": prob_lluvia,
        "fuente": "Open-Meteo",
    }


# ------------------------------- prueba rapida -------------------------------
if __name__ == "__main__":
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent))

    for ev, f in [("Dutch Grand Prix", "2026-08-30"),
                  ("Italian Grand Prix", "2026-09-06")]:
        p = pronostico(ev, f)
        print(f"{ev} ({f}):")
        if p:
            print(f"   aire {p['TempAire']:.1f}C | pista ~{p['TempPista']:.1f}C | "
                  f"viento {p['Viento']:.1f} m/s | lluvia {p['prob_lluvia_pct']}%")
        else:
            print("   sin pronostico (fuera de rango o circuito desconocido)")
