"""Entrenamiento y validacion de los modelos.

Dos piezas:
  1. Un REGRESOR que estima la posicion final (numero continuo).
  2. Cuatro CLASIFICADORES binarios que dan probabilidad de victoria, podio,
     puntos y abandono.

La validacion es TEMPORAL, nunca aleatoria: entrenamos con las primeras
carreras y probamos con las ultimas. Un split aleatorio dejaria carreras del
futuro en el entrenamiento y las metricas serian mentira.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import (HistGradientBoostingClassifier,
                              HistGradientBoostingRegressor)
from sklearn.inspection import permutation_importance
from sklearn.metrics import mean_absolute_error, roc_auc_score

from config import (CLF_PARAMS, FEATURES, MONOTONIA_CLF, MONOTONIA_REG,
                    RANDOM_STATE, RECENCY_DECAY, REG_PARAMS, TARGET_DEFS,
                    TEST_FRACTION, restricciones)


# Los clasificadores de sucesos raros salen poco confiados: medido sobre el
# conjunto de prueba, la victoria predice 0.025 de media cuando la tasa real es
# 0.047, y la suma de probabilidades por carrera da 0.53 en vez de 1.0. Corregir
# ese factor (~1.9x) es legitimo; dejar que la normalizacion amplifique sin
# limite, no. Este tope acota la correccion a lo que respalda la medicion.
AMPLIFICACION_MAX = 2.0


# ---------------------------- SPLIT TEMPORAL -------------------------------
def split_temporal(data: pd.DataFrame, test_fraction: float = TEST_FRACTION):
    """Devuelve la mascara booleana de entrenamiento y la carrera de corte."""
    carreras = (data[["Year", "Round"]].drop_duplicates()
                    .sort_values(["Year", "Round"]).reset_index(drop=True))
    idx_corte = int(len(carreras) * (1 - test_fraction))
    idx_corte = min(max(idx_corte, 1), len(carreras) - 1)
    corte = carreras.iloc[idx_corte]

    mask_tr = ((data["Year"] < corte["Year"]) |
               ((data["Year"] == corte["Year"]) & (data["Round"] < corte["Round"])))
    return mask_tr, corte


def pesos_recencia(data: pd.DataFrame) -> pd.Series:
    """Las temporadas viejas pesan menos: los coches y las reglas cambian."""
    return RECENCY_DECAY ** (data["Year"].max() - data["Year"])


# ------------------------------ ENTRENAMIENTO ------------------------------
def entrenar(data: pd.DataFrame) -> dict:
    """Entrena regresor + clasificadores y devuelve modelos y metricas."""
    mask_tr, corte = split_temporal(data)

    X = data[FEATURES]
    y = data["Position"]
    w = pesos_recencia(data)

    # OBJETIVO DEL REGRESOR: posiciones ganadas (parrilla - llegada), no la
    # posicion final. Asi el modelo no gasta capacidad reaprendiendo que quien
    # sale delante suele llegar delante; solo aprende la DESVIACION respecto a
    # esa regla. Comprobado en experimento.py: duplica la mejora sobre el
    # baseline (+9.4% frente a +4.0%).
    ganancia = data["GridPosition"] - data["Position"]

    Xtr, Xte = X[mask_tr], X[~mask_tr]
    ytr, yte = y[mask_tr], y[~mask_tr]
    gtr, gte = ganancia[mask_tr], ganancia[~mask_tr]
    wtr = w[mask_tr]

    print(f"\nEntrenamiento: {mask_tr.sum()} filas | Prueba: {(~mask_tr).sum()} filas")
    print(f"Corte temporal: temporada {int(corte['Year'])}, ronda {int(corte['Round'])}")

    # loss="absolute_error" -> optimiza la mediana, mucho mas robusto a los
    # abandonos, que son valores extremos (P20 cuando el piloto iba 3o).
    reg = HistGradientBoostingRegressor(
        random_state=RANDOM_STATE,
        monotonic_cst=restricciones(MONOTONIA_REG), **REG_PARAMS)
    reg.fit(Xtr, gtr, sample_weight=wtr)

    n_max        = float(data["FieldSize"].max())
    pred_te      = np.clip(Xte["GridPosition"] - reg.predict(Xte), 1, n_max)
    mae_modelo   = float(mean_absolute_error(yte, pred_te))
    mae_baseline = float(mean_absolute_error(yte, Xte["GridPosition"]))
    mejora       = float(100 * (1 - mae_modelo / mae_baseline))

    print(f"\nMAE modelo   : {mae_modelo:.2f} posiciones")
    print(f"MAE baseline : {mae_baseline:.2f}  (asumir 'termina donde sale')")
    print(f"Mejora       : {mejora:+.1f}%\n")

    # ---- Clasificadores de probabilidad ----
    clfs, aucs = {}, {}
    for clave, (etiqueta, cond) in TARGET_DEFS.items():
        t = cond(data).astype(int)
        # El abandono no lleva restriccion: no es cierto que salir mas atras
        # aumente causalmente las opciones de romper el coche.
        cst = restricciones(MONOTONIA_CLF) if clave != "abandono" else None
        c = HistGradientBoostingClassifier(random_state=RANDOM_STATE,
                                           monotonic_cst=cst, **CLF_PARAMS)
        c.fit(Xtr, t[mask_tr], sample_weight=wtr)
        clfs[clave] = c
        try:
            auc = float(roc_auc_score(t[~mask_tr], c.predict_proba(Xte)[:, 1]))
        except ValueError:
            auc = None
        aucs[clave] = auc
        txt = f"{auc:.3f}" if auc is not None else "n/d"
        print(f"   AUC {etiqueta:<9}: {txt}")

    # ---- Importancia de variables (permutacion sobre el test) ----
    imp = permutation_importance(reg, Xte, gte, n_repeats=5,
                                 random_state=RANDOM_STATE)
    importancias = sorted(
        ({"feature": f, "valor": float(v)}
         for f, v in zip(FEATURES, imp.importances_mean)),
        key=lambda d: d["valor"], reverse=True)

    # ---- Que tan bien acierta el ORDEN de llegada, carrera a carrera ----
    orden = _evaluar_orden(data[~mask_tr], np.asarray(pred_te))

    # ---- Desglose por temporada: revela los cambios de reglamento ----
    por_temporada = _desglose_temporada(data[~mask_tr], np.asarray(pred_te))
    print()
    for d in por_temporada:
        print(f"   {d['anio']}  n={d['n']:4d}   modelo {d['mae_modelo']:.2f}   "
              f"baseline {d['mae_baseline']:.2f}   mejora {d['mejora_pct']:+.1f}%")

    metricas = {
        "mae_modelo": mae_modelo,
        "mae_baseline": mae_baseline,
        "mejora_pct": mejora,
        "auc": aucs,
        "importancias": importancias,
        "n_train": int(mask_tr.sum()),
        "n_test": int((~mask_tr).sum()),
        "corte": {"year": int(corte["Year"]), "round": int(corte["Round"])},
        "orden": orden,
        "por_temporada": por_temporada,
    }
    return {"reg": reg, "clfs": clfs, "metricas": metricas, "n_max": n_max}


def _desglose_temporada(test: pd.DataFrame, pred: np.ndarray) -> list[dict]:
    """MAE del modelo y del baseline ano a ano dentro del conjunto de prueba."""
    t = test.copy()
    t["pred"] = pred

    salida = []
    for anio, g in t.groupby("Year"):
        mae_m = float(mean_absolute_error(g["Position"], g["pred"]))
        mae_b = float(mean_absolute_error(g["Position"], g["GridPosition"]))
        salida.append({
            "anio": int(anio),
            "n": int(len(g)),
            "mae_modelo": mae_m,
            "mae_baseline": mae_b,
            "mejora_pct": float(100 * (1 - mae_m / mae_b)),
        })
    return salida


def _evaluar_orden(test: pd.DataFrame, pred: np.ndarray) -> dict:
    """Metricas de ranking: no basta con acertar el numero, hay que acertar quien va delante."""
    t = test.copy()
    t["pred"] = pred
    t["pred_rank"] = (t.groupby(["Year", "Round"])["pred"]
                       .rank(method="first").astype(int))

    aciertos_ganador, aciertos_podio, n_carreras = 0, 0, 0
    for _, g in t.groupby(["Year", "Round"]):
        n_carreras += 1
        ganador_real = g.loc[g["Position"].idxmin(), "DriverId"]
        pred_ganador = g.loc[g["pred_rank"].idxmin(), "DriverId"]
        aciertos_ganador += int(ganador_real == pred_ganador)

        podio_real = set(g.nsmallest(3, "Position")["DriverId"])
        podio_pred = set(g.nsmallest(3, "pred_rank")["DriverId"])
        aciertos_podio += len(podio_real & podio_pred)

    return {
        "carreras_evaluadas": n_carreras,
        "acierto_ganador_pct": float(100 * aciertos_ganador / max(n_carreras, 1)),
        "acierto_podio_pct": float(100 * aciertos_podio / max(3 * n_carreras, 1)),
    }


# ------------------------------- PREDICCION --------------------------------
def predecir(modelos: dict, filas: pd.DataFrame) -> pd.DataFrame:
    """Anade al DataFrame de features la posicion estimada y las probabilidades.

    El regresor devuelve POSICIONES GANADAS, asi que la posicion estimada es
    parrilla - ganancia. Y 'PosicionPredicha' es el RANKING (1..N) de esa
    estimacion: dos pilotos no pueden acabar los dos en P3.
    """
    X = filas[FEATURES]

    out = filas.copy()
    ganancia = modelos["reg"].predict(X)
    out["GananciaEstimada"] = ganancia
    out["PosEstimada"] = np.clip(filas["GridPosition"] - ganancia, 1, len(filas))
    out["PosicionPredicha"] = out["PosEstimada"].rank(method="first").astype(int)

    for clave, clf in modelos["clfs"].items():
        out[f"prob_{clave}"] = clf.predict_proba(X)[:, 1]

    # Cada clasificador es independiente, asi que sus probabilidades crudas no
    # respetan las restricciones de una carrera: solo hay 1 ganador, 3 puestos
    # de podio y 10 posiciones de puntos. Las reescalamos para que sumen eso.
    # Abandono no se toca: pueden abandonar todos o ninguno.
    for clave, cupo in (("victoria", 1), ("podio", 3), ("puntos", 10)):
        col = f"prob_{clave}"
        out[col] = _repartir_cupo(out[col].to_numpy(), cupo)

    # Los cuatro clasificadores se entrenan por separado, asi que nada les
    # obliga a ser coherentes entre si: pueden dar 69% de podio y 54% de puntos
    # al mismo piloto, lo cual es imposible (subir al podio implica puntuar).
    # Imponemos la jerarquia recortando hacia abajo el suceso mas exigente.
    out["prob_podio"]    = np.minimum(out["prob_podio"], out["prob_puntos"])
    out["prob_victoria"] = np.minimum(out["prob_victoria"], out["prob_podio"])

    return out.sort_values("PosicionPredicha").reset_index(drop=True)


def _repartir_cupo(p: np.ndarray, cupo: float, tope: float = 0.99,
                   iteraciones: int = 50) -> np.ndarray:
    """Reescala p para que sume `cupo` sin que ningun valor pase de `tope`.

    Un simple p * cupo / sum(p) puede dar valores por encima de 1, y recortarlos
    con min(x, 1) rompe la suma y produce cosas como "100.0% de podio". Aqui se
    reparte el exceso entre los que aun tienen margen (ajuste proporcional
    iterativo), asi que la suma se mantiene y nadie supera el tope.

    El factor de amplificacion esta limitado por AMPLIFICACION_MAX. Sin ese
    tope, una parrilla rara (mover al mejor piloto al fondo) hunde la suma de
    probabilidades del campo y la normalizacion inflaba a todos: daba un 37% de
    victoria a un piloto saliendo ultimo cuando el modelo crudo decia 5%.
    """
    p = np.clip(np.asarray(p, dtype=float), 0, None)
    if p.sum() <= 0:
        return p
    if cupo >= len(p) * tope:          # el cupo no cabe: todos al tope
        return np.full_like(p, tope)

    factor = min(cupo / p.sum(), AMPLIFICACION_MAX)
    q = p * factor
    for _ in range(iteraciones):
        exceso = np.maximum(q - tope, 0).sum()
        if exceso < 1e-9:
            break
        q = np.minimum(q, tope)
        libres = q < tope - 1e-12
        margen = (tope - q[libres]).sum()
        if margen <= 1e-12:
            break
        # Repartir el exceso proporcionalmente al hueco que le queda a cada uno
        q[libres] += exceso * (tope - q[libres]) / margen
    return np.minimum(q, tope)
