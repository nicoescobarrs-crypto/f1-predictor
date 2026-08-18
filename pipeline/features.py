"""Limpieza e ingenieria de variables.

REGLA DE ORO: toda feature historica usa .shift(1) antes de la ventana movil.
Si no, el modelo veria el resultado de la propia carrera que intenta predecir
(fuga de datos) y las metricas saldrian buenisimas pero falsas.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from config import (DNF_WINDOW, FEATURES, FORM_WINDOW, STREET_TRACKS,
                    TEAM_WINDOW)


# ------------------------------ UTILIDADES --------------------------------
def es_calle(location: str, event_name: str = "") -> int:
    """1 si el trazado es urbano/semiurbano, 0 si es permanente."""
    txt = f"{location} {event_name}".lower()
    return int(any(t in txt for t in STREET_TRACKS))


# Estados que significan "el coche llego al final", aunque sea doblado.
# OJO: FastF1 usa tres formas distintas para lo mismo y es facil dejarse una:
#   'Finished'  -> termino en la vuelta del lider
#   '+1 Lap'    -> termino doblado (a veces '+2 Laps', '+3 Laps')
#   'Lapped'    -> termino doblado, otra etiqueta para el mismo caso
# Contar 'Lapped' como abandono inflaba la tasa de DNF en 372 filas de 2520.
FINALIZO_EXACTO = {"Finished", "Lapped"}


def _termino(status) -> bool:
    """True si el piloto vio la bandera a cuadros."""
    s = str(status).strip()
    return s in FINALIZO_EXACTO or s.startswith("+")


# ------------------------------ LIMPIEZA ----------------------------------
def limpiar(raw: pd.DataFrame) -> pd.DataFrame:
    df = raw.copy()

    df["Position"]     = pd.to_numeric(df["Position"], errors="coerce")
    df["GridPosition"] = pd.to_numeric(df["GridPosition"], errors="coerce")
    df["Points"]       = pd.to_numeric(df["Points"], errors="coerce").fillna(0)

    df["FieldSize"] = df.groupby(["Year", "Round"])["DriverId"].transform("count")

    # Un abandono no tiene posicion: lo tratamos como ultimo clasificado.
    df["Position"] = df["Position"].fillna(df["FieldSize"])

    # GridPosition 0 = salida desde el pit lane -> tratarla como ultimo puesto.
    sin_grid = df["GridPosition"].isna() | (df["GridPosition"] <= 0)
    df.loc[sin_grid, "GridPosition"] = df.loc[sin_grid, "FieldSize"]

    df["DNF"]      = (~df["Status"].apply(_termino)).astype(int)
    df["PosGain"]  = df["GridPosition"] - df["Position"]
    df["IsStreet"] = [es_calle(l, e) for l, e in zip(df["Location"], df["EventName"])]

    return df.sort_values(["Date", "Year", "Round"]).reset_index(drop=True)


# --------------------------- FEATURES HISTORICAS ---------------------------
def construir_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    gd = df.groupby("DriverId", group_keys=False)
    df["Drv_FormPos"]   = gd["Position"].transform(
        lambda s: s.shift(1).rolling(FORM_WINDOW, min_periods=1).mean())
    df["Drv_FormGrid"]  = gd["GridPosition"].transform(
        lambda s: s.shift(1).rolling(FORM_WINDOW, min_periods=1).mean())
    df["Drv_CareerPos"] = gd["Position"].transform(
        lambda s: s.shift(1).expanding().mean())
    df["Drv_DNFRate"]   = gd["DNF"].transform(
        lambda s: s.shift(1).rolling(DNF_WINDOW, min_periods=1).mean())
    df["Drv_Gain"]      = gd["PosGain"].transform(
        lambda s: s.shift(1).rolling(DNF_WINDOW, min_periods=1).mean())
    df["Drv_Exp"]       = gd["Position"].transform(
        lambda s: s.shift(1).expanding().count())

    gt = df.groupby("TeamName", group_keys=False)
    df["Team_FormPos"] = gt["Position"].transform(
        lambda s: s.shift(1).rolling(TEAM_WINDOW, min_periods=1).mean())
    df["Team_DNFRate"] = gt["DNF"].transform(
        lambda s: s.shift(1).rolling(TEAM_WINDOW * 2, min_periods=1).mean())
    df["Team_FormPts"] = gt["Points"].transform(
        lambda s: s.shift(1).rolling(TEAM_WINDOW, min_periods=1).mean())

    # Historial del piloto y del equipo EN ESE circuito (ediciones anteriores)
    df["Drv_TrackPos"] = (df.groupby(["DriverId", "EventName"], group_keys=False)["Position"]
                            .transform(lambda s: s.shift(1).expanding().mean()))
    df["Team_TrackPos"] = (df.groupby(["TeamName", "EventName"], group_keys=False)["Position"]
                             .transform(lambda s: s.shift(1).expanding().mean()))

    # Duelo con el companero de equipo en la parrilla de ESTA carrera.
    # No es fuga: la parrilla se conoce antes de que empiece la carrera.
    tm = df.groupby(["Year", "Round", "TeamName"])["GridPosition"]
    mate = (tm.transform("sum") - df["GridPosition"]) / (tm.transform("count") - 1).replace(0, np.nan)
    df["TeammateGridDelta"] = (df["GridPosition"] - mate).fillna(0.0)

    df["GridNorm"] = df["GridPosition"] / df["FieldSize"]

    return df


def preparar(raw: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """raw -> (df completo con features, dataset entrenable).

    El entrenable descarta la primera carrera de cada piloto, que no tiene
    ningun historial previo del que aprender.
    """
    df   = construir_features(limpiar(raw))
    data = df[df["Drv_FormPos"].notna()].reset_index(drop=True)
    return df, data


# --------------------- FEATURES PARA UNA CARRERA FUTURA --------------------
def parrilla_actual(data: pd.DataFrame) -> pd.DataFrame:
    """Pilotos de la ultima carrera disputada, con su equipo actual."""
    ult = data.sort_values(["Date", "Year", "Round"]).iloc[-1]
    campo = data[(data["Year"] == ult["Year"]) & (data["Round"] == ult["Round"])]
    cols = ["DriverId", "Abbreviation", "FullName", "TeamName", "DriverNumber"]
    return campo[cols].reset_index(drop=True)


# Filtrar el historial de un piloto es barato, pero la curva de sensibilidad
# de la web lo hace cientos de veces por carrera. Lo cacheamos: dentro de una
# ejecucion del pipeline el dataset no cambia.
_CACHE_ESTADOS: dict[str, dict] = {}


def limpiar_cache() -> None:
    """Vacia el cache de estados. Llamar si se recarga el dataset."""
    _CACHE_ESTADOS.clear()


def _estado_piloto(data: pd.DataFrame, driver_id: str) -> dict:
    """Ultimo estado conocido de un piloto y de su equipo."""
    if driver_id in _CACHE_ESTADOS:
        return _CACHE_ESTADOS[driver_id]

    h = data[data["DriverId"] == driver_id].sort_values("Date")
    if h.empty:
        raise ValueError(f"Sin historial para {driver_id}")

    equipo = h["TeamName"].iloc[-1]
    th = data[data["TeamName"] == equipo].sort_values("Date")

    # Precalculamos los agregados, que son constantes para todo escenario:
    # lo unico que cambia al mover la parrilla son las columnas de grid.
    estado = {
        "h": h, "equipo": equipo, "th": th,
        "agg": {
            "Abbreviation":  h["Abbreviation"].iloc[-1],
            "FullName":      h["FullName"].iloc[-1],
            "Drv_FormPos":   h["Position"].tail(FORM_WINDOW).mean(),
            "Drv_FormGrid":  h["GridPosition"].tail(FORM_WINDOW).mean(),
            "Drv_CareerPos": h["Position"].mean(),
            "Drv_DNFRate":   h["DNF"].tail(DNF_WINDOW).mean(),
            "Drv_Gain":      h["PosGain"].tail(DNF_WINDOW).mean(),
            "Drv_Exp":       float(len(h)),
            "Team_FormPos":  th["Position"].tail(TEAM_WINDOW).mean(),
            "Team_DNFRate":  th["DNF"].tail(TEAM_WINDOW * 2).mean(),
            "Team_FormPts":  th["Points"].tail(TEAM_WINDOW).mean(),
        },
        "track": {},  # historial por circuito, se rellena bajo demanda
    }
    _CACHE_ESTADOS[driver_id] = estado
    return estado


def _hist_circuito(estado: dict, event_name: str) -> tuple[float, float]:
    """Media del piloto y de su equipo en ese Gran Premio (NaN si es nuevo)."""
    if event_name not in estado["track"]:
        h, th = estado["h"], estado["th"]
        drv = h.loc[h["EventName"] == event_name, "Position"]
        team = th.loc[th["EventName"] == event_name, "Position"]
        estado["track"][event_name] = (
            drv.mean() if len(drv) else np.nan,
            team.mean() if len(team) else np.nan,
        )
    return estado["track"][event_name]


def construir_filas(data: pd.DataFrame,
                    entradas: list[dict],
                    event_name: str,
                    location: str = "",
                    rnd: int | None = None) -> pd.DataFrame:
    """Construye la matriz de features para una carrera hipotetica.

    entradas: lista de dicts con driver_id y grid.

    A diferencia de predecir piloto a piloto, aqui conocemos la parrilla
    completa, asi que TeammateGridDelta sale exacto en vez de estimado.
    """
    field_size = len(entradas)
    if rnd is None:
        rnd = int(data["Round"].median())
    urbano = es_calle(location, event_name)

    # Mapa equipo -> lista de (driver_id, grid) para el duelo con el companero
    por_equipo: dict[str, list[tuple[str, float]]] = {}
    estados: dict[str, dict] = {}
    for e in entradas:
        st = _estado_piloto(data, e["driver_id"])
        estados[e["driver_id"]] = st
        por_equipo.setdefault(st["equipo"], []).append((e["driver_id"], float(e["grid"])))

    filas = []
    for e in entradas:
        did  = e["driver_id"]
        grid = float(e["grid"])
        st   = estados[did]
        equipo = st["equipo"]

        companeros = [g for d, g in por_equipo[equipo] if d != did]
        mate_delta = grid - float(np.mean(companeros)) if companeros else 0.0

        drv_track, team_track = _hist_circuito(st, event_name)

        filas.append({
            "DriverId":     did,
            "TeamName":     equipo,
            "GridPosition": grid,
            "GridNorm":     grid / field_size,
            "FieldSize":    float(field_size),
            "IsStreet":     urbano,
            "Round":        rnd,
            "Drv_TrackPos":  drv_track,
            "Team_TrackPos": team_track,
            "TeammateGridDelta": mate_delta,
            **st["agg"],
        })

    return pd.DataFrame(filas)


def matriz(filas: pd.DataFrame) -> pd.DataFrame:
    """Extrae solo las columnas de features, en el orden que espera el modelo."""
    return filas[FEATURES]
