"""Exporta todo lo que la web necesita a ficheros JSON estaticos.

La pagina no ejecuta Python: lee estos JSON. Por eso el hosting puede ser
gratis (Firebase Hosting / GitHub Pages) y la carga es instantanea.
"""
from __future__ import annotations

import json
import re
import unicodedata
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from config import FEATURE_LABELS, FEATURES, TARGET_DEFS, WEB_DATA
from clima import pronostico
from features import construir_filas, parrilla_actual
from models import predecir


# ------------------------------ UTILIDADES ---------------------------------
def slug(texto: str) -> str:
    """'Gran Premio de Monaco' -> 'gran-premio-de-monaco'"""
    t = unicodedata.normalize("NFKD", str(texto))
    t = t.encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")


def _limpio(v):
    """Convierte tipos de numpy/pandas a algo que json.dump acepte."""
    if v is None:
        return None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return None if np.isnan(f) else round(f, 4)
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, (pd.Timestamp, datetime)):
        return v.strftime("%Y-%m-%d")
    return v


def _escribir(nombre: str, obj) -> None:
    ruta = WEB_DATA / nombre
    ruta.parent.mkdir(parents=True, exist_ok=True)
    with open(ruta, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"), default=_limpio)
    kb = ruta.stat().st_size / 1024
    print(f"   -> {nombre}  ({kb:.0f} KB)")


def _registros(df: pd.DataFrame, columnas: list[str]) -> list[dict]:
    cols = [c for c in columnas if c in df.columns]
    return [{c: _limpio(r[c]) for c in cols} for _, r in df[cols].iterrows()]


# --------------------------- PARRILLA DE REFERENCIA ------------------------
def grid_de_referencia(data: pd.DataFrame, pilotos: pd.DataFrame,
                       ventana: int = 5) -> list[dict]:
    """Parrilla estimada para una carrera futura.

    No conocemos la clasificacion todavia, asi que ordenamos a los pilotos por
    su posicion de salida media reciente. Es el escenario por defecto que ve
    el usuario, y desde ahi puede mover a quien quiera.
    """
    medias = []
    for did in pilotos["DriverId"]:
        h = data[data["DriverId"] == did].sort_values("Date")
        medias.append((did, float(h["GridPosition"].tail(ventana).mean())))

    medias.sort(key=lambda t: t[1])
    return [{"driver_id": did, "grid": i + 1} for i, (did, _) in enumerate(medias)]


# ------------------------------- EXPORTACIONES ------------------------------
def exportar_metricas(metricas: dict) -> None:
    m = dict(metricas)
    m["importancias"] = [
        {"feature": d["feature"],
         "etiqueta": FEATURE_LABELS.get(d["feature"], d["feature"]),
         "valor": d["valor"]}
        for d in metricas["importancias"]
    ]
    m["etiquetas_objetivo"] = {k: v[0] for k, v in TARGET_DEFS.items()}
    _escribir("metricas.json", m)


def exportar_pilotos(data: pd.DataFrame) -> None:
    """Ficha y trayectoria de cada piloto, para la pestana de analisis."""
    temporada = int(data["Year"].max())
    salida = []

    for did, h in data.sort_values("Date").groupby("DriverId"):
        act = h[h["Year"] == temporada]
        salida.append({
            "driver_id":  did,
            "nombre":     h["FullName"].iloc[-1],
            "abrev":      h["Abbreviation"].iloc[-1],
            "equipo":     h["TeamName"].iloc[-1],
            "numero":     _limpio(h["DriverNumber"].iloc[-1]),
            "carreras":   int(len(h)),
            "ultima":     _limpio(h["Date"].max()),
            "activo":     bool(len(act) > 0),
            "media_pos":  _limpio(h["Position"].mean()),
            "media_grid": _limpio(h["GridPosition"].mean()),
            "tasa_dnf":   _limpio(h["DNF"].mean()),
            "ganancia":   _limpio(h["PosGain"].mean()),
            "victorias":  int((h["Position"] == 1).sum()),
            "podios":     int((h["Position"] <= 3).sum()),
            "puntos":     _limpio(h["Points"].sum()),
            "temporada": {
                "puntos":    _limpio(act["Points"].sum()),
                "carreras":  int(len(act)),
                "media_pos": _limpio(act["Position"].mean()) if len(act) else None,
                "victorias": int((act["Position"] == 1).sum()),
                "podios":    int((act["Position"] <= 3).sum()),
            },
            "trayectoria": [
                {"fecha": _limpio(r["Date"]), "evento": r["EventName"],
                 "anio": int(r["Year"]), "ronda": int(r["Round"]),
                 "grid": _limpio(r["GridPosition"]), "pos": _limpio(r["Position"]),
                 "dnf": int(r["DNF"]), "puntos": _limpio(r["Points"])}
                for _, r in h.iterrows()
            ],
        })

    salida.sort(key=lambda d: (not d["activo"], -(d["temporada"]["puntos"] or 0)))
    _escribir("pilotos.json", salida)


def exportar_resultados(data: pd.DataFrame) -> None:
    """Todas las carreras historicas, en formato compacto, para el analisis."""
    carreras = []
    for (anio, ronda), g in data.groupby(["Year", "Round"]):
        g = g.sort_values("Position")
        carreras.append({
            "anio": int(anio), "ronda": int(ronda),
            "evento": g["EventName"].iloc[0],
            "slug": slug(f"{anio}-{g['EventName'].iloc[0]}"),
            "lugar": g["Location"].iloc[0],
            "pais": g["Country"].iloc[0] if "Country" in g.columns else "",
            "fecha": _limpio(g["Date"].iloc[0]),
            "urbano": int(g["IsStreet"].iloc[0]),
            "resultados": [
                {"driver_id": r["DriverId"], "abrev": r["Abbreviation"],
                 "nombre": r["FullName"], "equipo": r["TeamName"],
                 "grid": _limpio(r["GridPosition"]), "pos": _limpio(r["Position"]),
                 "puntos": _limpio(r["Points"]), "dnf": int(r["DNF"]),
                 "estado": str(r["Status"])}
                for _, r in g.iterrows()
            ],
        })

    carreras.sort(key=lambda c: (c["anio"], c["ronda"]))
    _escribir("resultados.json", carreras)


def exportar_clasificacion(data: pd.DataFrame) -> None:
    """Campeonato de pilotos y de constructores de la temporada en curso."""
    temporada = int(data["Year"].max())
    act = data[data["Year"] == temporada]

    pil = (act.groupby("DriverId")
              .agg(nombre=("FullName", "last"), abrev=("Abbreviation", "last"),
                   equipo=("TeamName", "last"), puntos=("Points", "sum"),
                   victorias=("Position", lambda s: int((s == 1).sum())),
                   podios=("Position", lambda s: int((s <= 3).sum())),
                   carreras=("Position", "size"))
              .reset_index().sort_values("puntos", ascending=False))
    pil.insert(0, "pos", range(1, len(pil) + 1))

    eq = (act.groupby("TeamName")
             .agg(puntos=("Points", "sum"),
                  victorias=("Position", lambda s: int((s == 1).sum())),
                  podios=("Position", lambda s: int((s <= 3).sum())))
             .reset_index().sort_values("puntos", ascending=False))
    eq.insert(0, "pos", range(1, len(eq) + 1))

    _escribir("clasificacion.json", {
        "temporada": temporada,
        "carreras_disputadas": int(act.groupby("Round").ngroups),
        "pilotos": _registros(pil, ["pos", "DriverId", "nombre", "abrev",
                                    "equipo", "puntos", "victorias", "podios",
                                    "carreras"]),
        "equipos": _registros(eq, ["pos", "TeamName", "puntos", "victorias",
                                   "podios"]),
    })


# ---------------------- PREDICCION DE UNA CARRERA --------------------------
def _fila_prediccion(r) -> dict:
    d = {
        "driver_id": r["DriverId"],
        "abrev": r["Abbreviation"],
        "nombre": r["FullName"],
        "equipo": r["TeamName"],
        "grid": _limpio(r["GridPosition"]),
        "pos_predicha": int(r["PosicionPredicha"]),
        "pos_estimada": _limpio(r["PosEstimada"]),
    }
    for clave in TARGET_DEFS:
        d[clave] = _limpio(r[f"prob_{clave}"])
    return d


def exportar_evento(data: pd.DataFrame, modelos: dict, evento: dict) -> dict:
    """Genera el JSON de prediccion de una carrera concreta.

    Incluye una CURVA DE SENSIBILIDAD por piloto: que pasaria si saliera desde
    cada una de las N posiciones, manteniendo al resto en su sitio. Eso permite
    que la web sea interactiva sin necesidad de un servidor.
    """
    pilotos  = parrilla_actual(data)
    ref_grid = grid_de_referencia(data, pilotos)

    nombre = evento["evento"]
    lugar  = evento.get("lugar", "")
    ronda  = evento.get("ronda")

    # Pronostico del tiempo para el dia de la carrera. Si no hay (mas de 16 dias
    # vista, o circuito desconocido), construir_filas usa la media historica del
    # circuito, que ya distingue Singapur de Spa.
    tiempo = None
    if evento.get("fecha") and evento.get("futuro", True):
        tiempo = pronostico(nombre, evento["fecha"], lugar, data)
        if tiempo:
            print(f"      clima previsto: {tiempo['TempAire']:.0f}C aire, "
                  f"~{tiempo['TempPista']:.0f}C pista, "
                  f"{tiempo['prob_lluvia_pct']}% lluvia")

    filas = construir_filas(data, ref_grid, nombre, lugar, ronda, tiempo)
    pred  = predecir(modelos, filas)

    n = len(ref_grid)
    sensibilidad: dict[str, list] = {}
    for did in pilotos["DriverId"]:
        curva = []
        for g in range(1, n + 1):
            escenario = [
                {"driver_id": e["driver_id"],
                 "grid": g if e["driver_id"] == did else e["grid"]}
                for e in ref_grid
            ]
            f = construir_filas(data, escenario, nombre, lugar, ronda, tiempo)
            p = predecir(modelos, f)
            r = p[p["DriverId"] == did].iloc[0]
            punto = {"grid": g,
                     "pos": _limpio(r["PosEstimada"]),
                     "rank": int(r["PosicionPredicha"])}
            for clave in TARGET_DEFS:
                punto[clave] = _limpio(r[f"prob_{clave}"])
            curva.append(punto)
        sensibilidad[did] = curva

    doc = {
        "evento": nombre,
        "slug": evento["slug"],
        "lugar": lugar,
        "pais": evento.get("pais", ""),
        "fecha": evento.get("fecha"),
        "ronda": ronda,
        "temporada": evento.get("anio"),
        "urbano": evento.get("urbano", 0),
        "clima": tiempo,
        "grid_referencia": ref_grid,
        "prediccion": [_fila_prediccion(r) for _, r in pred.iterrows()],
        "sensibilidad": sensibilidad,
    }
    _escribir(f"events/{evento['slug']}.json", doc)
    return doc


# --------------------------------- INDICE ----------------------------------
def exportar_indice(data: pd.DataFrame, metricas: dict,
                    eventos: list[dict]) -> None:
    ult = data.sort_values("Date").iloc[-1]
    _escribir("index.json", {
        "generado": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "temporadas": sorted(int(y) for y in data["Year"].unique()),
        "total_carreras": int(data.groupby(["Year", "Round"]).ngroups),
        "total_filas": int(len(data)),
        "ultima_carrera": {
            "evento": ult["EventName"], "anio": int(ult["Year"]),
            "ronda": int(ult["Round"]), "fecha": _limpio(ult["Date"]),
        },
        "resumen_modelo": {
            "mae_modelo": metricas["mae_modelo"],
            "mae_baseline": metricas["mae_baseline"],
            "mejora_pct": metricas["mejora_pct"],
            "acierto_ganador_pct": metricas["orden"]["acierto_ganador_pct"],
            "acierto_podio_pct": metricas["orden"]["acierto_podio_pct"],
        },
        "eventos": [
            {"slug": e["slug"], "evento": e["evento"], "lugar": e.get("lugar", ""),
             "pais": e.get("pais", ""), "fecha": e.get("fecha"),
             "ronda": e.get("ronda"), "futuro": e.get("futuro", True)}
            for e in eventos
        ],
    })


# --------------------------- MODELO CONTRA MERCADO --------------------------
def exportar_mercado(data: pd.DataFrame, modelos: dict,
                     eventos: list[dict], n_sim: int = 4000) -> None:
    """Compara la probabilidad de titulo del modelo con la del mercado.

    Dos formas independientes de estimar lo mismo:
      - el modelo simula el resto de la temporada N veces
      - Polymarket agrega el dinero de miles de personas

    Donde discrepan es lo interesante: o el mercado sabe algo que el modelo no
    (un cambio de reglamento, una lesion), o el modelo ve algo que el mercado
    todavia no ha incorporado.
    """
    from mercado import cuotas
    from simulacion import simular

    print("\n   Simulando el resto de la temporada...")
    sim = simular(data, modelos, eventos, n=n_sim)
    print(f"      {sim['simulaciones']} temporadas simuladas, "
          f"{sim['carreras_restantes']} carreras restantes")

    print("   Consultando Polymarket...")
    mk = cuotas()
    print("      " + ("cuotas obtenidas" if mk else "no disponible (se publica solo el modelo)"))

    def emparejar(lista_modelo, opciones, clave_nombre):
        """Cruza por apellido, que es como Polymarket nombra a los pilotos."""
        if not opciones:
            return {}
        idx = {}
        for o in opciones:
            idx[o["nombre"].strip().lower()] = o["prob"]
        salida = {}
        for m in lista_modelo:
            nombre = str(m[clave_nombre]).strip().lower()
            if nombre in idx:
                salida[m[clave_nombre]] = idx[nombre]
                continue
            apellido = nombre.split()[-1]
            for k, v in idx.items():
                if k.split()[-1] == apellido:
                    salida[m[clave_nombre]] = v
                    break
        return salida

    mk_pil = mk["mercados"].get("pilotos", {}).get("opciones") if mk else None
    mk_eq  = mk["mercados"].get("equipos", {}).get("opciones") if mk else None

    prob_pil = emparejar(sim["pilotos"], mk_pil, "nombre")
    prob_eq  = emparejar(sim["equipos"], mk_eq, "equipo")

    for p in sim["pilotos"]:
        p["prob_mercado"] = prob_pil.get(p["nombre"])
        p["diferencia"] = (p["prob_titulo"] - p["prob_mercado"]
                           if p["prob_mercado"] is not None else None)
    for e in sim["equipos"]:
        e["prob_mercado"] = prob_eq.get(e["equipo"])
        e["diferencia"] = (e["prob_titulo"] - e["prob_mercado"]
                           if e["prob_mercado"] is not None else None)

    _escribir("mercado.json", {
        "generado": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "simulacion": {k: sim[k] for k in
                       ("temporada", "simulaciones", "carreras_restantes",
                        "carreras_disputadas", "sigma_carrera",
                        "sigma_persistente")},
        "mercado": ({"fuente": mk["fuente"],
                     "pilotos": {k: v for k, v in mk["mercados"].get("pilotos", {}).items()
                                 if k != "opciones"},
                     "equipos": {k: v for k, v in mk["mercados"].get("equipos", {}).items()
                                 if k != "opciones"}}
                    if mk else None),
        "pilotos": sim["pilotos"],
        "equipos": sim["equipos"],
    })


# ----------------------- PREDICCION CONTRA REALIDAD -------------------------
def exportar_backtest(data: pd.DataFrame, modelos: dict) -> None:
    """Lo que el modelo predijo frente a lo que pasó de verdad.

    SOLO se exportan las carreras del conjunto de PRUEBA, es decir, las que el
    modelo nunca vio al entrenar. Mostrar predicciones de carreras con las que
    se entrenó seria hacer trampa: el modelo las tiene medio memorizadas y
    acertaria por motivos que no se repetiran nunca en el futuro.

    Se usa la parrilla real de cada carrera, que es lo que se conoceria el
    domingo por la manana: la pregunta que responde es "sabiendo desde donde
    salio cada uno, .acertamos el orden de llegada?".
    """
    from models import split_temporal

    mask_tr, corte = split_temporal(data)
    test = data[~mask_tr].copy()

    n_max = float(data["FieldSize"].max())
    test["pos_pred_cruda"] = np.clip(
        test["GridPosition"] - modelos["reg"].predict(test[FEATURES]), 1, n_max)
    # Dentro de cada carrera, el orden sale de ordenar la estimacion: dos
    # pilotos no pueden acabar los dos terceros.
    test["pos_pred"] = (test.groupby(["Year", "Round"])["pos_pred_cruda"]
                            .rank(method="first").astype(int))

    carreras, aciertos_g, aciertos_p, maes = {}, 0, 0, []

    for (anio, ronda), g in test.groupby(["Year", "Round"]):
        g = g.sort_values("Position")
        evento = g["EventName"].iloc[0]

        ganador_real = g.loc[g["Position"].idxmin(), "DriverId"]
        ganador_pred = g.loc[g["pos_pred"].idxmin(), "DriverId"]
        acerto = bool(ganador_real == ganador_pred)

        podio_real = set(g.nsmallest(3, "Position")["DriverId"])
        podio_pred = set(g.nsmallest(3, "pos_pred")["DriverId"])
        en_podio = len(podio_real & podio_pred)

        mae = float((g["Position"] - g["pos_pred"]).abs().mean())

        aciertos_g += int(acerto)
        aciertos_p += en_podio
        maes.append(mae)

        carreras[slug(f"{anio}-{evento}")] = {
            "evento": evento,
            "anio": int(anio),
            "ronda": int(ronda),
            "fecha": _limpio(g["Date"].iloc[0]),
            "acerto_ganador": acerto,
            "podio_acertados": en_podio,
            "mae": mae,
            "filas": [
                {"driver_id": r["DriverId"], "abrev": r["Abbreviation"],
                 "nombre": r["FullName"], "equipo": r["TeamName"],
                 "grid": _limpio(r["GridPosition"]),
                 "pos_real": _limpio(r["Position"]),
                 "pos_pred": int(r["pos_pred"]),
                 "dnf": int(r["DNF"])}
                for _, r in g.iterrows()
            ],
        }

    n = len(carreras)
    _escribir("backtest.json", {
        "corte": {"year": int(corte["Year"]), "round": int(corte["Round"])},
        "resumen": {
            "carreras": n,
            "mae": float(np.mean(maes)) if maes else None,
            "ganador_pct": 100 * aciertos_g / n if n else 0,
            "podio_pct": 100 * aciertos_p / (3 * n) if n else 0,
        },
        "carreras": carreras,
    })
