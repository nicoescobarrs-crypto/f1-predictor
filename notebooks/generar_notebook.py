"""Genera notebooks/analisis_f1.ipynb a partir de este script.

Tener el notebook como codigo evita los conflictos de git que provocan los
.ipynb (metadatos y salidas cambian en cada ejecucion).

    python notebooks/generar_notebook.py
"""
import json
from pathlib import Path

SALIDA = Path(__file__).parent / "analisis_f1.ipynb"


def md(texto):
    return {"cell_type": "markdown", "metadata": {},
            "source": texto.strip("\n").splitlines(keepends=True)}


def code(texto):
    return {"cell_type": "code", "execution_count": None, "metadata": {},
            "outputs": [], "source": texto.strip("\n").splitlines(keepends=True)}


CELDAS = [
    md("""
# 🏎️ Predicción de resultados de Fórmula 1

**Introducción a la Ciencia de Datos**

Este notebook documenta el análisis. El código reutilizable vive en `pipeline/`,
así que aquí nos centramos en las decisiones y en los resultados.

**Índice**
1. Datos
2. Ingeniería de variables y fuga temporal
3. Validación temporal
4. Modelos y comparación con el baseline
5. Qué variables importan
6. Predicción de una carrera concreta
7. Conclusiones y limitaciones
"""),

    md("""
## 0. Preparación

Si ejecutas esto en Google Colab, descomenta las dos primeras líneas para clonar
el repositorio. En local basta con tenerlo abierto desde la raíz del proyecto.
"""),

    code("""
# !git clone https://github.com/TU-USUARIO/f1-predictor.git
# %cd f1-predictor

!pip install -q fastf1 rapidfuzz scikit-learn

import sys, warnings
sys.path.insert(0, "pipeline")
warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

plt.rcParams["figure.figsize"] = (11, 4.5)
plt.rcParams["axes.grid"] = True
plt.rcParams["grid.alpha"] = 0.3
pd.set_option("display.max_columns", 60)
pd.set_option("display.width", 170)
"""),

    md("""
## 1. Datos

Usamos [FastF1](https://docs.fastf1.dev/), que consulta la API oficial de la Fórmula 1.
Pedimos **solo los resultados de carrera**: sin telemetría ni vueltas, es dos órdenes de
magnitud más rápido y es todo lo que necesita el modelo.

La primera ejecución descarga unas 130 carreras (~5 minutos). Después queda en caché.
"""),

    code("""
from data import construir_dataset

raw = construir_dataset(refrescar=False)   # True para volver a descargar
print(f"{len(raw)} resultados de {raw.groupby(['Year','Round']).ngroups} carreras")
raw.head()
"""),

    md("""
### Un detalle de limpieza que cambió las conclusiones

FastF1 usa **tres etiquetas distintas** para quien termina la carrera:
`Finished`, `+1 Lap` y `Lapped`. Es fácil dejarse una.
"""),

    code("""
estados = raw["Status"].value_counts()
print(estados.head(12))

doblados = int(estados.get("Lapped", 0))
print(f"\\nPilotos con estado 'Lapped': {doblados} de {len(raw)} "
      f"({100*doblados/len(raw):.1f}%)")
print("Terminaron la carrera, solo que doblados. Contarlos como abandono")
print("inflaba la tasa de DNF y hacía que el modelo de abandono pareciese bueno.")
"""),

    md("""
## 2. Ingeniería de variables

17 variables en cuatro familias: circunstancia de la carrera, forma del piloto,
forma del equipo y contexto (historial en ese circuito, duelo con el compañero).

**La regla que no se puede romper:** toda variable histórica se calcula con
`.shift(1)` antes de la ventana móvil. Sin eso, una fila vería su propio resultado
y las métricas saldrían buenísimas pero falsas.
"""),

    code("""
from features import preparar
from config import FEATURES

df, data = preparar(raw)

print(f"Dataset entrenable: {data.shape[0]} filas × {len(FEATURES)} variables")
print(f"Pilotos: {data['DriverId'].nunique()} | Equipos: {data['TeamName'].nunique()}")
print(f"Tasa de abandono: {100*data['DNF'].mean():.1f}%")

data[["Year", "EventName", "FullName", "TeamName", "GridPosition",
      "Position", "DNF", "Drv_FormPos", "Team_FormPos"]].sample(8, random_state=1)
"""),

    md("""
### Comprobación de la fuga de datos

Si `.shift(1)` está bien puesto, la primera carrera de cada piloto no puede tener
valor de forma previa. Comprobémoslo.
"""),

    code("""
primera = df.sort_values("Date").groupby("DriverId").head(1)
print(f"Primeras carreras de cada piloto: {len(primera)}")
print(f"De ellas, con Drv_FormPos no nulo: {primera['Drv_FormPos'].notna().sum()}")
print("\\nDebe ser 0: nadie puede tener forma previa en su debut.")
"""),

    md("""
## 3. Validación temporal

Un `train_test_split` aleatorio dejaría carreras del futuro en el entrenamiento.
El modelo aprendería del futuro y las métricas serían mentira.

Partimos el **calendario**: primeras carreras para entrenar, últimas para probar.
"""),

    code("""
from models import split_temporal

mask_tr, corte = split_temporal(data)
print(f"Corte: temporada {int(corte['Year'])}, ronda {int(corte['Round'])}")
print(f"Entrenamiento: {mask_tr.sum()} filas")
print(f"Prueba       : {(~mask_tr).sum()} filas")

fig, ax = plt.subplots(figsize=(11, 2.6))
for etiqueta, m, color in [("Entrenamiento", mask_tr, "#0090d0"),
                           ("Prueba", ~mask_tr, "#e10600")]:
    sub = data[m]
    ax.scatter(sub["Date"], np.zeros(len(sub)), c=color, s=8, label=etiqueta, alpha=.5)
ax.set_yticks([]); ax.legend(); ax.set_title("Separación temporal del dataset")
plt.tight_layout(); plt.show()
"""),

    md("""
## 4. Modelos

Dos piezas:

- Un **regresor** que estima las **posiciones ganadas o perdidas** respecto a la parrilla
  (no la posición final). Así no gasta capacidad reaprendiendo que quien sale delante
  llega delante: solo modela la desviación.
- Cuatro **clasificadores** para victoria, podio, puntos y abandono.

Comparamos siempre contra el baseline *"cada piloto termina donde salió"*, que en F1
ya acierta bastante.
"""),

    code("""
from models import entrenar

modelos = entrenar(data)
m = modelos["metricas"]
"""),

    code("""
fig, ax = plt.subplots(1, 2, figsize=(12, 4))

ax[0].bar(["Baseline\\n(sale = llega)", "Modelo"],
          [m["mae_baseline"], m["mae_modelo"]],
          color=["#777", "#e10600"])
ax[0].set_ylabel("Error medio absoluto (posiciones)")
ax[0].set_title(f"MAE — mejora del {m['mejora_pct']:+.1f}%")
for i, v in enumerate([m["mae_baseline"], m["mae_modelo"]]):
    ax[0].text(i, v + .05, f"{v:.2f}", ha="center", fontweight="bold")

claves = list(m["auc"].keys())
ax[1].bar(claves, [m["auc"][k] for k in claves],
          color=["#e10600", "#2ecc71", "#38bdf8", "#f5a623"])
ax[1].axhline(0.5, ls="--", c="gray", lw=1)
ax[1].set_ylim(0.4, 1.0); ax[1].set_ylabel("AUC")
ax[1].set_title("Capacidad de discriminación (0.5 = azar)")
for i, k in enumerate(claves):
    ax[1].text(i, m["auc"][k] + .01, f"{m['auc'][k]:.2f}", ha="center", fontweight="bold")

plt.tight_layout(); plt.show()
"""),

    md("""
### El AUC de abandono es bajo, y está bien que lo sea

Antes de corregir el bug de `Lapped`, el AUC de abandono era 0.73 y parecía un buen
resultado. En realidad el modelo estaba detectando *"coche lento y doblado"*, que sí es
predecible.

Corregido, cae a ~0.57. Ese es el número honesto: un abandono real depende de fallos
mecánicos y accidentes, que son esencialmente aleatorios.

**Moraleja:** una métrica sospechosamente buena suele ser un bug, no un logro.
"""),

    md("""
### El AUC no detecta que las probabilidades sean absurdas

Comprobación directa: ¿qué probabilidad de ganar da el modelo a un piloto rápido
según desde dónde salga? Debería bajar al retrasarlo. Sin restricciones de
monotonía **no lo hacía**: daba más opciones desde P8 que desde P5.

Comparemos lo que dice el modelo con lo que dicen los datos.
"""),

    code("""
from features import construir_filas, parrilla_actual
from models import predecir

campo = parrilla_actual(data)
medias = sorted(((d, float(data[data.DriverId == d].sort_values("Date")["GridPosition"]
                           .tail(5).mean())) for d in campo["DriverId"]),
                key=lambda t: t[1])
orden = [d for d, _ in medias]
PILOTO_ID = orden[0]

grids, probs = list(range(1, len(orden) + 1)), []
for g in grids:
    o = list(orden)
    o.remove(PILOTO_ID)
    o.insert(g - 1, PILOTO_ID)
    ent = [{"driver_id": d, "grid": i + 1} for i, d in enumerate(o)]
    p = predecir(modelos, construir_filas(data, ent, "Italian Grand Prix"))
    probs.append(float(p.loc[p.DriverId == PILOTO_ID, "prob_victoria"].iloc[0]))

# Tasa real de victoria segun zona de parrilla
zonas = pd.cut(data["GridPosition"], [0, 1, 3, 6, 10, 25],
               labels=["P1", "P2-3", "P4-6", "P7-10", "P11+"])
real = data.groupby(zonas, observed=True).apply(
    lambda g: (g["Position"] == 1).mean(), include_groups=False)

fig, ax = plt.subplots(1, 2, figsize=(12, 4))
ax[0].plot(grids, np.array(probs) * 100, "o-", color="#e10600")
ax[0].set_xlabel("Posición de salida"); ax[0].set_ylabel("Prob. de victoria (%)")
ax[0].set_title("Modelo: ¿decrece al retrasar la parrilla?")

ax[1].bar(real.index.astype(str), real.values * 100, color="#0090d0")
ax[1].set_ylabel("Victorias (%)"); ax[1].set_title("Datos reales: tasa por zona de parrilla")
plt.tight_layout(); plt.show()

es_monotona = all(a >= b - 1e-9 for a, b in zip(probs, probs[1:]))
print(f"¿La probabilidad decrece siempre al retrasar la salida? {es_monotona}")
print("Sin monotonic_cst esto daba False: el modelo prefería P8 a P5.")
"""),

    md("""
### Efecto del cambio de reglamento

Desglosando el conjunto de prueba por temporada aparece un caso claro de
*distribution shift*.
"""),

    code("""
pd.DataFrame(m["por_temporada"])[
    ["anio", "n", "mae_modelo", "mae_baseline", "mejora_pct"]
].round(2)
"""),

    md("""
## 5. Qué variables importan

Importancia por permutación sobre el conjunto de prueba: cuánto empeora el error
al desordenar cada variable.
"""),

    code("""
imp = pd.DataFrame(m["importancias"]).head(12).iloc[::-1]

fig, ax = plt.subplots(figsize=(9, 5))
ax.barh(imp["feature"], imp["valor"], color="#e10600")
ax.set_xlabel("Aumento del error al desordenar la variable")
ax.set_title("Variables más influyentes")
plt.tight_layout(); plt.show()

imp.iloc[::-1].reset_index(drop=True)
"""),

    md("""
## 6. Predicción de una carrera

Construimos la parrilla de la próxima carrera y predecimos el resultado completo.
"""),

    code("""
from features import parrilla_actual
from export import grid_de_referencia
from features import construir_filas
from models import predecir

pilotos  = parrilla_actual(data)
ref_grid = grid_de_referencia(data, pilotos)

EVENTO = "Dutch Grand Prix"     # cámbialo por el que quieras

filas = construir_filas(data, ref_grid, EVENTO)
pred  = predecir(modelos, filas)

pred[["PosicionPredicha", "Abbreviation", "FullName", "TeamName", "GridPosition",
      "prob_victoria", "prob_podio", "prob_puntos", "prob_abandono"]].head(10).round(3)
"""),

    md("""
### Sensibilidad a la parrilla

¿Cuánto cambia el resultado de un piloto según desde dónde salga?
Esta curva es la que hace interactiva la web sin necesidad de servidor.
"""),

    code("""
PILOTO = "Max Verstappen"    # cámbialo

did = pred.loc[pred["FullName"].str.contains(PILOTO, case=False), "DriverId"].iloc[0]
info = pred[pred["DriverId"] == did].iloc[0]

grids, curva = list(range(1, len(ref_grid) + 1)), []
for g in grids:
    escenario = [{"driver_id": e["driver_id"],
                  "grid": g if e["driver_id"] == did else e["grid"]}
                 for e in ref_grid]
    p = predecir(modelos, construir_filas(data, escenario, EVENTO))
    curva.append(float(p.loc[p["DriverId"] == did, "PosEstimada"].iloc[0]))

h = data[data["DriverId"] == did].sort_values("Date")

fig, ax = plt.subplots(1, 2, figsize=(13, 4.5))

ax[0].plot(grids, curva, "o-", color="#e10600", label="Estimación del modelo")
ax[0].plot(grids, grids, "--", color="gray", lw=1, label="salida = llegada")
ax[0].invert_yaxis(); ax[0].invert_xaxis()
ax[0].set_xlabel("Posición de salida"); ax[0].set_ylabel("Posición final estimada")
ax[0].set_title(f"Sensibilidad — {info['FullName']} en {EVENTO}"); ax[0].legend()

ax[1].plot(h["Date"], h["Position"], "o-", color="#0090d0", lw=1.2, ms=3, label="Llegada")
ax[1].plot(h["Date"], h["GridPosition"], "s--", color="#999", lw=1, ms=3, label="Salida")
ax[1].scatter(h.loc[h.DNF == 1, "Date"], h.loc[h.DNF == 1, "Position"],
              color="red", marker="x", s=70, label="Abandono")
ax[1].invert_yaxis(); ax[1].set_title(f"Trayectoria de {info['Abbreviation']}")
ax[1].legend(); ax[1].tick_params(axis="x", rotation=45)

plt.tight_layout(); plt.show()

print(f"Histórico ({len(h)} carreras): media P{h['Position'].mean():.1f} | "
      f"abandonos {100*h['DNF'].mean():.0f}% | "
      f"ganancia media {h['PosGain'].mean():+.1f} posiciones")
"""),

    md("""
## 7. Conclusiones

**Lo que funciona**

- El modelo mejora el baseline en ~10 % de MAE y acierta el ganador en ~68 % de las
  carreras de prueba. En una validación temporal estricta, no es poco.
- Las probabilidades de victoria y podio discriminan muy bien (AUC 0.98 y 0.92).
- Predecir la *desviación* respecto a la parrilla en vez de la posición final duplicó
  la mejora sobre el baseline.

**Lo que no funciona, y por qué**

- Los abandonos son casi impredecibles (AUC 0.57). Dependen de fallos mecánicos y
  accidentes. Ningún modelo con estos datos los va a anticipar.
- El error no baja de ~3 posiciones porque no modelamos meteorología, estrategia de
  neumáticos ni coches de seguridad, que es justo lo que decide muchas carreras.
- El cambio de reglamento de 2026 degrada la predicción: el histórico previo vale menos.

**Qué haríamos con más tiempo**

- Incorporar los tiempos de clasificación (ritmo real del coche ese fin de semana).
- Datos meteorológicos, que FastF1 también expone.
- Un modelo de ranking (`LambdaRank`) en vez de regresión + ordenación posterior.
- Calibrar las probabilidades con `CalibratedClassifierCV` sobre un bloque temporal
  reservado. Es el arreglo pendiente más claro: la probabilidad de victoria sigue siendo
  la parte más floja incluso tras imponer monotonía.
"""),
]

notebook = {
    "cells": CELDAS,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python", "version": "3.13"},
        "colab": {"provenance": []},
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}

SALIDA.write_text(json.dumps(notebook, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"Notebook generado: {SALIDA}  ({len(CELDAS)} celdas)")
