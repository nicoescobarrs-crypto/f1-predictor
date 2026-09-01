"""Descarga de resultados historicos de F1 usando FastF1.

FastF1 tira de la API oficial de F1 y del Ergast historico. De cada Gran Premio
traemos tres cosas:
  - resultados de carrera (sin telemetria ni vueltas: dos ordenes de magnitud
    mas rapido y es lo que necesita el modelo)
  - el clima registrado durante la carrera
  - los tiempos de la clasificacion del sabado
"""
from __future__ import annotations

import warnings

import fastf1
import numpy as np
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
def _segundos(serie) -> pd.Series:
    """Convierte los tiempos de vuelta de FastF1 (timedelta) a segundos."""
    return pd.to_timedelta(serie, errors="coerce").dt.total_seconds()


def clasificacion_de(year: int, rnd: int) -> pd.DataFrame | None:
    """Mejor vuelta de cada piloto en la qualy y su distancia a la pole.

    La parrilla solo dice el ORDEN; el tiempo dice el RITMO. No es lo mismo ser
    segundo a 0.05s que a 1.2s, y para el modelo ambos casos eran "P2".

    Sin riesgo de fuga: la clasificacion se disputa el sabado, antes de la carrera.
    """
    try:
        q = fastf1.get_session(year, rnd, "Q")
        q.load(laps=False, telemetry=False, weather=False, messages=False)
        res = q.results
        if res is None or len(res) == 0:
            return None

        cols = [c for c in ("Q1", "Q2", "Q3") if c in res.columns]
        if not cols:
            return None

        mejor = pd.concat([_segundos(res[c]) for c in cols], axis=1).min(axis=1)
        if mejor.notna().sum() == 0:
            return None

        pole = mejor.min()
        rango = mejor.max() - pole

        return pd.DataFrame({
            "DriverId":  res["DriverId"].values,
            "Q_Mejor":   mejor.values,
            "Q_GapPole": (mejor - pole).values,
            # Normalizado por la dispersion del dia: hay circuitos donde todos
            # van mas apretados, asi el 0-1 es comparable entre carreras.
            "Q_GapNorm": ((mejor - pole) / rango).values if rango and rango > 0
                         else [0.0] * len(mejor),
        })
    except Exception:
        return None


def clima_de(ses) -> dict:
    """Resumen del clima durante la carrera.

    OJO: se mide DURANTE la carrera. Al entrenar usamos lo observado; al predecir
    una carrera futura hay que darle el pronostico. Es lo habitual con variables
    exogenas, pero conviene decirlo en vez de esconderlo.
    """
    vacio = {"TempAire": np.nan, "TempPista": np.nan, "Humedad": np.nan,
             "Viento": np.nan, "Lluvia": 0}
    try:
        w = ses.weather_data
        if w is None or len(w) == 0:
            return vacio
        return {
            "TempAire":  float(w["AirTemp"].mean()),
            "TempPista": float(w["TrackTemp"].mean()),
            "Humedad":   float(w["Humidity"].mean()),
            "Viento":    float(w["WindSpeed"].mean()),
            "Lluvia":    int(bool(w["Rainfall"].any())),
        }
    except Exception:
        return vacio


def cargar_carrera(year: int, rnd: int) -> pd.DataFrame:
    """Resultados de una carrera, con su clima y su clasificacion."""
    ses = fastf1.get_session(year, rnd, "R")
    ses.load(laps=False, telemetry=False, weather=True, messages=False)

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

    # Clima: el mismo valor para todos los pilotos de esa carrera
    for k, v in clima_de(ses).items():
        df[k] = v

    # Clasificacion: un valor por piloto. Si no hay datos quedan a NaN, y
    # HistGradientBoosting los admite de forma nativa, sin imputar nada.
    q = clasificacion_de(year, rnd)
    if q is not None:
        df = df.merge(q, on="DriverId", how="left")
    else:
        df["Q_Mejor"] = df["Q_GapPole"] = df["Q_GapNorm"] = np.nan

    return df


class LimiteAlcanzado(RuntimeError):
    """FastF1 permite 500 llamadas por hora. Al superarlas hay que esperar."""


def _es_limite(e: Exception) -> bool:
    return "500 calls/h" in str(e) or "rate limit" in str(e).lower()


