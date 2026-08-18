"""Banco de pruebas: compara variantes del regresor contra el baseline.

No forma parte del pipeline. Sirve para justificar en el informe POR QUE
elegimos una configuracion y no otra.

    python pipeline/experimento.py
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error

from config import FEATURES, RANDOM_STATE
from data import construir_dataset
from features import preparar
from models import pesos_recencia, split_temporal


def evaluar(nombre, pred, yte, Xte, extra=""):
    mae = mean_absolute_error(yte, pred)
    base = mean_absolute_error(yte, Xte["GridPosition"])
    print(f"  {nombre:<38} MAE {mae:5.3f}   mejora {100*(1-mae/base):+6.2f}%  {extra}")
    return mae


def main():
    raw = construir_dataset(refrescar=False)
    _, data = preparar(raw)

    mask_tr, corte = split_temporal(data)
    X, y = data[FEATURES], data["Position"]
    w = pesos_recencia(data)
    Xtr, Xte = X[mask_tr], X[~mask_tr]
    ytr, yte = y[mask_tr], y[~mask_tr]
    wtr = w[mask_tr]

    base = mean_absolute_error(yte, Xte["GridPosition"])
    print(f"\nCorte: {int(corte['Year'])} R{int(corte['Round'])} | "
          f"train {mask_tr.sum()} / test {(~mask_tr).sum()}")
    print(f"BASELINE (termina donde sale)          MAE {base:5.3f}\n")

    # ---- A. Configuracion actual: predecir la posicion directamente ----
    print("A) Objetivo = posicion final")
    for lr, it, depth in [(0.05, 500, 6), (0.05, 300, 4), (0.03, 400, 3)]:
        m = HistGradientBoostingRegressor(
            loss="absolute_error", max_iter=it, learning_rate=lr, max_depth=depth,
            l2_regularization=1.0, random_state=RANDOM_STATE)
        m.fit(Xtr, ytr, sample_weight=wtr)
        evaluar(f"lr={lr} iter={it} depth={depth}", m.predict(Xte), yte, Xte)

    # ---- B. Objetivo = posiciones ganadas (residuo sobre la parrilla) ----
    # El modelo ya no tiene que reaprender la relacion salida->llegada:
    # solo aprende la DESVIACION respecto a ella.
    print("\nB) Objetivo = posiciones ganadas (grid - pos), luego pos = grid - pred")
    gain_tr = (data["GridPosition"] - data["Position"])[mask_tr]
    for lr, it, depth in [(0.05, 500, 6), (0.05, 300, 4), (0.03, 400, 3)]:
        m = HistGradientBoostingRegressor(
            loss="absolute_error", max_iter=it, learning_rate=lr, max_depth=depth,
            l2_regularization=1.0, random_state=RANDOM_STATE)
        m.fit(Xtr, gain_tr, sample_weight=wtr)
        pred = np.clip(Xte["GridPosition"] - m.predict(Xte), 1, 20)
        evaluar(f"lr={lr} iter={it} depth={depth}", pred, yte, Xte)

    # ---- C. Sin pesos de recencia ----
    print("\nC) Objetivo = posiciones ganadas, SIN pesos de recencia")
    m = HistGradientBoostingRegressor(
        loss="absolute_error", max_iter=300, learning_rate=0.05, max_depth=4,
        l2_regularization=1.0, random_state=RANDOM_STATE)
    m.fit(Xtr, gain_tr)
    pred = np.clip(Xte["GridPosition"] - m.predict(Xte), 1, 20)
    evaluar("lr=0.05 iter=300 depth=4", pred, yte, Xte)

    # ---- D. Solo temporadas recientes ----
    print("\nD) Objetivo = posiciones ganadas, entrenando solo desde 2024")
    reciente = mask_tr & (data["Year"] >= 2024)
    m = HistGradientBoostingRegressor(
        loss="absolute_error", max_iter=300, learning_rate=0.05, max_depth=4,
        l2_regularization=1.0, random_state=RANDOM_STATE)
    m.fit(X[reciente], (data["GridPosition"] - data["Position"])[reciente])
    pred = np.clip(Xte["GridPosition"] - m.predict(Xte), 1, 20)
    evaluar(f"train={reciente.sum()} filas", pred, yte, Xte)

    # ---- E. Cuanto pesa el cambio de reglamento de 2026 ----
    print("\nE) Desglose del test por temporada (config B, depth=4)")
    m = HistGradientBoostingRegressor(
        loss="absolute_error", max_iter=300, learning_rate=0.05, max_depth=4,
        l2_regularization=1.0, random_state=RANDOM_STATE)
    m.fit(Xtr, gain_tr, sample_weight=wtr)
    test = data[~mask_tr].copy()
    test["pred"] = np.clip(Xte["GridPosition"] - m.predict(Xte), 1, 20).values
    for anio, g in test.groupby("Year"):
        mae_m = mean_absolute_error(g["Position"], g["pred"])
        mae_b = mean_absolute_error(g["Position"], g["GridPosition"])
        print(f"  {int(anio)}  n={len(g):4d}   modelo {mae_m:5.3f}   "
              f"baseline {mae_b:5.3f}   mejora {100*(1-mae_m/mae_b):+6.2f}%")


if __name__ == "__main__":
    main()
