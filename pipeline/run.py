"""Punto de entrada del pipeline.

    python pipeline/run.py                 # usa el dataset ya descargado
    python pipeline/run.py --refrescar     # vuelve a bajar datos (tras cada GP)
    python pipeline/run.py --eventos 3     # solo predice las 3 proximas carreras

Al terminar, la carpeta web/data queda lista y la pagina funciona.
"""
from __future__ import annotations

import argparse
import sys
import time

import pandas as pd

import features
from config import WEB_DATA, YEARS
from data import calendario_futuro, construir_dataset
from export import (exportar_clasificacion, exportar_evento, exportar_indice,
                    exportar_backtest, exportar_mercado, exportar_metricas,
                    exportar_pilotos,
                    exportar_resultados, slug)
from features import preparar
from models import entrenar


def _eventos_a_predecir(data: pd.DataFrame, maximo: int | None) -> list[dict]:
    """Proximas carreras del calendario. Si la temporada acabo, re-simula la ultima.

    maximo=None devuelve TODAS las que quedan, y esa distincion importa: para la
    web exportamos solo unas pocas (cada JSON pesa 53 KB), pero la simulacion
    del campeonato necesita el calendario completo. Simulando solo las 4 que se
    exportaban se ignoraban 175 puntos en juego y salia un absurdo 100 % de
    probabilidad de titulo.
    """
    temporada = int(data["Year"].max())
    fut = calendario_futuro(temporada)

    eventos = []
    if len(fut):
        for r in (fut if maximo is None else fut.head(maximo)).itertuples():
            nombre = r.EventName
            eventos.append({
                "evento": nombre,
                "slug": slug(f"{temporada}-{nombre}"),
                "lugar": getattr(r, "Location", ""),
                "pais": getattr(r, "Country", ""),
                "fecha": pd.to_datetime(r.EventDate).strftime("%Y-%m-%d"),
                "ronda": int(r.RoundNumber),
                "anio": temporada,
                "futuro": True,
            })
        return eventos

    # Temporada terminada: predecimos sobre la ultima carrera disputada, que
    # sirve para comparar prediccion vs resultado real.
    ult = data.sort_values("Date").iloc[-1]
    print("\n(!) No quedan carreras por disputar: re-simulando la ultima.")
    return [{
        "evento": ult["EventName"],
        "slug": slug(f"{int(ult['Year'])}-{ult['EventName']}"),
        "lugar": ult["Location"],
        "pais": ult.get("Country", ""),
        "fecha": pd.to_datetime(ult["Date"]).strftime("%Y-%m-%d"),
        "ronda": int(ult["Round"]),
        "anio": int(ult["Year"]),
        "futuro": False,
    }]


def main() -> int:
    ap = argparse.ArgumentParser(description="Pipeline de prediccion de F1")
    ap.add_argument("--refrescar", action="store_true",
                    help="descarga incrementalmente las carreras que falten")
    ap.add_argument("--reconstruir", action="store_true",
                    help="rehace el dataset desde cero (raro: solo si se corrompe)")
    ap.add_argument("--anios", type=int, nargs="+", default=YEARS,
                    help="temporadas a incluir")
    ap.add_argument("--eventos", type=int, default=5,
                    help="cuantas carreras futuras predecir (default 5)")
    ap.add_argument("--simulaciones", type=int, default=4000,
                    help="temporadas a simular para el campeonato (default 4000)")
    args = ap.parse_args()

    t0 = time.time()

    print("=" * 64)
    print("  1/4  DATOS")
    print("=" * 64)
    raw = construir_dataset(args.anios, refrescar=args.refrescar,
                            reconstruir=args.reconstruir)

    print("\n" + "=" * 64)
    print("  2/4  FEATURES")
    print("=" * 64)
    features.limpiar_cache()
    df, data = preparar(raw)
    print(f"Dataset entrenable: {data.shape[0]} filas x {len(data.columns)} columnas")
    print(f"Pilotos distintos : {data['DriverId'].nunique()}")
    print(f"Equipos distintos : {data['TeamName'].nunique()}")

    print("\n" + "=" * 64)
    print("  3/4  MODELOS")
    print("=" * 64)
    modelos = entrenar(data)

    print("\n" + "=" * 64)
    print("  4/4  EXPORTACION A JSON")
    print("=" * 64)
    exportar_metricas(modelos["metricas"])
    exportar_pilotos(data)
    exportar_resultados(data)
    exportar_clasificacion(data)
    exportar_backtest(data, modelos)

    eventos = _eventos_a_predecir(data, args.eventos)
    for ev in eventos:
        print(f"\n   Prediciendo: {ev['evento']} ({ev['fecha']})")
        exportar_evento(data, modelos, ev)

    # La simulacion usa el calendario ENTERO que queda, no solo lo exportado.
    todas = _eventos_a_predecir(data, None)
    exportar_mercado(data, modelos, todas, n_sim=args.simulaciones)
    exportar_indice(data, modelos["metricas"], eventos)

    print("\n" + "=" * 64)
    print(f"  LISTO en {time.time() - t0:.0f}s. JSON en: {WEB_DATA}")
    print("  Levanta la web con:  python -m http.server 8000 --directory web")
    print("=" * 64)
    return 0


if __name__ == "__main__":
    sys.exit(main())
