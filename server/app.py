"""Servidor local: sirve la web y expone el asistente y el modelo en vivo.

    python server/app.py

Luego abre http://localhost:5000

Endpoints
---------
GET  /                 la web estatica (misma que en produccion)
POST /api/chat         {"pregunta": "..."} -> respuesta del asistente
POST /api/predecir     {"evento": "...", "grid": {"driver_id": pos}} -> prediccion exacta
GET  /api/estado       diagnostico: si el modelo esta cargado, cuantas carreras, etc.

La web estatica funciona sin este servidor; el chat es una mejora opcional que
se activa sola cuando detecta que /api/estado responde.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "pipeline"))
sys.path.insert(0, str(RAIZ / "server"))

from flask import Flask, jsonify, request, send_from_directory  # noqa: E402

import features  # noqa: E402
from asistente import Asistente  # noqa: E402
from data import calendario_futuro, construir_dataset  # noqa: E402
from features import preparar  # noqa: E402
from models import entrenar  # noqa: E402

WEB = RAIZ / "web"

app = Flask(__name__, static_folder=None)

ESTADO: dict = {"listo": False, "error": None}


# --------------------------------------------------------------------------
def arrancar() -> None:
    """Carga datos y entrena. Se ejecuta una vez, al iniciar el proceso."""
    t0 = time.time()
    print("Cargando datos...")
    raw = construir_dataset(refrescar=False)

    print("Construyendo features...")
    features.limpiar_cache()
    _, data = preparar(raw)

    print("Entrenando modelos...")
    modelos = entrenar(data)

    temporada = int(data["Year"].max())
    fut = calendario_futuro(temporada)
    eventos_futuros = []
    for r in fut.head(6).itertuples():
        eventos_futuros.append({
            "evento": r.EventName,
            "lugar": getattr(r, "Location", ""),
            "ronda": int(r.RoundNumber),
            "fecha": str(r.EventDate)[:10],
        })

    ESTADO.update({
        "listo": True,
        "asistente": Asistente(data, modelos, modelos["metricas"], eventos_futuros),
        "carreras": int(data.groupby(["Year", "Round"]).ngroups),
        "temporada": temporada,
        "proximas": [e["evento"] for e in eventos_futuros],
        "mae": round(modelos["metricas"]["mae_modelo"], 2),
        "segundos_arranque": round(time.time() - t0, 1),
    })
    print(f"Listo en {ESTADO['segundos_arranque']}s. "
          f"http://localhost:5000")


# ------------------------------- WEB ESTATICA ------------------------------
@app.route("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.route("/<path:ruta>")
def estatico(ruta):
    return send_from_directory(WEB, ruta)


# ---------------------------------- API ------------------------------------
@app.route("/api/estado")
def api_estado():
    if not ESTADO.get("listo"):
        return jsonify({"listo": False, "error": ESTADO.get("error")}), 503
    return jsonify({k: v for k, v in ESTADO.items() if k != "asistente"})


@app.route("/api/chat", methods=["POST"])
def api_chat():
    if not ESTADO.get("listo"):
        return jsonify({"error": "El modelo todavía se está cargando."}), 503

    datos = request.get_json(silent=True) or {}
    pregunta = str(datos.get("pregunta", "")).strip()
    if not pregunta:
        return jsonify({"error": "Falta la pregunta."}), 400
    if len(pregunta) > 500:
        pregunta = pregunta[:500]

    return jsonify(ESTADO["asistente"].responder(pregunta))


@app.route("/api/predecir", methods=["POST"])
def api_predecir():
    """Prediccion exacta para un escenario arbitrario.

    A diferencia de la web estatica, aqui no hay aproximacion: se reconstruyen
    las features de los 20 coches y se pasa el modelo de verdad.
    """
    if not ESTADO.get("listo"):
        return jsonify({"error": "El modelo todavía se está cargando."}), 503

    datos = request.get_json(silent=True) or {}
    a = ESTADO["asistente"]

    nombre = datos.get("evento")
    evento = a.evento_defecto
    if nombre:
        for ev in a.eventos_futuros:
            if ev["evento"] == nombre:
                evento = ev
                break
        else:
            evento = {"evento": nombre, "lugar": datos.get("lugar", ""), "ronda": None}

    cambios = {str(k): int(v) for k, v in (datos.get("grid") or {}).items()}
    pred = a._predecir(evento, cambios)

    return jsonify({
        "evento": evento["evento"],
        "prediccion": [{
            "driver_id": r.DriverId, "abrev": r.Abbreviation, "nombre": r.FullName,
            "equipo": r.TeamName, "grid": float(r.GridPosition),
            "pos_predicha": int(r.PosicionPredicha),
            "pos_estimada": round(float(r.PosEstimada), 2),
            "victoria": round(float(r.prob_victoria), 4),
            "podio": round(float(r.prob_podio), 4),
            "puntos": round(float(r.prob_puntos), 4),
            "abandono": round(float(r.prob_abandono), 4),
        } for r in pred.itertuples()],
    })


# --------------------------------------------------------------------------
if __name__ == "__main__":
    try:
        arrancar()
    except Exception as e:
        ESTADO["error"] = str(e)
        print(f"\nERROR al arrancar: {e}")
        print("¿Has ejecutado antes 'python pipeline/run.py --refrescar'?")
        raise SystemExit(1)

    # debug=False: con el recargador activo entrenaria el modelo dos veces.
    app.run(host="127.0.0.1", port=5000, debug=False)
