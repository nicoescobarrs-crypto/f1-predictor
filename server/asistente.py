"""Genera la respuesta a partir de la Consulta que devuelve el NLU.

Cada intencion tiene su manejador. Todos devuelven el mismo formato:

    {"texto": str, "bloques": [...], "sugerencias": [str], "intencion": str}

Los bloques son datos estructurados que la web pinta como tablas o barras,
en vez de obligar al frontend a parsear texto.

Ventaja de vivir en el servidor: aqui hay pandas y el modelo cargado, asi que
las predicciones se calculan de verdad para el escenario pedido, sin la
aproximacion de las curvas precalculadas que usa la web estatica.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from features import construir_filas, parrilla_actual
from models import predecir
from nlu import Consulta, Interprete

ORDINAL = "P{:.0f}"


def _pct(v) -> str:
    return "—" if v is None or (isinstance(v, float) and np.isnan(v)) else f"{v*100:.1f}%"


def _pos(v) -> str:
    return "—" if v is None or (isinstance(v, float) and np.isnan(v)) else f"P{v:.1f}"


class Asistente:
    def __init__(self, data: pd.DataFrame, modelos: dict, metricas: dict,
                 eventos_futuros: list[dict]):
        self.data = data
        self.modelos = modelos
        self.metricas = metricas
        self.eventos_futuros = eventos_futuros

        self.temporada = int(data["Year"].max())
        self.pilotos = self._resumen_pilotos()

        eventos = (data[["EventName", "Location", "Country"]]
                   .drop_duplicates()
                   .rename(columns={"EventName": "evento", "Location": "lugar",
                                    "Country": "pais"})
                   .to_dict("records"))
        self.interprete = Interprete(
            self.pilotos.rename(columns={"DriverId": "driver_id"}), eventos)

        # Parrilla y evento por defecto para las predicciones
        self.ultimo_evento: dict | None = None
        self.ultimo_piloto: str | None = None
        self.grid_ref = self._grid_referencia()
        self.evento_defecto = (eventos_futuros[0] if eventos_futuros else
                               {"evento": data.sort_values("Date")["EventName"].iloc[-1],
                                "lugar": "", "ronda": None})

    # ------------------------------------------------------------------ datos
    def _resumen_pilotos(self) -> pd.DataFrame:
        d = self.data.sort_values("Date")
        return (d.groupby("DriverId")
                 .agg(nombre=("FullName", "last"), abrev=("Abbreviation", "last"),
                      equipo=("TeamName", "last"), carreras=("Position", "size"),
                      media_pos=("Position", "mean"), media_grid=("GridPosition", "mean"),
                      tasa_dnf=("DNF", "mean"), ganancia=("PosGain", "mean"),
                      puntos=("Points", "sum"), ultima=("Date", "max"))
                 .reset_index())

    def _grid_referencia(self) -> list[dict]:
        campo = parrilla_actual(self.data)
        medias = []
        for did in campo["DriverId"]:
            h = self.data[self.data["DriverId"] == did].sort_values("Date")
            medias.append((did, float(h["GridPosition"].tail(5).mean())))
        medias.sort(key=lambda t: t[1])
        return [{"driver_id": d, "grid": i + 1} for i, (d, _) in enumerate(medias)]

    def _piloto(self, did: str) -> pd.Series:
        return self.pilotos[self.pilotos["DriverId"] == did].iloc[0]

    def _evento_de(self, c: Consulta) -> dict:
        # Si la pregunta no nombra circuito, se mantiene el de la anterior: al
        # preguntar "y si sale desde la pole" el usuario sigue hablando del
        # mismo GP, no del siguiente del calendario.
        if not c.evento:
            return self.ultimo_evento or self.evento_defecto
        fila = self.data[self.data["EventName"] == c.evento]
        lugar = fila["Location"].iloc[0] if len(fila) else ""
        for ev in self.eventos_futuros:
            if ev["evento"] == c.evento:
                return ev
        return {"evento": c.evento, "lugar": lugar, "ronda": None}

    # -------------------------------------------------------------- prediccion
    def _predecir(self, evento: dict, cambios: dict[str, int] | None = None):
        """Predice la carrera completa, opcionalmente moviendo a algun piloto.

        cambios: {driver_id: nueva_posicion_de_salida}. El resto de pilotos se
        desplaza para que la parrilla siga siendo una permutacion valida.
        """
        orden = [e["driver_id"] for e in sorted(self.grid_ref, key=lambda x: x["grid"])]

        for did, destino in (cambios or {}).items():
            if did in orden:
                orden.remove(did)
                orden.insert(max(0, min(int(destino) - 1, len(orden))), did)

        entradas = [{"driver_id": d, "grid": i + 1} for i, d in enumerate(orden)]
        filas = construir_filas(self.data, entradas, evento["evento"],
                                evento.get("lugar", ""), evento.get("ronda"))
        return predecir(self.modelos, filas)

    # =================================================================
    #  MANEJADORES
    # =================================================================
    def _ayuda(self, c: Consulta) -> dict:
        return {
            "texto": (
                "Puedo consultar el modelo y el histórico de "
                f"{self.data.groupby(['Year','Round']).ngroups} carreras. "
                "Pregúntame en lenguaje normal, tolero erratas y entiendo los "
                "nombres coloquiales de los circuitos (Monza, Spa, Montmeló…)."
            ),
            "bloques": [{
                "tipo": "lista",
                "titulo": "Qué puedo responder",
                "items": [
                    "**Predicciones** — «¿cómo le irá a Verstappen en Monza?», «¿y si Norris sale P5?»",
                    "**Comparaciones** — «compara a Leclerc y Hamilton»",
                    "**Fichas de piloto** — «estadísticas de Alonso»",
                    "**Carreras pasadas** — «¿qué pasó en Hungría 2026?»",
                    "**Campeonato** — «¿cómo va la clasificación?»",
                    "**Circuitos** — «¿a quién se le da bien Spa?»",
                    "**El modelo** — «¿qué tan fiable es?», «¿qué variables importan?»",
                ],
            }],
            "sugerencias": ["¿Quién gana la próxima carrera?",
                            "Compara a Verstappen y Norris",
                            "¿Qué tan fiable es el modelo?"],
            "intencion": c.intencion,
        }

    def _modelo(self, c: Consulta) -> dict:
        m = self.metricas
        imp = m["importancias"][:5]

        texto = (
            f"El modelo se equivoca de media en **{m['mae_modelo']:.2f} posiciones**. "
            f"El baseline ingenuo de «cada piloto termina donde salió» se equivoca en "
            f"{m['mae_baseline']:.2f}, así que la mejora real es del "
            f"**{m['mejora_pct']:+.1f}%**.\n\n"
            f"Sobre las {m['orden']['carreras_evaluadas']} carreras de prueba acierta el "
            f"ganador el {m['orden']['acierto_ganador_pct']:.0f}% de las veces e identifica "
            f"el {m['orden']['acierto_podio_pct']:.0f}% de los pilotos del podio.\n\n"
            "Ojo con el clasificador de abandono: su AUC es "
            f"{m['auc'].get('abandono', 0):.2f}, apenas mejor que lanzar una moneda. "
            "Es honesto: los abandonos dependen de fallos mecánicos y accidentes, "
            "que son esencialmente aleatorios."
        )

        return {
            "texto": texto,
            "bloques": [
                {"tipo": "metricas", "items": [
                    {"valor": f"{m['mae_modelo']:.2f}", "etiqueta": "Error medio",
                     "nota": f"baseline {m['mae_baseline']:.2f}"},
                    {"valor": f"{m['mejora_pct']:+.1f}%", "etiqueta": "Mejora",
                     "nota": "sobre el baseline"},
                    {"valor": f"{m['orden']['acierto_ganador_pct']:.0f}%",
                     "etiqueta": "Ganador acertado", "nota": "en test"},
                ]},
                {"tipo": "tabla", "titulo": "Variables más influyentes",
                 "columnas": ["Variable", "Importancia"],
                 "filas": [[d["etiqueta"] if "etiqueta" in d else d["feature"],
                            f"{d['valor']:.3f}"] for d in imp]},
                {"tipo": "tabla", "titulo": "Rendimiento por temporada",
                 "columnas": ["Año", "Filas", "MAE modelo", "MAE baseline", "Mejora"],
                 "filas": [[str(d["anio"]), str(d["n"]), f"{d['mae_modelo']:.2f}",
                            f"{d['mae_baseline']:.2f}", f"{d['mejora_pct']:+.1f}%"]
                           for d in m.get("por_temporada", [])]},
            ],
            "sugerencias": ["¿Por qué el abandono es impredecible?",
                            "¿Quién gana la próxima carrera?"],
            "intencion": c.intencion,
        }

    def _piloto_ficha(self, c: Consulta) -> dict:
        if not c.pilotos:
            return self._no_entendido(c, "No he identificado a ningún piloto.")

        p = self._piloto(c.pilotos[0])
        h = self.data[self.data["DriverId"] == p.DriverId].sort_values("Date")
        act = h[h["Year"] == self.temporada]
        ult5 = h.tail(5)

        victorias = int((h["Position"] == 1).sum())
        podios = int((h["Position"] <= 3).sum())

        texto = (
            f"**{p.nombre}** ({p.abrev}) — {p.equipo}\n\n"
            f"En las {p.carreras} carreras que tengo registradas promedia "
            f"**{_pos(p.media_pos)}** de llegada saliendo desde {_pos(p.media_grid)}, "
            f"lo que supone {p.ganancia:+.1f} posiciones ganadas por carrera. "
            f"Suma {victorias} victorias y {podios} podios, con un "
            f"{_pct(p.tasa_dnf)} de abandonos.\n\n"
            f"En sus últimas 5 carreras promedia **{_pos(ult5['Position'].mean())}**"
        )
        if len(act):
            texto += (f", y en {self.temporada} lleva {act['Points'].sum():.0f} puntos "
                      f"en {len(act)} carreras.")
        else:
            texto += "."

        return {
            "texto": texto,
            "bloques": [
                {"tipo": "metricas", "items": [
                    {"valor": _pos(p.media_pos), "etiqueta": "Llegada media",
                     "nota": f"salida {_pos(p.media_grid)}"},
                    {"valor": f"{victorias} / {podios}", "etiqueta": "Victorias / podios",
                     "nota": f"{p.puntos:.0f} puntos"},
                    {"valor": _pct(p.tasa_dnf), "etiqueta": "Abandonos",
                     "nota": f"{p.carreras} carreras"},
                ]},
                {"tipo": "tabla", "titulo": "Últimas 5 carreras",
                 "columnas": ["Carrera", "Sale", "Llega", "Puntos"],
                 "filas": [[f"{r.EventName} {int(r.Year)}", f"P{r.GridPosition:.0f}",
                            "DNF" if r.DNF else f"P{r.Position:.0f}", f"{r.Points:.0f}"]
                           for r in ult5.itertuples()][::-1]},
            ],
            "sugerencias": [f"¿Cómo le irá a {p.nombre.split()[-1]} en la próxima?",
                            f"Compara a {p.nombre.split()[-1]} con su compañero"],
            "intencion": c.intencion,
        }

    def _comparar(self, c: Consulta) -> dict:
        if len(c.pilotos) < 2:
            return self._no_entendido(
                c, "Necesito dos pilotos para comparar. Prueba con «compara a Norris y Piastri».")

        a, b = self._piloto(c.pilotos[0]), self._piloto(c.pilotos[1])
        ha = self.data[self.data["DriverId"] == a.DriverId]
        hb = self.data[self.data["DriverId"] == b.DriverId]

        # Duelo directo: carreras en las que ambos participaron
        comunes = set(zip(ha["Year"], ha["Round"])) & set(zip(hb["Year"], hb["Round"]))
        gana_a = gana_b = 0
        for anio, ronda in comunes:
            pa = ha[(ha["Year"] == anio) & (ha["Round"] == ronda)]["Position"].iloc[0]
            pb = hb[(hb["Year"] == anio) & (hb["Round"] == ronda)]["Position"].iloc[0]
            if pa < pb:
                gana_a += 1
            elif pb < pa:
                gana_b += 1

        mejor = a if a.media_pos < b.media_pos else b
        texto = (
            f"**{a.nombre}** ({a.equipo}) contra **{b.nombre}** ({b.equipo}).\n\n"
            f"En las {len(comunes)} carreras que han disputado juntos, "
            f"**{a.abrev} ha terminado por delante {gana_a} veces** y {b.abrev} "
            f"{gana_b}.\n\n"
            f"Por media histórica de llegada gana {mejor.nombre} "
            f"({_pos(mejor.media_pos)} frente a "
            f"{_pos(b.media_pos if mejor is a else a.media_pos)})."
        )

        def fila(etiqueta, va, vb, fmt=lambda x: f"{x:.2f}"):
            return [etiqueta, fmt(va), fmt(vb)]

        return {
            "texto": texto,
            "bloques": [{
                "tipo": "tabla", "titulo": "Cara a cara",
                "columnas": ["Métrica", a.abrev, b.abrev],
                "filas": [
                    fila("Carreras", a.carreras, b.carreras, lambda x: f"{x:.0f}"),
                    fila("Llegada media", a.media_pos, b.media_pos, _pos),
                    fila("Salida media", a.media_grid, b.media_grid, _pos),
                    fila("Posiciones ganadas", a.ganancia, b.ganancia, lambda x: f"{x:+.1f}"),
                    fila("Tasa de abandono", a.tasa_dnf, b.tasa_dnf, _pct),
                    fila("Puntos totales", a.puntos, b.puntos, lambda x: f"{x:.0f}"),
                    fila("Duelo directo", gana_a, gana_b, lambda x: f"{x:.0f}"),
                ],
            }],
            "sugerencias": [f"Estadísticas de {a.nombre.split()[-1]}",
                            "¿Quién gana la próxima carrera?"],
            "intencion": c.intencion,
        }

    def _campeonato(self, c: Consulta) -> dict:
        act = self.data[self.data["Year"] == self.temporada]
        pil = (act.groupby("DriverId")
                  .agg(nombre=("FullName", "last"), abrev=("Abbreviation", "last"),
                       equipo=("TeamName", "last"), puntos=("Points", "sum"),
                       victorias=("Position", lambda s: int((s == 1).sum())))
                  .reset_index().sort_values("puntos", ascending=False))
        eq = (act.groupby("TeamName")["Points"].sum()
                 .sort_values(ascending=False).reset_index())

        lider = pil.iloc[0]
        segundo = pil.iloc[1] if len(pil) > 1 else None
        ventaja = (lider["puntos"] - segundo["puntos"]) if segundo is not None else 0

        texto = (
            f"Campeonato {self.temporada}, tras "
            f"{act.groupby('Round').ngroups} carreras.\n\n"
            f"Lidera **{lider['nombre']}** con {lider['puntos']:.0f} puntos"
        )
        if segundo is not None:
            texto += (f", {ventaja:.0f} por delante de {segundo['nombre']}"
                      f" ({segundo['puntos']:.0f}).")
        texto += f"\n\nEn constructores manda **{eq.iloc[0]['TeamName']}** con {eq.iloc[0]['Points']:.0f}."

        return {
            "texto": texto,
            "bloques": [
                {"tipo": "tabla", "titulo": f"Pilotos {self.temporada}",
                 "columnas": ["#", "Piloto", "Equipo", "Puntos", "V"],
                 "filas": [[str(i + 1), r["nombre"], r["equipo"],
                            f"{r['puntos']:.0f}", str(r["victorias"])]
                           for i, (_, r) in enumerate(pil.head(10).iterrows())]},
                {"tipo": "tabla", "titulo": "Constructores",
                 "columnas": ["#", "Equipo", "Puntos"],
                 "filas": [[str(i + 1), r["TeamName"], f"{r['Points']:.0f}"]
                           for i, (_, r) in enumerate(eq.head(10).iterrows())]},
            ],
            "sugerencias": ["¿Quién gana la próxima carrera?",
                            f"Estadísticas de {lider['nombre'].split()[-1]}"],
            "intencion": c.intencion,
        }

    def _carrera_pasada(self, c: Consulta) -> dict:
        d = self.data
        if c.evento:
            d = d[d["EventName"] == c.evento]
        if c.anio:
            d = d[d["Year"] == c.anio]
        if d.empty:
            return self._no_entendido(
                c, "No encuentro esa carrera en los datos que tengo cargados.")

        # La mas reciente que encaje
        ult = d.sort_values("Date").iloc[-1]
        g = self.data[(self.data["Year"] == ult["Year"]) &
                      (self.data["Round"] == ult["Round"])].sort_values("Position")

        ganador = g.iloc[0]
        dnfs = int(g["DNF"].sum())
        remontada = g.loc[(g["GridPosition"] - g["Position"]).idxmax()]

        texto = (
            f"**{ult['EventName']} {int(ult['Year'])}** ({ult['Location']}, "
            f"{pd.to_datetime(ult['Date']).strftime('%d/%m/%Y')}).\n\n"
            f"Ganó **{ganador['FullName']}** ({ganador['TeamName']}) saliendo desde "
            f"P{ganador['GridPosition']:.0f}. Hubo {dnfs} abandonos de "
            f"{len(g)} coches.\n\n"
            f"La mejor remontada fue la de {remontada['FullName']}: de "
            f"P{remontada['GridPosition']:.0f} a P{remontada['Position']:.0f} "
            f"({remontada['GridPosition'] - remontada['Position']:+.0f})."
        )

        return {
            "texto": texto,
            "bloques": [{
                "tipo": "tabla", "titulo": "Resultado",
                "columnas": ["Pos", "Piloto", "Equipo", "Sale", "Δ", "Pts"],
                "filas": [["DNF" if r.DNF else f"{r.Position:.0f}", r.FullName,
                           r.TeamName, f"P{r.GridPosition:.0f}",
                           f"{r.GridPosition - r.Position:+.0f}", f"{r.Points:.0f}"]
                          for r in g.head(12).itertuples()],
            }],
            "sugerencias": [f"¿Cómo le irá a {ganador['FullName'].split()[-1]} en la próxima?",
                            "¿Cómo va el campeonato?"],
            "intencion": c.intencion,
        }

    def _circuito(self, c: Consulta) -> dict:
        if not c.evento:
            return self._no_entendido(c, "¿De qué circuito quieres saber?")

        h = self.data[self.data["EventName"] == c.evento]
        if h.empty:
            return self._no_entendido(c, "No tengo carreras de ese circuito.")

        top = (h.groupby("DriverId")
                .agg(nombre=("FullName", "last"), equipo=("TeamName", "last"),
                     veces=("Position", "size"), media=("Position", "mean"),
                     mejor=("Position", "min"))
                .reset_index())
        top = top[top["veces"] >= 2].sort_values("media").head(8)

        urbano = "urbano" if h["IsStreet"].iloc[0] else "permanente"
        ganancia = (h["GridPosition"] - h["Position"]).abs().mean()

        texto = (
            f"**{c.evento}** ({h['Location'].iloc[0]}), circuito {urbano}. "
            f"Tengo {h.groupby(['Year','Round']).ngroups} ediciones registradas.\n\n"
            f"De media, cada piloto cambia {ganancia:.1f} posiciones respecto a su "
            f"parrilla: "
        )
        texto += ("es un trazado donde adelantar cuesta, así que la clasificación "
                  "pesa mucho." if ganancia < 3 else
                  "hay bastante movimiento respecto a la parrilla de salida.")

        return {
            "texto": texto,
            "bloques": [{
                "tipo": "tabla", "titulo": f"Quién rinde mejor en {c.evento}",
                "columnas": ["Piloto", "Equipo", "Ediciones", "Media", "Mejor"],
                "filas": [[r["nombre"], r["equipo"], f"{r['veces']:.0f}",
                           _pos(r["media"]), f"P{r['mejor']:.0f}"]
                          for _, r in top.iterrows()],
            }],
            "sugerencias": [f"¿Quién ganará en {c.evento}?", "¿Cómo va el campeonato?"],
            "intencion": c.intencion,
        }

    def _prediccion(self, c: Consulta) -> dict:
        evento = self._evento_de(c)
        self.ultimo_evento = evento
        cambios = {}
        if c.pilotos and c.grid:
            cambios[c.pilotos[0]] = c.grid

        pred = self._predecir(evento, cambios)

        # --- Pregunta sobre un piloto concreto ---
        if c.pilotos:
            did = c.pilotos[0]
            fila = pred[pred["DriverId"] == did]
            if fila.empty:
                p = self._piloto(did)
                return self._no_entendido(
                    c, f"{p.nombre} no está en la parrilla actual, así que no puedo "
                       "predecir su resultado.")

            r = fila.iloc[0]
            apellido = r["FullName"].split()[-1]
            escenario = (f"saliendo desde P{r['GridPosition']:.0f}" if c.grid
                         else f"si sale desde P{r['GridPosition']:.0f} "
                              "(su parrilla estimada según su forma reciente)")

            texto = (
                f"**{r['FullName']}** en el **{evento['evento']}**, {escenario}:\n\n"
                f"El modelo lo sitúa en **P{r['PosicionPredicha']:.0f}** "
                f"(estimación bruta {r['PosEstimada']:.1f}, error típico "
                f"±{self.metricas['mae_modelo']:.1f} posiciones).\n\n"
                f"Sus probabilidades: **{_pct(r['prob_victoria'])} de ganar**, "
                f"{_pct(r['prob_podio'])} de podio, {_pct(r['prob_puntos'])} de puntuar "
                f"y {_pct(r['prob_abandono'])} de abandonar."
            )

            return {
                "texto": texto,
                "bloques": [
                    {"tipo": "probabilidades", "titulo": f"{r['Abbreviation']} — {evento['evento']}",
                     "items": [
                         {"etiqueta": "Victoria", "valor": float(r["prob_victoria"]), "clase": "victoria"},
                         {"etiqueta": "Podio", "valor": float(r["prob_podio"]), "clase": "podio"},
                         {"etiqueta": "Puntos", "valor": float(r["prob_puntos"]), "clase": "puntos"},
                         {"etiqueta": "Abandono", "valor": float(r["prob_abandono"]), "clase": "abandono"},
                     ]},
                    self._tabla_prediccion(pred, evento, destacar=did),
                ],
                # No sugerir el escenario que el usuario acaba de preguntar.
                "sugerencias": [
                    s for s in [
                        (f"¿Y si {apellido} sale desde la pole?"
                         if r["GridPosition"] > 1 else f"¿Y si {apellido} sale P10?"),
                        (f"¿Y si sale último?" if r["GridPosition"] < len(pred) - 2
                         else f"¿Y si sale P5?"),
                        f"¿Quién gana el {evento['evento']}?",
                    ] if s
                ],
                "intencion": c.intencion,
            }

        # --- Pregunta sobre la carrera entera ---
        top3 = pred.head(3)
        favorito = pred.loc[pred["prob_victoria"].idxmax()]
        primero = top3.iloc[0]

        texto = (
            f"Predicción para el **{evento['evento']}**"
            + (f" ({evento['fecha']})" if evento.get("fecha") else "") + ":\n\n"
            f"El regresor coloca primero a **{primero['FullName']}**, seguido de "
            f"{top3.iloc[1]['FullName']} y {top3.iloc[2]['FullName']}.\n\n"
        )

        # Regresor y clasificador son modelos distintos y pueden discrepar.
        # Decirlo es mas honesto que enseñar solo uno de los dos.
        if favorito["DriverId"] != primero["DriverId"]:
            texto += (
                f"Pero el clasificador de victoria apunta a otro: da "
                f"**{_pct(favorito['prob_victoria'])} a {favorito['FullName']}**, "
                f"frente al {_pct(primero['prob_victoria'])} de {primero['Abbreviation']}. "
                "Son dos modelos distintos: uno estima la posición media y el otro la "
                "probabilidad de ganar, que premia a quien gana mucho aunque a veces "
                "termine lejos.\n\n"
            )
        else:
            texto += (f"También es el favorito del clasificador, con "
                      f"{_pct(favorito['prob_victoria'])} de victoria.\n\n")

        texto += (
            "La parrilla de partida es una estimación basada en la posición de salida "
            "media reciente de cada piloto, porque todavía no hay clasificación."
        )

        return {
            "texto": texto,
            "bloques": [self._tabla_prediccion(pred, evento)],
            "sugerencias": [
                f"¿Y si {top3.iloc[1]['FullName'].split()[-1]} sale desde la pole?",
                "¿Qué tan fiable es el modelo?",
            ],
            "intencion": c.intencion,
        }

    def _tabla_prediccion(self, pred: pd.DataFrame, evento: dict,
                          destacar: str | None = None) -> dict:
        return {
            "tipo": "tabla",
            "titulo": f"Orden previsto — {evento['evento']}",
            "destacar": destacar,
            "columnas": ["Pos", "Piloto", "Equipo", "Sale", "Victoria", "Podio", "Puntos"],
            "filas": [[f"{r.PosicionPredicha:.0f}", r.FullName, r.TeamName,
                       f"P{r.GridPosition:.0f}", _pct(r.prob_victoria),
                       _pct(r.prob_podio), _pct(r.prob_puntos)]
                      for r in pred.head(10).itertuples()],
        }

    def _no_entendido(self, c: Consulta, motivo: str = "") -> dict:
        return {
            "texto": (motivo or "No he entendido la pregunta.") +
                     "\n\nPuedo predecir carreras, comparar pilotos, consultar resultados "
                     "históricos y explicarte cómo funciona el modelo.",
            "bloques": [],
            "sugerencias": ["¿Qué puedes hacer?", "¿Quién gana la próxima carrera?",
                            "Compara a Verstappen y Norris"],
            "intencion": "desconocida",
        }

    # =================================================================
    def responder(self, pregunta: str) -> dict:
        c = self.interprete.interpretar(pregunta)

        # "y si sale desde la pole" no nombra a nadie, pero al pedir una parrilla
        # concreta se refiere al piloto del que veniamos hablando. Sin parrilla
        # ("quien gana esa carrera") si se entiende que pregunta por todos.
        if c.intencion == "prediccion" and not c.pilotos and c.grid and self.ultimo_piloto:
            c.pilotos = [self.ultimo_piloto]
        if c.pilotos:
            self.ultimo_piloto = c.pilotos[0]

        manejadores = {
            "ayuda": self._ayuda,
            "modelo": self._modelo,
            "piloto": self._piloto_ficha,
            "comparar": self._comparar,
            "campeonato": self._campeonato,
            "carrera_pasada": self._carrera_pasada,
            "circuito": self._circuito,
            "prediccion": self._prediccion,
        }

        try:
            r = manejadores.get(c.intencion, self._no_entendido)(c)
        except Exception as e:  # nunca romper la conversacion por un fallo interno
            r = self._no_entendido(c, f"Algo ha fallado procesando eso ({e}).")

        r.setdefault("bloques", [])
        r.setdefault("sugerencias", [])
        r["entidades"] = {
            "pilotos": c.pilotos, "evento": c.evento,
            "anio": c.anio, "grid": c.grid,
        }
        return r
