"""Descarga de resultados historicos de F1 usando FastF1.

FastF1 tira de la API oficial de F1 y del Ergast historico. Pedimos SOLO los
resultados de carrera (sin telemetria ni vueltas) porque es dos ordenes de
magnitud mas rapido y es todo lo que necesita el modelo.
"""
from __future__ import annotations

import warnings

import fastf1
import pandas as pd

from config import CACHE_DIR, DATA_DIR, RESULT_COLS, YEARS

warnings.filterwarnings("ignore")

fastf1.Cache.enable_cache(str(CACHE_DIR))
try:
    fastf1.set_log_level("ERROR")
except Exception:
    pass

RAW_PATH = DATA_DIR / "raw_results"


# --------------------------------------------------------------------------
def cargar_carrera(year: int, rnd: int) -> pd.DataFrame:
    """Devuelve los resultados de una carrera como DataFrame."""
    ses = fastf1.get_session(year, rnd, "R")
    ses.load(laps=False, telemetry=False, weather=False, messages=False)

    res = ses.results
    if res is None or len(res) == 0:
        raise ValueError("sesion sin resultados")

    df = res[[c for c in RESULT_COLS if c in res.columns]].copy()
    df["Year"]      = year
    df["Round"]     = int(ses.event["RoundNumber"])
    df["EventName"] = ses.event["EventName"]
    df["Location"]  = ses.event["Location"]
    df["Country"]   = ses.event["Country"]
    df["Date"]      = pd.to_datetime(ses.event["EventDate"])
    return df


def cargar_temporada(year: int, verbose: bool = True) -> list[pd.DataFrame]:
    """Recorre el calendario oficial y trae todas las carreras ya disputadas."""
    salida: list[pd.DataFrame] = []
    try:
        cal = fastf1.get_event_schedule(year, include_testing=False)
    except Exception as e:
        print(f"  x Calendario {year} no disponible: {e}")
        return salida

    hoy = pd.Timestamp.today().normalize()
    cal = cal[pd.to_datetime(cal["EventDate"]) <= hoy]

    for ev in cal.itertuples():
        rnd = int(ev.RoundNumber)
        try:
            salida.append(cargar_carrera(year, rnd))
            if verbose:
                print(f"  + {year} R{rnd:02d} {ev.EventName}")
        except Exception as e:
            if verbose:
                print(f"  x {year} R{rnd:02d} {ev.EventName}: {e}")
    return salida


def calendario_futuro(year: int) -> pd.DataFrame:
    """Carreras del ano que todavia NO se han disputado (para predecir)."""
    try:
        cal = fastf1.get_event_schedule(year, include_testing=False)
    except Exception:
        return pd.DataFrame()

    hoy = pd.Timestamp.today().normalize()
    fut = cal[pd.to_datetime(cal["EventDate"]) > hoy].copy()
    cols = ["RoundNumber", "EventName", "Location", "Country", "EventDate"]
    return fut[[c for c in cols if c in fut.columns]].reset_index(drop=True)


# --------------------------------------------------------------------------
def _guardar(df: pd.DataFrame) -> None:
    try:
        df.to_parquet(RAW_PATH.with_suffix(".parquet"), index=False)
    except Exception:
        df.to_pickle(RAW_PATH.with_suffix(".pkl"))


def _leer() -> pd.DataFrame | None:
    for ext in (".parquet", ".pkl"):
        p = RAW_PATH.with_suffix(ext)
        if p.exists():
            try:
                return pd.read_parquet(p) if ext == ".parquet" else pd.read_pickle(p)
            except Exception:
                continue
    return None


def construir_dataset(years: list[int] | None = None,
                      refrescar: bool = False) -> pd.DataFrame:
    """Dataset crudo de todas las temporadas.

    Con refrescar=False reutiliza el parquet guardado, asi que las ejecuciones
    posteriores son instantaneas. Usa refrescar=True despues de cada carrera.
    """
    years = years or YEARS

    if not refrescar:
        cached = _leer()
        if cached is not None:
            print(f"Dataset leido de disco: {len(cached)} filas "
                  f"({cached.groupby(['Year','Round']).ngroups} carreras)")
            return cached

    frames: list[pd.DataFrame] = []
    for y in years:
        print(f"\nTemporada {y}")
        frames.extend(cargar_temporada(y))

    if not frames:
        raise RuntimeError("No se pudo descargar ninguna carrera. Revisa tu conexion.")

    raw = pd.concat(frames, ignore_index=True)
    _guardar(raw)
    print(f"\n{len(raw)} resultados de {raw.groupby(['Year','Round']).ngroups} carreras")
    return raw
