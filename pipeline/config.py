"""Configuracion central del proyecto.

Todos los hiperparametros y rutas viven aqui para que cambiarlos no obligue
a tocar el resto del codigo.
"""
from pathlib import Path

# --------------------------- RUTAS ---------------------------------------
ROOT      = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "cache"          # cache de FastF1 (descargas crudas)
DATA_DIR  = ROOT / "data"           # dataset procesado en parquet
WEB_DATA  = ROOT / "web" / "data"   # JSON que consume la pagina web

for _d in (CACHE_DIR, DATA_DIR, WEB_DATA, WEB_DATA / "events"):
    _d.mkdir(parents=True, exist_ok=True)

# ------------------------ HIPERPARAMETROS --------------------------------
YEARS         = [2021, 2022, 2023, 2024, 2025, 2026]
RECENCY_DECAY = 0.75   # peso de cada temporada hacia atras (1.0 = todas igual)
FORM_WINDOW   = 5      # carreras para la "forma" del piloto
DNF_WINDOW    = 10     # carreras para la tasa de abandono
TEAM_WINDOW   = 10     # filas (~5 carreras x 2 coches) para la forma del equipo
RANDOM_STATE  = 42
TEST_FRACTION = 0.15   # ultimo 15% del calendario = conjunto de prueba

# Hiperparametros elegidos con pipeline/experimento.py, no a ojo.
# depth=6 sobreajustaba: con ~2000 filas, los arboles poco profundos generalizan
# mejor (MAE 3.13 frente a 3.24).
REG_PARAMS = {"loss": "absolute_error", "max_iter": 300, "learning_rate": 0.05,
              "max_depth": 4, "l2_regularization": 1.0}
CLF_PARAMS = {"max_iter": 400, "learning_rate": 0.05,
              "max_depth": 5, "l2_regularization": 1.0}

# ---------------------- RESTRICCIONES DE MONOTONIA -------------------------
# Sin esto, los clasificadores daban MAS probabilidad de ganar desde P8 que
# desde P5, y un 15% de victoria saliendo ultimo (en la realidad es 0.2%).
# Motivo: las variables de forma del piloto dominan, y en los datos reales un
# piloto rapido casi nunca sale al fondo, asi que el modelo nunca aprendio ese
# contrafactual. Un AUC alto no lo detecta: ordenar bien no es estar calibrado.
#
# La solucion es inyectar lo que sabemos con certeza: a igualdad de todo lo
# demas, salir mas atras no puede mejorar tu resultado.
#   -1 = la probabilidad debe decrecer al crecer la variable
#   +1 = debe crecer
#    0 = sin restriccion
# TeammateGridDelta entra tambien: sin el, mover al piloto cambiaba esa variable
# sin restriccion y la curva seguia sin ser monotona (P5 daba 3% y P8 daba 12%).
MONOTONIA_CLF = {"GridPosition": -1, "GridNorm": -1, "TeammateGridDelta": -1}

# El regresor NO lleva restriccion: ya salia monotono por si solo y forzarla le
# empeoraba el MAE de 3.11 a 3.20. Se impone solo lo que hace falta.
MONOTONIA_REG: dict[str, int] = {}


def restricciones(mapa: dict[str, int]) -> list[int]:
    """Traduce {feature: signo} al vector que espera scikit-learn."""
    return [mapa.get(f, 0) for f in FEATURES]

# Circuitos urbanos / semiurbanos: la parrilla pesa mucho mas porque adelantar
# es dificil. Es una de las features con mas senal del modelo.
STREET_TRACKS = {
    "monaco", "singapore", "baku", "jeddah", "las vegas", "miami",
    "melbourne", "montreal", "montreal", "sochi", "marina bay",
}

# Columnas que pedimos a FastF1 en cada sesion de carrera
RESULT_COLS = [
    "DriverId", "Abbreviation", "FullName", "DriverNumber", "TeamName",
    "GridPosition", "Position", "ClassifiedPosition", "Points", "Status",
]

# Features del modelo. El orden importa: sklearn recibe las columnas asi.
FEATURES = [
    "GridPosition", "GridNorm", "FieldSize", "IsStreet", "Round",
    "Drv_FormPos", "Drv_FormGrid", "Drv_CareerPos", "Drv_DNFRate",
    "Drv_Gain", "Drv_Exp", "Drv_TrackPos",
    "Team_FormPos", "Team_DNFRate", "Team_FormPts", "Team_TrackPos",
    "TeammateGridDelta",
]

# Etiquetas en espanol para la web
FEATURE_LABELS = {
    "GridPosition":      "Posicion de salida",
    "GridNorm":          "Salida normalizada",
    "FieldSize":         "Coches en parrilla",
    "IsStreet":          "Circuito urbano",
    "Round":             "Numero de ronda",
    "Drv_FormPos":       "Forma del piloto (llegada)",
    "Drv_FormGrid":      "Forma del piloto (salida)",
    "Drv_CareerPos":     "Media historica del piloto",
    "Drv_DNFRate":       "Tasa de abandono del piloto",
    "Drv_Gain":          "Posiciones ganadas de media",
    "Drv_Exp":           "Experiencia (carreras)",
    "Drv_TrackPos":      "Historial en ese circuito",
    "Team_FormPos":      "Forma del equipo (llegada)",
    "Team_DNFRate":      "Fiabilidad del equipo",
    "Team_FormPts":      "Puntos recientes del equipo",
    "Team_TrackPos":     "Historial del equipo en el circuito",
    "TeammateGridDelta": "Diferencia con su companero",
}

# Objetivos de clasificacion (probabilidades que muestra la web)
TARGET_DEFS = {
    "victoria": ("Victoria", lambda d: d["Position"] == 1),
    "podio":    ("Podio",    lambda d: d["Position"] <= 3),
    "puntos":   ("Puntos",   lambda d: d["Position"] <= 10),
    "abandono": ("Abandono", lambda d: d["DNF"] == 1),
}