def carreras_del_calendario(year: int) -> list[tuple[int, str]]:
    """(ronda, nombre) de las carreras de ese ano ya disputadas."""
    try:
        cal = fastf1.get_event_schedule(year, include_testing=False)
    except Exception as e:
        print(f"  x Calendario {year} no disponible: {e}")
        return []

    hoy = pd.Timestamp.today().normalize()
    cal = cal[pd.to_datetime(cal["EventDate"]) <= hoy]
    return [(int(ev.RoundNumber), ev.EventName) for ev in cal.itertuples()]


def cargar_temporada(year: int, verbose: bool = True,
                     omitir: set[tuple[int, int]] | None = None) -> list[pd.DataFrame]:
    """Carreras de una temporada, saltando las que ya tengamos.

    Lanza LimiteAlcanzado si se agota la cuota horaria de la API, para que quien
    llama pueda guardar lo descargado hasta ese momento en vez de perderlo.
    """
    omitir = omitir or set()
    salida: list[pd.DataFrame] = []

    for rnd, nombre in carreras_del_calendario(year):
        if (year, rnd) in omitir:
            continue
        try:
            salida.append(cargar_carrera(year, rnd))
            if verbose:
                print(f"  + {year} R{rnd:02d} {nombre}")
        except Exception as e:
            if _es_limite(e):
                raise LimiteAlcanzado(
                    f"cuota agotada en {year} R{rnd:02d}") from e
            if verbose:
                print(f"  x {year} R{rnd:02d} {nombre}: {e}")
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
                      refrescar: bool = False,
                      reconstruir: bool = False) -> pd.DataFrame:
    """Dataset crudo de todas las temporadas.

    Tres modos:
      refrescar=False   reutiliza el parquet guardado (instantaneo)
      refrescar=True    INCREMENTAL: solo baja las carreras que falten
      reconstruir=True  empieza de cero (raro; solo si el fichero se corrompe)

    El modo incremental es lo que hace que esto sea seguro. FastF1 permite 500
    llamadas por hora y cada carrera gasta varias entre la sesion de carrera y
    la de clasificacion, asi que una descarga completa no cabe en una sola
    tanda. Guardando despues de cada temporada y saltando lo ya descargado, se
    puede reanudar tantas veces como haga falta sin perder nada.
    """
    years = years or YEARS
    previo = None if reconstruir else _leer()

    if not refrescar and not reconstruir:
        if previo is not None:
            print(f"Dataset leido de disco: {len(previo)} filas "
                  f"({previo.groupby(['Year','Round']).ngroups} carreras)")
            return previo
        print("No hay dataset guardado: se descarga por primera vez.")

    ya = set()
    if previo is not None and len(previo):
        ya = set(zip(previo["Year"].astype(int), previo["Round"].astype(int)))
        print(f"Ya en disco: {len(ya)} carreras. Se descargan solo las que falten.")

    frames: list[pd.DataFrame] = []
    corte = False

    for y in years:
        pendientes = [r for r, _ in carreras_del_calendario(y) if (y, r) not in ya]
        if not pendientes:
            print(f"\nTemporada {y}: al dia")
            continue

        print(f"\nTemporada {y}: faltan {len(pendientes)} carreras")
        try:
            frames.extend(cargar_temporada(y, omitir=ya))
        except LimiteAlcanzado as e:
            print(f"\n  (!) {e}")
            print("      Se guarda lo descargado. Vuelve a ejecutarlo dentro de")
            print("      una hora y continuara donde lo dejo.")
            corte = True
        # Guardar tras cada temporada: si la cuota se agota, no se pierde nada.
        if frames:
            _guardar(_unir(previo, frames))
        if corte:
            break

    raw = _unir(previo, frames)
    if raw is None or not len(raw):
        raise RuntimeError("No hay ninguna carrera descargada. Revisa tu conexion.")

    _guardar(raw)
    n = raw.groupby(["Year", "Round"]).ngroups
    print(f"\n{len(raw)} resultados de {n} carreras"
          + ("  (descarga incompleta)" if corte else ""))
    return raw


def _unir(previo: pd.DataFrame | None,
          nuevos: list[pd.DataFrame]) -> pd.DataFrame | None:
    """Combina lo que ya habia con lo recien descargado, sin duplicar carreras."""
    partes = [p for p in ([previo] if previo is not None else []) + nuevos
              if p is not None and len(p)]
    if not partes:
        return None

    raw = pd.concat(partes, ignore_index=True)
    # Si una carrera se vuelve a bajar (por ejemplo para anadirle la qualy),
    # se queda la version mas reciente.
    raw = raw.drop_duplicates(subset=["Year", "Round", "DriverId"], keep="last")
    return raw.sort_values(["Year", "Round"]).reset_index(drop=True)
