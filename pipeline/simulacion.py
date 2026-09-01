"""Simulacion Monte Carlo del resto del campeonato.

El modelo predice una carrera. El campeonato depende de todas las que quedan,
asi que para obtener una probabilidad de titulo hay que simular la temporada
entera muchas veces y contar cuantas la gana cada piloto.

Es lo que permite comparar de tu a tu con Polymarket, cuyo mercado tambien es
de temporada.

Como funciona cada simulacion:
  1. Se parte de los puntos actuales.
  2. Para cada carrera que queda, el modelo da una posicion estimada y una
     probabilidad de abandono por piloto.
  3. Se sortea: quien abandona no puntua; al resto se le suma ruido aleatorio
     del tamano del error real del modelo y se ordenan.
  4. Se reparten puntos y se pasa a la siguiente carrera.

El ruido es la clave: sin el, todas las simulaciones darian el mismo resultado
y la probabilidad de titulo seria 100 % para uno y 0 % para el resto.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from features import construir_filas, parrilla_actual
from models import predecir

# Sistema de puntos vigente. No se modelan la vuelta rapida ni los sprints.
PUNTOS = np.array([25, 18, 15, 12, 10, 8, 6, 4, 2, 1], dtype=float)


def grid_referencia(data: pd.DataFrame, pilotos: pd.DataFrame,
                    ventana: int = 5) -> list[dict]:
    """Parrilla estimada: ordena a los pilotos por su salida media reciente."""
    medias = []
    for did in pilotos["DriverId"]:
        h = data[data["DriverId"] == did].sort_values("Date")
        medias.append((did, float(h["GridPosition"].tail(ventana).mean())))
    medias.sort(key=lambda t: t[1])
    return [{"driver_id": d, "grid": i + 1} for i, (d, _) in enumerate(medias)]


def _preparar_carreras(data: pd.DataFrame, modelos: dict,
                       eventos: list[dict]) -> list[dict]:
    """Predice una sola vez cada carrera pendiente.

    Las predicciones no cambian entre simulaciones: lo que cambia es el sorteo.
    Calcularlas una vez y reutilizarlas hace la simulacion cientos de veces
    mas rapida.
    """
    pilotos = parrilla_actual(data)
    ref = grid_referencia(data, pilotos)

    preparadas = []
    for ev in eventos:
        filas = construir_filas(data, ref, ev["evento"], ev.get("lugar", ""),
                                ev.get("ronda"), ev.get("condiciones"))
        pred = predecir(modelos, filas)
        preparadas.append({
            "evento": ev["evento"],
            "drivers": pred["DriverId"].to_numpy(),
            "pos": pred["PosEstimada"].to_numpy(dtype=float),
            "dnf": pred["prob_abandono"].to_numpy(dtype=float),
        })
    return preparadas


def simular(data: pd.DataFrame, modelos: dict, eventos: list[dict],
            n: int = 4000, semilla: int = 42) -> dict:
    """Probabilidad de titulo de cada piloto y cada equipo."""
    temporada = int(data["Year"].max())
    act = data[data["Year"] == temporada]

    puntos_ini = act.groupby("DriverId")["Points"].sum()
    equipo_de = act.sort_values("Date").groupby("DriverId")["TeamName"].last()
    nombre_de = act.sort_values("Date").groupby("DriverId")["FullName"].last()

    carreras = _preparar_carreras(data, modelos, eventos) if eventos else []

    pilotos = list(puntos_ini.index)
    idx = {d: i for i, d in enumerate(pilotos)}
    base = puntos_ini.reindex(pilotos).to_numpy(dtype=float)

    rng = np.random.default_rng(semilla)

    # Dos ruidos, medidos sobre el conjunto de prueba (models.descomponer_error):
    #   sigma_carrera     se sortea en cada carrera y se diluye al promediar
    #   sigma_persistente se sortea UNA vez por temporada simulada y no se
    #                     diluye: representa que un piloto puede ir sistematica-
    #                     mente mejor o peor de lo que cree el modelo.
    # Sin el segundo, once carreras de ruido independiente se cancelan entre si
    # y la simulacion da un 99 % de titulo donde el mercado da un 75 %.
    ruido = modelos["metricas"].get("ruido", {})
    sigma_carrera = float(ruido.get("sigma_carrera")
                          or modelos["metricas"]["mae_modelo"])
    sigma_persist = float(ruido.get("sigma_persistente") or 0.0)

    titulos = np.zeros(len(pilotos))
    finales = np.zeros((n, len(pilotos)))

    for s in range(n):
        total = base.copy()
        # Sesgo de temporada: un valor por piloto, fijo durante toda esta
        # simulacion. Se indexa por driver_id para que sea el mismo en todas
        # las carreras de esta temporada simulada.
        sesgo = {d: rng.normal(0, sigma_persist) for d in pilotos}

        for c in carreras:
            m = len(c["drivers"])
            abandona = rng.random(m) < c["dnf"]
            # Quien abandona se va al fondo; al resto, ruido de carrera + sesgo.
            desvio = np.array([sesgo.get(d, 0.0) for d in c["drivers"]])
            score = c["pos"] + desvio + rng.normal(0, sigma_carrera, m)
            score = np.where(abandona, 1e6 + score, score)

            for puesto, j in enumerate(np.argsort(score)):
                if puesto >= len(PUNTOS) or abandona[j]:
                    continue
                d = c["drivers"][j]
                if d in idx:
                    total[idx[d]] += PUNTOS[puesto]

        finales[s] = total
        titulos[int(np.argmax(total))] += 1

    prob = titulos / n

    resultado_pilotos = []
    for d, p in sorted(zip(pilotos, prob), key=lambda t: -t[1]):
        i = idx[d]
        resultado_pilotos.append({
            "driver_id": d,
            "nombre": str(nombre_de.get(d, d)),
            "equipo": str(equipo_de.get(d, "")),
            "puntos_ahora": float(base[i]),
            "puntos_final_medio": float(finales[:, i].mean()),
            "prob_titulo": float(p),
        })

    # Constructores: se suman los puntos de los dos coches en cada simulacion
    equipos = sorted(set(equipo_de.values))
    mapa = np.array([equipos.index(equipo_de.get(d, equipos[0])) for d in pilotos])
    por_equipo = np.zeros((n, len(equipos)))
    for j in range(len(equipos)):
        por_equipo[:, j] = finales[:, mapa == j].sum(axis=1)
    ganador_eq = np.argmax(por_equipo, axis=1)

    resultado_equipos = []
    for j, nombre in enumerate(equipos):
        resultado_equipos.append({
            "equipo": nombre,
            "puntos_ahora": float(base[mapa == j].sum()),
            "prob_titulo": float((ganador_eq == j).mean()),
        })
    resultado_equipos.sort(key=lambda e: -e["prob_titulo"])

    return {
        "temporada": temporada,
        "simulaciones": n,
        "carreras_restantes": len(carreras),
        "carreras_disputadas": int(act.groupby("Round").ngroups),
        "sigma_carrera": sigma_carrera,
        "sigma_persistente": sigma_persist,
        "pilotos": resultado_pilotos,
        "equipos": resultado_equipos,
    }
