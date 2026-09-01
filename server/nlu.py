"""Comprension de la pregunta: intencion + entidades.

No hay ningun modelo de lenguaje detras. Es un clasificador de intencion por
palabras clave mas un extractor de entidades con coincidencia difusa
(rapidfuzz), que es lo que hace que funcione escribir "verstapen" o "montmelo".

La gracia de separarlo del generador de respuestas es que se puede probar solo:
    python server/nlu.py "como le ira a alonso en monaco saliendo 5"
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from rapidfuzz import fuzz, process

# --------------------------------------------------------------------------
# Intenciones. El orden importa: la primera que casa, gana. Las mas especificas
# van antes que las generales.
# --------------------------------------------------------------------------
INTENCIONES = [
    ("ayuda", [
        r"\bque puedes hacer\b", r"\bayuda\b", r"\bcomo funciona[s]?\b",
        r"\bque sabes\b", r"\bopciones\b", r"\bejemplos?\b",
    ]),
    ("modelo", [
        r"\bmodelo\b", r"\bpreci[sc]i?on\b", r"\bfiable\b", r"\bfiabilidad\b",
        r"\bacierta[s]?\b", r"\berror\b", r"\bmae\b", r"\bauc\b",
        r"\bque tan bueno\b", r"\bentrena", r"\bvariables? mas\b",
        r"\bimportanci", r"\bmetodolog",
    ]),
    ("comparar", [
        r"\bcompara[r]?\b", r"\bversus\b", r"\bvs\.?\b", r"\bmejor que\b",
        r"\bquien es mejor\b", r"\bfrente a\b", r"\bcontra\b",
    ]),
    ("campeonato", [
        r"\bcampeonato\b", r"\bclasificaci?on\b", r"\bmundial\b",
        r"\bconstructor", r"\blider\b", r"\bpuntos? (?:total|actual)",
        r"\bquien va (?:primero|ganando|lider)\b", r"\btabla\b",
    ]),
    ("carrera_pasada", [
        r"\bque paso\b", r"\bresultado de\b", r"\bquien gano\b", r"\bganador de\b",
        r"\bcomo (?:fue|termino|acabo|quedo)\b", r"\bultima carrera\b",
        r"\bpodio de\b",
    ]),
    ("prediccion", [
        r"\bpredi", r"\bpronostic", r"\bcomo le ira\b", r"\bque tal (?:le )?ira\b",
        r"\bva a ganar\b", r"\bganara\b", r"\bquedara\b", r"\bterminara\b",
        # "quien gana" en presente mira al futuro; "quien gano" en pasado lo
        # captura antes carrera_pasada, y el \b evita que se solapen.
        r"\bquien gana\b", r"\bquien ganaria\b",
        r"\bprobabilidad", r"\bchances?\b", r"\bopciones de\b",
        r"\bsi sale\b", r"\bsaliendo\b", r"\bdesde la p\d+\b", r"\bproxima carrera\b",
        r"\bproxima\b", r"\bsiguiente (?:gran premio|carrera|gp)\b",
    ]),
    ("circuito", [
        r"\bcircuito\b", r"\btrazado\b", r"\ben (?:el )?gp\b", r"\bgran premio\b",
        r"\bhistorial en\b", r"\bse le da bien\b",
    ]),
    ("piloto", [
        r"\bestadisticas?\b", r"\bficha\b", r"\bcomo (?:va|esta|lleva)\b",
        r"\bhabla[me]? de\b", r"\bquien es\b", r"\btemporada de\b",
        r"\brendimiento de\b", r"\bforma de\b",
    ]),
]


# --------------------------------------------------------------------------
# FastF1 nombra los Grandes Premios en ingles ("Hungarian Grand Prix") pero
# nadie pregunta asi en espanol. Este mapa cubre la diferencia, incluyendo los
# nombres coloquiales de los circuitos (Monza, Spa, Montmelo...).
# Solo se indexan los que existan de verdad en los datos cargados.
# --------------------------------------------------------------------------
ALIAS_ES = {
    "hungria": "Hungarian Grand Prix", "budapest": "Hungarian Grand Prix",
    "belgica": "Belgian Grand Prix", "spa": "Belgian Grand Prix",
    "francorchamps": "Belgian Grand Prix",
    "italia": "Italian Grand Prix", "monza": "Italian Grand Prix",
    "imola": "Emilia Romagna Grand Prix", "emilia": "Emilia Romagna Grand Prix",
    "espana": "Spanish Grand Prix", "montmelo": "Spanish Grand Prix",
    "cataluna": "Spanish Grand Prix",
    "holanda": "Dutch Grand Prix", "paises bajos": "Dutch Grand Prix",
    "zandvoort": "Dutch Grand Prix",
    "gran bretana": "British Grand Prix", "inglaterra": "British Grand Prix",
    "silverstone": "British Grand Prix", "reino unido": "British Grand Prix",
    "japon": "Japanese Grand Prix", "suzuka": "Japanese Grand Prix",
    "australia": "Australian Grand Prix", "melbourne": "Australian Grand Prix",
    "china": "Chinese Grand Prix", "shanghai": "Chinese Grand Prix",
    "canada": "Canadian Grand Prix", "montreal": "Canadian Grand Prix",
    "austria": "Austrian Grand Prix", "spielberg": "Austrian Grand Prix",
    "azerbaiyan": "Azerbaijan Grand Prix", "baku": "Azerbaijan Grand Prix",
    "singapur": "Singapore Grand Prix",
    "estados unidos": "United States Grand Prix", "austin": "United States Grand Prix",
    "mexico": "Mexico City Grand Prix",
    "brasil": "São Paulo Grand Prix", "interlagos": "São Paulo Grand Prix",
    "sao paulo": "São Paulo Grand Prix",
    "catar": "Qatar Grand Prix", "lusail": "Qatar Grand Prix",
    "abu dabi": "Abu Dhabi Grand Prix", "yas marina": "Abu Dhabi Grand Prix",
    "arabia": "Saudi Arabian Grand Prix", "yeda": "Saudi Arabian Grand Prix",
    "bahrein": "Bahrain Grand Prix", "sakhir": "Bahrain Grand Prix",
    "monaco": "Monaco Grand Prix", "montecarlo": "Monaco Grand Prix",
    "monte carlo": "Monaco Grand Prix",
    "portugal": "Portuguese Grand Prix", "portimao": "Portuguese Grand Prix",
    "francia": "French Grand Prix", "paul ricard": "French Grand Prix",
    "rusia": "Russian Grand Prix", "sochi": "Russian Grand Prix",
    "turquia": "Turkish Grand Prix", "estambul": "Turkish Grand Prix",
    "las vegas": "Las Vegas Grand Prix", "miami": "Miami Grand Prix",
}


def normalizar(texto: str) -> str:
    """minusculas, sin tildes, sin puntuacion sobrante."""
    t = unicodedata.normalize("NFKD", str(texto))
    t = t.encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", t)).strip()


@dataclass
class Consulta:
    """Lo que el asistente entendio de la pregunta."""
    texto: str
    normalizado: str
    intencion: str = "desconocida"
    pilotos: list[str] = field(default_factory=list)   # driver_ids
    evento: str | None = None                          # EventName exacto
    anio: int | None = None
    grid: int | None = None
    confianza: float = 0.0


class Interprete:
    """Traduce texto libre en una Consulta estructurada."""

    def __init__(self, pilotos_df, eventos: list[dict]):
        # ---- indice de pilotos: alias -> driver_id ----
        self.alias_piloto: dict[str, str] = {}
        self.abrev_piloto: dict[str, str] = {}

        for r in pilotos_df.itertuples():
            did = r.driver_id
            nombre = str(r.nombre)
            partes = nombre.split()

            self.abrev_piloto[normalizar(r.abrev)] = did
            for alias in {nombre, did.replace("_", " "), partes[-1]}:
                a = normalizar(alias)
                if len(a) >= 4:
                    self.alias_piloto[a] = did

        # ---- indice de eventos: alias -> EventName ----
        self.alias_evento: dict[str, str] = {}
        nombres = {ev["evento"] for ev in eventos}

        for ev in eventos:
            nombre = ev["evento"]
            for alias in {nombre, ev.get("lugar", ""), ev.get("pais", "")}:
                a = normalizar(alias)
                if len(a) >= 3:
                    self.alias_evento[a] = nombre
            # "Italian Grand Prix" -> tambien "italian"
            corto = normalizar(nombre).replace(" grand prix", "")
            if len(corto) >= 3:
                self.alias_evento[corto] = nombre

        # Alias en espanol, solo para los GP presentes en los datos
        for alias, destino in ALIAS_ES.items():
            if destino in nombres:
                self.alias_evento[normalizar(alias)] = destino

    # ---------------------------------------------------------------- intencion
    def _intencion(self, norm: str) -> tuple[str, float]:
        for nombre, patrones in INTENCIONES:
            for p in patrones:
                if re.search(p, norm):
                    return nombre, 1.0
        return "desconocida", 0.0

    # ---------------------------------------------------------------- entidades
    def _buscar_pilotos(self, norm: str, texto: str, maximo: int = 3) -> list[str]:
        """Pilotos mencionados, en orden de aparicion en la frase.

        Compara alias contra PALABRAS sueltas, no contra la frase entera.
        Con partial_ratio sobre la frase, "alonso" arrastraba tambien a "albon"
        (comparte al- y -on), y dos pilotos detectados disparan por error una
        comparacion. A nivel de palabra, ratio("alonso","albon") = 73 y no pasa
        el corte, mientras que la errata ratio("verstapen","verstappen") = 95 si.
        """
        encontrados: list[tuple[int, str]] = []
        ya: set[str] = set()

        def anadir(pos: int, did: str) -> None:
            if did not in ya:
                ya.add(did)
                encontrados.append((pos, did))

        # 1) Abreviaturas en mayusculas (VER, HAM) — exigen palabra exacta
        for token in re.findall(r"\b[A-Z]{3}\b", texto):
            did = self.abrev_piloto.get(normalizar(token))
            if did:
                anadir(texto.find(token), did)

        palabras = [(m.group(0), m.start()) for m in re.finditer(r"\w+", norm)]

        # 2) Alias de una palabra: comparacion palabra a palabra
        for alias, did in self.alias_piloto.items():
            if " " in alias or did in ya:
                continue
            for palabra, pos in palabras:
                if len(palabra) < 4:
                    continue
                if fuzz.ratio(alias, palabra) >= 86:
                    anadir(pos, did)
                    break

        # 3) Alias de varias palabras ("max verstappen"): ahi si tiene sentido
        #    buscar dentro de la frase completa
        for alias, did in self.alias_piloto.items():
            if " " not in alias or did in ya:
                continue
            if fuzz.partial_ratio(alias, norm) >= 90:
                anadir(norm.find(alias.split()[0][:4]), did)

        vistos, salida = set(), []
        for pos, did in sorted(encontrados, key=lambda t: (t[0] if t[0] >= 0 else 999)):
            if did not in vistos:
                vistos.add(did)
                salida.append(did)
        return salida[:maximo]

    def _buscar_evento(self, norm: str) -> str | None:
        """Circuito o Gran Premio mencionado.

        Dos pasadas, porque una sola no vale para ambos casos:
          1. Coincidencia exacta de palabra. Imprescindible para alias cortos
             como "spa": con logica difusa casaria con "espana".
          2. Difusa, solo para alias largos, que es donde importa tolerar
             erratas ("montmelo" -> "montmelo", "zanvort" -> "zandvoort").
        """
        if not self.alias_evento:
            return None

        # 1) exacta, preferiendo el alias mas largo que aparezca
        mejor = None
        for alias, destino in self.alias_evento.items():
            if re.search(rf"\b{re.escape(alias)}\b", norm):
                if mejor is None or len(alias) > len(mejor[0]):
                    mejor = (alias, destino)
        if mejor:
            return mejor[1]

        # 2) difusa, ignorando los alias cortos
        largos = [a for a in self.alias_evento if len(a) >= 5]
        if not largos:
            return None
        m = process.extractOne(norm, largos, scorer=fuzz.partial_ratio,
                               score_cutoff=88)
        return self.alias_evento[m[0]] if m else None

    @staticmethod
    def _buscar_grid(norm: str) -> int | None:
        """Posicion de salida: 'saliendo 5', 'desde la p3', 'en pole'."""
        if re.search(r"\bpole\b|\bprimero en la parrilla\b|\bdesde delante\b", norm):
            return 1
        if re.search(r"\bultimo\b|\bcolista\b|\bdesde atras\b|\bpit\s?lane\b", norm):
            return 99   # el manejador lo recorta al tamano real de la parrilla
        patrones = [
            r"\b(?:sale|saliendo|salida|desde|parrilla|grid)\D{0,12}(\d{1,2})\b",
            r"\bp(\d{1,2})\b",
            r"\b(\d{1,2})\D{0,6}(?:de|en la) parrilla\b",
        ]
        for p in patrones:
            m = re.search(p, norm)
            if m:
                v = int(m.group(1))
                if 1 <= v <= 24:
                    return v
        return None

    @staticmethod
    def _buscar_anio(norm: str) -> int | None:
        m = re.search(r"\b(19[5-9]\d|20[0-4]\d)\b", norm)
        return int(m.group(1)) if m else None

    # ------------------------------------------------------------------ publico
    def interpretar(self, texto: str) -> Consulta:
        norm = normalizar(texto)
        intencion, conf = self._intencion(norm)

        c = Consulta(texto=texto, normalizado=norm, intencion=intencion,
                     confianza=conf)
        c.pilotos = self._buscar_pilotos(norm, texto)
        c.evento  = self._buscar_evento(norm)
        c.anio    = self._buscar_anio(norm)
        c.grid    = self._buscar_grid(norm)

        # Si no reconocimos la intencion pero si las entidades, deducirla.
        if c.intencion == "desconocida":
            if len(c.pilotos) >= 2:
                c.intencion, c.confianza = "comparar", 0.6
            elif c.pilotos and (c.evento or c.grid):
                c.intencion, c.confianza = "prediccion", 0.6
            elif c.pilotos:
                c.intencion, c.confianza = "piloto", 0.5
            elif c.evento:
                c.intencion = "carrera_pasada" if c.anio else "circuito"
                c.confianza = 0.5

        # Una pregunta con año explícito sobre un GP mira al pasado,
        # aunque las palabras suenen a predicción.
        if c.intencion == "prediccion" and c.anio and c.evento:
            c.intencion = "carrera_pasada"

        return c


# ------------------------------- prueba rapida ------------------------------
if __name__ == "__main__":
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).parent.parent / "pipeline"))
    import json

    WEB = Path(__file__).parent.parent / "web" / "data"
    pilotos = json.loads((WEB / "pilotos.json").read_text(encoding="utf-8"))
    carreras = json.loads((WEB / "resultados.json").read_text(encoding="utf-8"))

    import pandas as pd
    pdf = pd.DataFrame(pilotos)[["driver_id", "nombre", "abrev"]]
    eventos = [{"evento": c["evento"], "lugar": c["lugar"], "pais": c["pais"]}
               for c in carreras]

    interprete = Interprete(pdf, eventos)

    pruebas = sys.argv[1:] or [
        "como le ira a verstappen en monza",
        "compara a norris y piastri",
        "que paso en hungria 2026",
        "como va el campeonato",
        "estadisticas de alonso",
        "que probabilidad tiene hamilton de ganar si sale P3",
        "que tan bueno es el modelo",
        "quien gano en spa",
        "verstapen",  # con errata a proposito
        "que puedes hacer",
    ]
    for p in pruebas:
        c = interprete.interpretar(p)
        print(f"\n{p!r}")
        print(f"   intencion={c.intencion}  pilotos={c.pilotos}  "
              f"evento={c.evento}  anio={c.anio}  grid={c.grid}")
