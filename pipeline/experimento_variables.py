"""Mide si las variables nuevas (clasificacion y clima) mejoran el modelo.

No basta con anadir variables: hay que demostrar que aportan. Con ~2000 filas,
cada variable de mas es capacidad que el modelo puede gastar en memorizar ruido.

    python pipeline/experimento_variables.py

Compara cuatro conjuntos entrenando exactamente igual y con el mismo corte
temporal, para que la unica diferencia sean las columnas.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import (HistGradientBoostingClassifier,
                              HistGradientBoostingRegressor)
from sklearn.metrics import mean_absolute_error, roc_auc_score

from config import CLF_PARAMS, FEATURES, RANDOM_STATE, REG_PARAMS
from data import construir_dataset
from features import preparar
from models import pesos_recencia, split_temporal

QUALY = ["Q_GapPole", "Q_GapNorm"]
CLIMA = ["TempPista", "Viento", "Lluvia"]
BASE = [f for f in FEATURES if f not in QUALY + CLIMA]

CONJUNTOS = {
    "Base (17 variables)":        BASE,
    "Base + clasificacion":       BASE + QUALY,
    "Base + clima":               BASE + CLIMA,
    "Todo (22 variables)":        BASE + QUALY + CLIMA,
}


def evaluar(data: pd.DataFrame, cols: list[str],
            test_fraction: float = 0.15) -> dict:
    mask_tr, _ = split_temporal(data, test_fraction)
    X = data[cols]
    y = data["Position"]
    ganancia = data["GridPosition"] - data["Position"]
    w = pesos_recencia(data)

    Xtr, Xte = X[mask_tr], X[~mask_tr]
    yte = y[~mask_tr]

    reg = HistGradientBoostingRegressor(random_state=RANDOM_STATE, **REG_PARAMS)
    reg.fit(Xtr, ganancia[mask_tr], sample_weight=w[mask_tr])

    n_max = float(data["FieldSize"].max())
    pred = np.clip(Xte["GridPosition"] - reg.predict(Xte), 1, n_max)

    mae = float(mean_absolute_error(yte, pred))
    base = float(mean_absolute_error(yte, Xte["GridPosition"]))

    # Acierto del ganador, que es lo que de verdad se ve en la web
    t = data[~mask_tr].copy()
    t["pred"] = np.asarray(pred)
    aciertos = 0
    for _, g in t.groupby(["Year", "Round"]):
        aciertos += int(g.loc[g["Position"].idxmin(), "DriverId"] ==
                        g.loc[g["pred"].idxmin(), "DriverId"])
    n_carreras = t.groupby(["Year", "Round"]).ngroups

    # AUC de victoria
    victoria = (data["Position"] == 1).astype(int)
    clf = HistGradientBoostingClassifier(random_state=RANDOM_STATE, **CLF_PARAMS)
    clf.fit(Xtr, victoria[mask_tr], sample_weight=w[mask_tr])
    try:
        auc = float(roc_auc_score(victoria[~mask_tr], clf.predict_proba(Xte)[:, 1]))
    except ValueError:
        auc = float("nan")

    return {
        "mae": mae,
        "mejora": 100 * (1 - mae / base),
        "ganador": 100 * aciertos / max(n_carreras, 1),
        "auc": auc,
        "n": len(cols),
    }


def evaluar_robusto(data: pd.DataFrame, cols: list[str],
                    fracciones=(0.10, 0.15, 0.20, 0.25, 0.30)) -> dict:
    """Repite la evaluacion moviendo el corte temporal.

    Con un solo corte, una diferencia de 0.01 en el MAE no significa nada: puede
    depender por completo de que carreras cayeron en el test. Promediando varios
    cortes se ve si la mejora es real o casualidad.
    """
    maes, mejoras = [], []
    for f in fracciones:
        r = evaluar(data, cols, test_fraction=f)
        maes.append(r["mae"])
        mejoras.append(r["mejora"])
    return {
        "mae": float(np.mean(maes)),
        "sd": float(np.std(maes)),
        "mejora": float(np.mean(mejoras)),
        "n": len(cols),
    }


def main() -> None:
    raw = construir_dataset(refrescar=False)
    _, data = preparar(raw)

    faltan = [c for c in QUALY + CLIMA if c not in data.columns]
    if faltan:
        print(f"\nFaltan columnas: {faltan}")
        print("Ejecuta primero:  python pipeline/run.py --refrescar")
        return

    cobertura = data[QUALY[0]].notna().mean() * 100
    print(f"\nFilas con tiempo de clasificacion: {cobertura:.1f}%")
    print(f"Carreras con lluvia registrada    : {int(data.groupby(['Year','Round'])['Lluvia'].first().sum())}"
          f" de {data.groupby(['Year','Round']).ngroups}")

    print(f"\n{'CONJUNTO':<26} {'VARS':>5} {'MAE':>7} {'MEJORA':>8} {'GANADOR':>8} {'AUC VIC':>8}")
    print("-" * 66)

    ref = None
    for nombre, cols in CONJUNTOS.items():
        r = evaluar(data, cols)
        if ref is None:
            ref = r["mae"]
        delta = f"{r['mae'] - ref:+.3f}" if r["mae"] != ref else "  base"
        print(f"{nombre:<26} {r['n']:>5} {r['mae']:>7.3f} {r['mejora']:>7.1f}% "
              f"{r['ganador']:>7.0f}% {r['auc']:>8.3f}   {delta}")

    print("\nUn solo corte no basta: repetimos moviendo la frontera.\n")
    print("PROMEDIO SOBRE 5 CORTES TEMPORALES (10 % a 30 % de test)")
    print(f"\n{'CONJUNTO':<26} {'VARS':>5} {'MAE MEDIO':>10} {'DESV':>7} {'MEJORA':>8}")
    print("-" * 62)

    ref = None
    for nombre, cols in CONJUNTOS.items():
        r = evaluar_robusto(data, cols)
        if ref is None:
            ref = r["mae"]
        delta = "  base" if r["mae"] == ref else f"{r['mae'] - ref:+.3f}"
        print(f"{nombre:<26} {r['n']:>5} {r['mae']:>10.3f} {r['sd']:>7.3f} "
              f"{r['mejora']:>7.1f}%   {delta}")

    print("\nSi la diferencia entre conjuntos es menor que la desviacion entre")
    print("cortes, no hay evidencia de que uno sea mejor que otro.")


if __name__ == "__main__":
    main()
