/* ============================================================
   Asistente en el navegador — port del de server/asistente.py

   Existe para que el chat funcione en la web publicada, donde no
   hay Python. Como el asistente no usa ningún modelo de lenguaje,
   sus respuestas son deterministas y se pueden calcular aquí con
   los mismos JSON que ya carga la página.

   Devuelve exactamente el mismo formato que la versión de Python
   ({texto, bloques, sugerencias}), así que la capa que lo pinta
   no cambia.

   Diferencia con el backend: las predicciones salen de las curvas
   de sensibilidad precalculadas, igual que la pestaña Predicción,
   en vez de llamar al modelo en vivo.
   ============================================================ */

const AsistenteLocal = {
  datos: null,
  idxPiloto: null,
  idxEvento: null,
  eventos: null,
  ultimoEvento: null,   // memoria de un turno: el GP del que se venia hablando
  ultimoPiloto: null,   // y el piloto, para seguimientos tipo "y si sale P5"

  // ---------------------------------------------------------------- init
  iniciar(datos) {
    this.datos = datos;
    this.eventos = datos.indice.eventos;
    this._construirIndices();
    return this;
  },

  _construirIndices() {
    // --- pilotos: alias -> driver_id ---
    this.idxPiloto = { nombres: new Map(), abrevs: new Map() };
    for (const p of this.datos.pilotos) {
      this.idxPiloto.abrevs.set(normalizarTexto(p.abrev), p.driver_id);
      const partes = String(p.nombre).split(/\s+/);
      for (const alias of new Set([p.nombre, partes[partes.length - 1],
                                   p.driver_id.replace(/_/g, " ")])) {
        const a = normalizarTexto(alias);
        if (a.length >= 4) this.idxPiloto.nombres.set(a, p.driver_id);
      }
    }

    // --- eventos: alias -> nombre del GP ---
    this.idxEvento = new Map();
    const presentes = new Set(this.datos.resultados.map((c) => c.evento));

    for (const c of this.datos.resultados) {
      for (const alias of [c.evento, c.lugar, c.pais]) {
        const a = normalizarTexto(alias);
        if (a.length >= 3) this.idxEvento.set(a, c.evento);
      }
      const corto = normalizarTexto(c.evento).replace(" grand prix", "");
      if (corto.length >= 3) this.idxEvento.set(corto, c.evento);
    }
    for (const [alias, destino] of Object.entries(ALIAS_CIRCUITOS)) {
      if (presentes.has(destino)) this.idxEvento.set(normalizarTexto(alias), destino);
    }
  },

  // ----------------------------------------------------------- entidades
  _intencion(norm) {
    for (const [nombre, patrones] of INTENCIONES) {
      for (const p of patrones) if (p.test(norm)) return nombre;
    }
    return "desconocida";
  },

  /**
   * Pilotos mencionados, en orden de aparición.
   * Compara alias contra PALABRAS sueltas, no contra la frase entera:
   * con partial_ratio sobre la frase, "alonso" arrastraba también a "albon".
   */
  _buscarPilotos(norm, texto, maximo = 3) {
    const hallados = [];
    const ya = new Set();
    const anadir = (pos, did) => {
      if (!ya.has(did)) { ya.add(did); hallados.push([pos, did]); }
    };

    // Abreviaturas en mayúsculas (VER, HAM): exigen palabra exacta
    for (const m of texto.matchAll(/\b[A-Z]{3}\b/g)) {
      const did = this.idxPiloto.abrevs.get(normalizarTexto(m[0]));
      if (did) anadir(m.index, did);
    }

    const palabras = [...norm.matchAll(/\w+/g)].map((m) => [m[0], m.index]);

    for (const [alias, did] of this.idxPiloto.nombres) {
      if (alias.includes(" ") || ya.has(did)) continue;
      for (const [palabra, pos] of palabras) {
        if (palabra.length < 4) continue;
        if (ratio(alias, palabra) >= 86) { anadir(pos, did); break; }
      }
    }
    // Alias de varias palabras ("max verstappen"): ahí sí vale buscar en la frase
    for (const [alias, did] of this.idxPiloto.nombres) {
      if (!alias.includes(" ") || ya.has(did)) continue;
      if (partialRatio(alias, norm) >= 90) anadir(norm.indexOf(alias.slice(0, 4)), did);
    }

    return hallados
      .sort((a, b) => (a[0] < 0 ? 999 : a[0]) - (b[0] < 0 ? 999 : b[0]))
      .map(([, did]) => did)
      .slice(0, maximo);
  },

  /** Dos pasadas: exacta por palabra (imprescindible para "spa"), luego difusa. */
  _buscarEvento(norm) {
    let mejor = null;
    for (const [alias, destino] of this.idxEvento) {
      const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(norm) && (!mejor || alias.length > mejor[0].length)) {
        mejor = [alias, destino];
      }
    }
    if (mejor) return mejor[1];

    let mejorAlias = null, mejorPunt = 88;
    for (const [alias, destino] of this.idxEvento) {
      if (alias.length < 5) continue;
      const p = partialRatio(alias, norm);
      if (p >= mejorPunt) { mejorPunt = p; mejorAlias = destino; }
    }
    return mejorAlias;
  },

  _buscarGrid(norm) {
    if (/\bpole\b|\bprimero en la parrilla\b|\bdesde delante\b/.test(norm)) return 1;
    if (/\bultimo\b|\bcolista\b|\bdesde atras\b|\bpit\s?lane\b/.test(norm)) return 99;
    const patrones = [
      /\b(?:sale|saliendo|salida|desde|parrilla|grid)\D{0,12}(\d{1,2})\b/,
      /\bp(\d{1,2})\b/,
      /\b(\d{1,2})\D{0,6}(?:de|en la) parrilla\b/,
    ];
    for (const p of patrones) {
      const m = norm.match(p);
      if (m) { const v = +m[1]; if (v >= 1 && v <= 24) return v; }
    }
    return null;
  },

  interpretar(texto) {
    const norm = normalizarTexto(texto);
    const c = {
      texto, norm,
      intencion: this._intencion(norm),
      pilotos: this._buscarPilotos(norm, texto),
      evento: this._buscarEvento(norm),
      anio: (norm.match(/\b(19[5-9]\d|20[0-4]\d)\b/) || [])[1],
      grid: this._buscarGrid(norm),
    };
    c.anio = c.anio ? +c.anio : null;

    if (c.intencion === "desconocida") {
      if (c.pilotos.length >= 2) c.intencion = "comparar";
      else if (c.pilotos.length && (c.evento || c.grid)) c.intencion = "prediccion";
      else if (c.pilotos.length) c.intencion = "piloto";
      else if (c.evento) c.intencion = c.anio ? "carrera_pasada" : "circuito";
    }
    // Un año explícito sobre un GP mira al pasado, aunque suene a predicción
    if (c.intencion === "prediccion" && c.anio && c.evento) c.intencion = "carrera_pasada";

    // "¿y si sale desde la pole?" no nombra a nadie, pero al pedir una parrilla
    // concreta se refiere al piloto del que veníamos hablando. Sin parrilla
    // ("¿quién gana esa carrera?") sí se entiende que pregunta por todos.
    if (c.intencion === "prediccion" && !c.pilotos.length && c.grid && this.ultimoPiloto) {
      c.pilotos = [this.ultimoPiloto];
    }

    return c;
  },

  // ------------------------------------------------------------ utilidades
  _piloto(did) { return this.datos.pilotos.find((p) => p.driver_id === did); },

  _pct(v) { return v == null ? "—" : `${(v * 100).toFixed(1)}%`; },
  _pos(v) { return v == null ? "—" : `P${Number(v).toFixed(1)}`; },

  // ================================================================
  //  MANEJADORES
  // ================================================================
  _ayuda() {
    return {
      texto:
        `Puedo consultar el modelo y el histórico de ${this.datos.indice.total_carreras} ` +
        "carreras. Pregúntame en lenguaje normal: tolero erratas y entiendo los nombres " +
        "coloquiales de los circuitos (Monza, Spa, Montmeló…).",
      bloques: [{
        tipo: "lista", titulo: "Qué puedo responder",
        items: [
          "**Predicciones** — «¿cómo le irá a Verstappen en Monza?», «¿y si Norris sale P5?»",
          "**Comparaciones** — «compara a Leclerc y Hamilton»",
          "**Fichas de piloto** — «estadísticas de Alonso»",
          "**Carreras pasadas** — «¿qué pasó en Hungría 2026?»",
          "**Campeonato** — «¿cómo va la clasificación?»",
          "**Circuitos** — «¿a quién se le da bien Spa?»",
          "**El modelo** — «¿qué tan fiable es?», «¿qué variables importan?»",
        ],
      }],
      sugerencias: ["¿Quién gana la próxima carrera?", "Compara a Verstappen y Norris",
                    "¿Qué tan fiable es el modelo?"],
    };
  },

  _modelo() {
    const m = this.datos.metricas;
    return {
      texto:
        `El modelo se equivoca de media en **${m.mae_modelo.toFixed(2)} posiciones**. ` +
        `El baseline ingenuo de «cada piloto termina donde salió» se equivoca en ` +
        `${m.mae_baseline.toFixed(2)}, así que la mejora real es del ` +
        `**${m.mejora_pct >= 0 ? "+" : ""}${m.mejora_pct.toFixed(1)}%**.\n\n` +
        `Sobre las ${m.orden.carreras_evaluadas} carreras de prueba acierta el ganador el ` +
        `${m.orden.acierto_ganador_pct.toFixed(0)}% de las veces e identifica el ` +
        `${m.orden.acierto_podio_pct.toFixed(0)}% de los pilotos del podio.\n\n` +
        `Ojo con el clasificador de abandono: su AUC es ${(m.auc.abandono ?? 0).toFixed(2)}, ` +
        "apenas mejor que lanzar una moneda. Es honesto: los abandonos dependen de fallos " +
        "mecánicos y accidentes, que son esencialmente aleatorios.",
      bloques: [
        { tipo: "metricas", items: [
          { valor: m.mae_modelo.toFixed(2), etiqueta: "Error medio",
            nota: `baseline ${m.mae_baseline.toFixed(2)}` },
          { valor: `${m.mejora_pct >= 0 ? "+" : ""}${m.mejora_pct.toFixed(1)}%`,
            etiqueta: "Mejora", nota: "sobre el baseline" },
          { valor: `${m.orden.acierto_ganador_pct.toFixed(0)}%`,
            etiqueta: "Ganador acertado", nota: "en test" },
        ]},
        { tipo: "tabla", titulo: "Variables más influyentes",
          columnas: ["Variable", "Importancia"],
          filas: m.importancias.slice(0, 5).map((d) => [d.etiqueta ?? d.feature,
                                                        d.valor.toFixed(3)]) },
        { tipo: "tabla", titulo: "Rendimiento por temporada",
          columnas: ["Año", "Filas", "MAE modelo", "MAE baseline", "Mejora"],
          filas: (m.por_temporada ?? []).map((d) => [
            String(d.anio), String(d.n), d.mae_modelo.toFixed(2),
            d.mae_baseline.toFixed(2),
            `${d.mejora_pct >= 0 ? "+" : ""}${d.mejora_pct.toFixed(1)}%`]) },
      ],
      sugerencias: ["¿Quién gana la próxima carrera?", "¿Cómo va el campeonato?"],
    };
  },

  _fichaPiloto(c) {
    if (!c.pilotos.length) return this._noEntendido("No he identificado a ningún piloto.");
    const p = this._piloto(c.pilotos[0]);
    const t = p.trayectoria;
    const ult5 = t.slice(-5);
    const media5 = ult5.reduce((s, r) => s + r.pos, 0) / (ult5.length || 1);

    let texto =
      `**${p.nombre}** (${p.abrev}) — ${p.equipo}\n\n` +
      `En las ${p.carreras} carreras que tengo registradas promedia ` +
      `**${this._pos(p.media_pos)}** de llegada saliendo desde ${this._pos(p.media_grid)}, ` +
      `lo que supone ${p.ganancia >= 0 ? "+" : ""}${p.ganancia.toFixed(1)} posiciones ` +
      `ganadas por carrera. Suma ${p.victorias} victorias y ${p.podios} podios, con un ` +
      `${this._pct(p.tasa_dnf)} de abandonos.\n\n` +
      `En sus últimas 5 carreras promedia **${this._pos(media5)}**`;
    texto += p.temporada.carreras
      ? `, y esta temporada lleva ${(p.temporada.puntos ?? 0).toFixed(0)} puntos en ` +
        `${p.temporada.carreras} carreras.`
      : ".";

    return {
      texto,
      bloques: [
        { tipo: "metricas", items: [
          { valor: this._pos(p.media_pos), etiqueta: "Llegada media",
            nota: `salida ${this._pos(p.media_grid)}` },
          { valor: `${p.victorias} / ${p.podios}`, etiqueta: "Victorias / podios",
            nota: `${(p.puntos ?? 0).toFixed(0)} puntos` },
          { valor: this._pct(p.tasa_dnf), etiqueta: "Abandonos",
            nota: `${p.carreras} carreras` },
        ]},
        { tipo: "tabla", titulo: "Últimas 5 carreras",
          columnas: ["Carrera", "Sale", "Llega", "Puntos"],
          filas: ult5.slice().reverse().map((r) => [
            `${r.evento} ${r.anio}`, `P${r.grid.toFixed(0)}`,
            r.dnf ? "DNF" : `P${r.pos.toFixed(0)}`, r.puntos.toFixed(0)]) },
      ],
      sugerencias: [`¿Cómo le irá a ${p.nombre.split(" ").pop()} en la próxima?`,
                    "¿Cómo va el campeonato?"],
    };
  },

  _comparar(c) {
    if (c.pilotos.length < 2) {
      return this._noEntendido(
        "Necesito dos pilotos para comparar. Prueba con «compara a Norris y Piastri».");
    }
    const a = this._piloto(c.pilotos[0]), b = this._piloto(c.pilotos[1]);

    // Duelo directo: carreras en las que coincidieron
    const clave = (r) => `${r.anio}-${r.ronda}`;
    const mapaB = new Map(b.trayectoria.map((r) => [clave(r), r]));
    let ganaA = 0, ganaB = 0, juntas = 0;
    for (const ra of a.trayectoria) {
      const rb = mapaB.get(clave(ra));
      if (!rb) continue;
      juntas++;
      if (ra.pos < rb.pos) ganaA++; else if (rb.pos < ra.pos) ganaB++;
    }
    const mejor = a.media_pos <= b.media_pos ? a : b;
    const otro = mejor === a ? b : a;

    return {
      texto:
        `**${a.nombre}** (${a.equipo}) contra **${b.nombre}** (${b.equipo}).\n\n` +
        `En las ${juntas} carreras que han disputado juntos, **${a.abrev} ha terminado por ` +
        `delante ${ganaA} veces** y ${b.abrev} ${ganaB}.\n\n` +
        `Por media histórica de llegada gana ${mejor.nombre} ` +
        `(${this._pos(mejor.media_pos)} frente a ${this._pos(otro.media_pos)}).`,
      bloques: [{
        tipo: "tabla", titulo: "Cara a cara",
        columnas: ["Métrica", a.abrev, b.abrev],
        filas: [
          ["Carreras", String(a.carreras), String(b.carreras)],
          ["Llegada media", this._pos(a.media_pos), this._pos(b.media_pos)],
          ["Salida media", this._pos(a.media_grid), this._pos(b.media_grid)],
          ["Posiciones ganadas", `${a.ganancia >= 0 ? "+" : ""}${a.ganancia.toFixed(1)}`,
                                 `${b.ganancia >= 0 ? "+" : ""}${b.ganancia.toFixed(1)}`],
          ["Tasa de abandono", this._pct(a.tasa_dnf), this._pct(b.tasa_dnf)],
          ["Victorias", String(a.victorias), String(b.victorias)],
          ["Puntos totales", (a.puntos ?? 0).toFixed(0), (b.puntos ?? 0).toFixed(0)],
          ["Duelo directo", String(ganaA), String(ganaB)],
        ],
      }],
      sugerencias: [`Estadísticas de ${a.nombre.split(" ").pop()}`,
                    "¿Quién gana la próxima carrera?"],
    };
  },

  _campeonato() {
    const cl = this.datos.clasificacion;
    const lider = cl.pilotos[0], segundo = cl.pilotos[1];
    let texto = `Campeonato ${cl.temporada}, tras ${cl.carreras_disputadas} carreras.\n\n` +
                `Lidera **${lider.nombre}** con ${lider.puntos.toFixed(0)} puntos`;
    if (segundo) {
      texto += `, ${(lider.puntos - segundo.puntos).toFixed(0)} por delante de ` +
               `${segundo.nombre} (${segundo.puntos.toFixed(0)}).`;
    }
    texto += `\n\nEn constructores manda **${cl.equipos[0].TeamName}** con ` +
             `${cl.equipos[0].puntos.toFixed(0)}.`;

    return {
      texto,
      bloques: [
        { tipo: "tabla", titulo: `Pilotos ${cl.temporada}`,
          columnas: ["#", "Piloto", "Equipo", "Puntos", "V"],
          filas: cl.pilotos.slice(0, 10).map((p) => [
            String(p.pos), p.nombre, p.equipo, p.puntos.toFixed(0), String(p.victorias)]) },
        { tipo: "tabla", titulo: "Constructores",
          columnas: ["#", "Equipo", "Puntos"],
          filas: cl.equipos.slice(0, 10).map((e) => [
            String(e.pos), e.TeamName, e.puntos.toFixed(0)]) },
      ],
      sugerencias: ["¿Quién gana la próxima carrera?",
                    `Estadísticas de ${lider.nombre.split(" ").pop()}`],
    };
  },

  _carreraPasada(c) {
    let candidatas = this.datos.resultados;
    if (c.evento) candidatas = candidatas.filter((x) => x.evento === c.evento);
    if (c.anio) candidatas = candidatas.filter((x) => x.anio === c.anio);
    if (!candidatas.length) {
      return this._noEntendido("No encuentro esa carrera en los datos que tengo cargados.");
    }

    const r = candidatas[candidatas.length - 1];
    const ganador = r.resultados[0];
    const dnfs = r.resultados.filter((x) => x.dnf).length;
    const remontada = r.resultados.reduce(
      (mej, x) => ((x.grid - x.pos) > (mej.grid - mej.pos) ? x : mej), r.resultados[0]);

    return {
      texto:
        `**${r.evento} ${r.anio}** (${r.lugar}, ${r.fecha}).\n\n` +
        `Ganó **${ganador.nombre}** (${ganador.equipo}) saliendo desde ` +
        `P${ganador.grid.toFixed(0)}. Hubo ${dnfs} abandonos de ${r.resultados.length} ` +
        `coches.\n\nLa mejor remontada fue la de ${remontada.nombre}: de ` +
        `P${remontada.grid.toFixed(0)} a P${remontada.pos.toFixed(0)} ` +
        `(${(remontada.grid - remontada.pos) >= 0 ? "+" : ""}` +
        `${(remontada.grid - remontada.pos).toFixed(0)}).`,
      bloques: [{
        tipo: "tabla", titulo: "Resultado",
        columnas: ["Pos", "Piloto", "Equipo", "Sale", "Δ", "Pts"],
        filas: r.resultados.slice(0, 12).map((x) => [
          x.dnf ? "DNF" : x.pos.toFixed(0), x.nombre, x.equipo,
          `P${x.grid.toFixed(0)}`,
          `${(x.grid - x.pos) >= 0 ? "+" : ""}${(x.grid - x.pos).toFixed(0)}`,
          x.puntos.toFixed(0)]) },
      ],
      sugerencias: [`¿Cómo le irá a ${ganador.nombre.split(" ").pop()} en la próxima?`,
                    "¿Cómo va el campeonato?"],
    };
  },

  _circuito(c) {
    if (!c.evento) return this._noEntendido("¿De qué circuito quieres saber?");
    const ediciones = this.datos.resultados.filter((x) => x.evento === c.evento);
    if (!ediciones.length) return this._noEntendido("No tengo carreras de ese circuito.");

    const porPiloto = new Map();
    let cambioTotal = 0, filas = 0;
    for (const ed of ediciones) {
      for (const r of ed.resultados) {
        if (!porPiloto.has(r.driver_id)) {
          porPiloto.set(r.driver_id, { nombre: r.nombre, equipo: r.equipo, pos: [], mejor: 99 });
        }
        const p = porPiloto.get(r.driver_id);
        p.pos.push(r.pos);
        p.mejor = Math.min(p.mejor, r.pos);
        cambioTotal += Math.abs(r.grid - r.pos);
        filas++;
      }
    }

    const top = [...porPiloto.values()]
      .filter((p) => p.pos.length >= 2)
      .map((p) => ({ ...p, media: p.pos.reduce((a, b) => a + b, 0) / p.pos.length }))
      .sort((a, b) => a.media - b.media)
      .slice(0, 8);

    const cambio = cambioTotal / (filas || 1);
    const urbano = ediciones[0].urbano ? "urbano" : "permanente";

    return {
      texto:
        `**${c.evento}** (${ediciones[0].lugar}), circuito ${urbano}. Tengo ` +
        `${ediciones.length} ediciones registradas.\n\nDe media, cada piloto cambia ` +
        `${cambio.toFixed(1)} posiciones respecto a su parrilla: ` +
        (cambio < 3
          ? "es un trazado donde adelantar cuesta, así que la clasificación pesa mucho."
          : "hay bastante movimiento respecto a la parrilla de salida."),
      bloques: [{
        tipo: "tabla", titulo: `Quién rinde mejor en ${c.evento}`,
        columnas: ["Piloto", "Equipo", "Ediciones", "Media", "Mejor"],
        filas: top.map((p) => [p.nombre, p.equipo, String(p.pos.length),
                               this._pos(p.media), `P${p.mejor.toFixed(0)}`]),
      }],
      sugerencias: [`¿Quién ganará en ${c.evento}?`, "¿Cómo va el campeonato?"],
    };
  },

  async _prediccion(c) {
    // Elegir el GP. Si la pregunta no lo nombra, se mantiene el de la pregunta
    // anterior: al pulsar "¿y si sale desde la pole?" el usuario sigue hablando
    // del mismo circuito, no del siguiente del calendario.
    let ev = this.ultimoEvento ?? this.eventos[0];
    if (c.evento) {
      const coincide = this.eventos.find((e) => e.evento === c.evento);
      if (coincide) ev = coincide;
      else {
        return this._noEntendido(
          `No tengo predicción para el ${c.evento}: solo la calculo para las próximas ` +
          `carreras (${this.eventos.map((e) => e.evento).join(", ")}). ` +
          "Para las pasadas, pregúntame qué ocurrió.");
      }
    }

    this.ultimoEvento = ev;
    const doc = await cargarJSON(`events/${ev.slug}.json`);

    // Parrilla de referencia, moviendo al piloto si se pidió un escenario
    let orden = doc.grid_referencia.slice().sort((a, b) => a.grid - b.grid)
                   .map((e) => e.driver_id);
    if (c.pilotos.length && c.grid) {
      const did = c.pilotos[0];
      if (orden.includes(did)) {
        orden = orden.filter((d) => d !== did);
        orden.splice(Math.max(0, Math.min(c.grid - 1, orden.length)), 0, did);
      }
    }

    // Misma lógica que la pestaña Predicción: buscar cada piloto en su curva
    const info = (did) => doc.prediccion.find((p) => p.driver_id === did) ?? {};
    const filas = orden.map((did, i) => {
      const curva = doc.sensibilidad[did];
      const punto = curva ? curva[Math.min(i, curva.length - 1)] : {};
      return { ...info(did), grid: i + 1, ...punto };
    }).sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99));

    const tabla = {
      tipo: "tabla", titulo: `Orden previsto — ${doc.evento}`,
      columnas: ["Pos", "Piloto", "Equipo", "Sale", "Victoria", "Podio", "Puntos"],
      filas: filas.slice(0, 10).map((f, i) => [
        String(i + 1), f.nombre, f.equipo, `P${f.grid}`,
        this._pct(f.victoria), this._pct(f.podio), this._pct(f.puntos)]),
    };

    // --- Sobre un piloto concreto ---
    if (c.pilotos.length) {
      const did = c.pilotos[0];
      const idx = filas.findIndex((f) => f.driver_id === did);
      if (idx < 0) {
        const p = this._piloto(did);
        return this._noEntendido(
          `${p ? p.nombre : "Ese piloto"} no está en la parrilla actual, así que no puedo ` +
          "predecir su resultado.");
      }
      const f = filas[idx];
      const apellido = String(f.nombre).split(" ").pop();
      tabla.destacar = f.nombre;

      return {
        texto:
          `**${f.nombre}** en el **${doc.evento}**, ` +
          (c.grid ? `saliendo desde P${f.grid}` :
                    `si sale desde P${f.grid} (su parrilla estimada según su forma reciente)`) +
          `:\n\nEl modelo lo sitúa en **P${idx + 1}** (estimación bruta ` +
          `${(f.pos ?? 0).toFixed(1)}, error típico ±` +
          `${this.datos.metricas.mae_modelo.toFixed(1)} posiciones).\n\n` +
          `Sus probabilidades: **${this._pct(f.victoria)} de ganar**, ` +
          `${this._pct(f.podio)} de podio, ${this._pct(f.puntos)} de puntuar y ` +
          `${this._pct(f.abandono)} de abandonar.`,
        bloques: [
          { tipo: "probabilidades", titulo: `${f.abrev} — ${doc.evento}`, items: [
            { etiqueta: "Victoria", valor: f.victoria ?? 0, clase: "victoria" },
            { etiqueta: "Podio", valor: f.podio ?? 0, clase: "podio" },
            { etiqueta: "Puntos", valor: f.puntos ?? 0, clase: "puntos" },
            { etiqueta: "Abandono", valor: f.abandono ?? 0, clase: "abandono" },
          ]},
          tabla,
        ],
        sugerencias: [
          f.grid > 1 ? `¿Y si ${apellido} sale desde la pole?` : `¿Y si ${apellido} sale P10?`,
          f.grid < filas.length - 2 ? "¿Y si sale último?" : "¿Y si sale P5?",
          `¿Quién gana el ${doc.evento}?`,
        ],
      };
    }

    // --- Sobre la carrera entera ---
    const primero = filas[0];
    const favorito = filas.reduce((a, b) => ((b.victoria ?? 0) > (a.victoria ?? 0) ? b : a));

    let texto =
      `Predicción para el **${doc.evento}**` + (doc.fecha ? ` (${doc.fecha})` : "") + ":\n\n" +
      `El regresor coloca primero a **${primero.nombre}**, seguido de ${filas[1].nombre} y ` +
      `${filas[2].nombre}.\n\n`;

    // Regresor y clasificador son modelos distintos y pueden discrepar
    if (favorito.driver_id !== primero.driver_id) {
      texto +=
        `Pero el clasificador de victoria apunta a otro: da **${this._pct(favorito.victoria)} ` +
        `a ${favorito.nombre}**, frente al ${this._pct(primero.victoria)} de ${primero.abrev}. ` +
        "Son dos modelos distintos: uno estima la posición media y el otro la probabilidad de " +
        "ganar, que premia a quien gana mucho aunque a veces termine lejos.\n\n";
    } else {
      texto += `También es el favorito del clasificador, con ${this._pct(favorito.victoria)} ` +
               "de victoria.\n\n";
    }
    texto += "La parrilla de partida es una estimación basada en la posición de salida media " +
             "reciente de cada piloto, porque todavía no hay clasificación.";

    return {
      texto,
      bloques: [tabla],
      sugerencias: [`¿Y si ${filas[1].nombre.split(" ").pop()} sale desde la pole?`,
                    "¿Qué tan fiable es el modelo?"],
    };
  },

  _noEntendido(motivo) {
    return {
      texto: (motivo || "No he entendido la pregunta.") +
        "\n\nPuedo predecir carreras, comparar pilotos, consultar resultados históricos y " +
        "explicarte cómo funciona el modelo.",
      bloques: [],
      sugerencias: ["¿Qué puedes hacer?", "¿Quién gana la próxima carrera?",
                    "Compara a Verstappen y Norris"],
    };
  },

  // ================================================================
  async responder(pregunta) {
    const c = this.interpretar(pregunta);
    let r;
    try {
      switch (c.intencion) {
        case "ayuda":          r = this._ayuda(c); break;
        case "modelo":         r = this._modelo(c); break;
        case "piloto":         r = this._fichaPiloto(c); break;
        case "comparar":       r = this._comparar(c); break;
        case "campeonato":     r = this._campeonato(c); break;
        case "carrera_pasada": r = this._carreraPasada(c); break;
        case "circuito":       r = this._circuito(c); break;
        case "prediccion":     r = await this._prediccion(c); break;
        default:               r = this._noEntendido("");
      }
    } catch (e) {
      r = this._noEntendido(`Algo ha fallado procesando eso (${e.message}).`);
    }
    if (c.pilotos.length) this.ultimoPiloto = c.pilotos[0];

    r.bloques ??= [];
    r.sugerencias ??= [];
    r.intencion = c.intencion;
    return r;
  },
};

/* ------------------------------------------------------------------
   Intenciones. El orden importa: gana la primera que casa, así que
   las específicas van antes que las generales.
   ------------------------------------------------------------------ */
const INTENCIONES = [
  ["ayuda", [/\bque puedes hacer\b/, /\bayuda\b/, /\bcomo funciona[s]?\b/, /\bque sabes\b/,
             /\bopciones\b/, /\bejemplos?\b/]],
  ["modelo", [/\bmodelo\b/, /\bpreci[sc]i?on\b/, /\bfiable\b/, /\bfiabilidad\b/,
              /\bacierta[s]?\b/, /\berror\b/, /\bmae\b/, /\bauc\b/, /\bque tan bueno\b/,
              /\bentrena/, /\bvariables? mas\b/, /\bimportanci/, /\bmetodolog/]],
  ["comparar", [/\bcompara[r]?\b/, /\bversus\b/, /\bvs\b/, /\bmejor que\b/,
                /\bquien es mejor\b/, /\bfrente a\b/, /\bcontra\b/]],
  ["campeonato", [/\bcampeonato\b/, /\bclasificaci?on\b/, /\bmundial\b/, /\bconstructor/,
                  /\blider\b/, /\bpuntos? (?:total|actual)/,
                  /\bquien va (?:primero|ganando|lider)\b/, /\btabla\b/]],
  ["carrera_pasada", [/\bque paso\b/, /\bresultado de\b/, /\bquien gano\b/, /\bganador de\b/,
                      /\bcomo (?:fue|termino|acabo|quedo)\b/, /\bultima carrera\b/,
                      /\bpodio de\b/]],
  ["prediccion", [/\bpredi/, /\bpronostic/, /\bcomo le ira\b/, /\bque tal (?:le )?ira\b/,
                  /\bva a ganar\b/, /\bganara\b/, /\bquedara\b/, /\bterminara\b/,
                  // "quien gana" en presente mira al futuro; "quien gano" en pasado
                  // lo captura antes carrera_pasada, y el \b evita que se solapen.
                  /\bquien gana\b/, /\bquien ganaria\b/,
                  /\bprobabilidad/, /\bchances?\b/, /\bopciones de\b/, /\bsi sale\b/,
                  /\bsaliendo\b/, /\bdesde la p\d+\b/, /\bproxima carrera\b/, /\bproxima\b/,
                  /\bsiguiente (?:gran premio|carrera|gp)\b/]],
  ["circuito", [/\bcircuito\b/, /\btrazado\b/, /\ben (?:el )?gp\b/, /\bgran premio\b/,
                /\bhistorial en\b/, /\bse le da bien\b/]],
  ["piloto", [/\bestadisticas?\b/, /\bficha\b/, /\bcomo (?:va|esta|lleva)\b/,
              /\bhabla[me]? de\b/, /\bquien es\b/, /\btemporada de\b/, /\brendimiento de\b/,
              /\bforma de\b/]],
];

/* FastF1 nombra los GP en inglés, pero nadie pregunta así en español. */
const ALIAS_CIRCUITOS = {
  hungria: "Hungarian Grand Prix", budapest: "Hungarian Grand Prix",
  belgica: "Belgian Grand Prix", spa: "Belgian Grand Prix",
  francorchamps: "Belgian Grand Prix",
  italia: "Italian Grand Prix", monza: "Italian Grand Prix",
  imola: "Emilia Romagna Grand Prix", emilia: "Emilia Romagna Grand Prix",
  espana: "Spanish Grand Prix", montmelo: "Spanish Grand Prix",
  cataluna: "Spanish Grand Prix",
  holanda: "Dutch Grand Prix", "paises bajos": "Dutch Grand Prix",
  zandvoort: "Dutch Grand Prix",
  "gran bretana": "British Grand Prix", inglaterra: "British Grand Prix",
  silverstone: "British Grand Prix", "reino unido": "British Grand Prix",
  japon: "Japanese Grand Prix", suzuka: "Japanese Grand Prix",
  australia: "Australian Grand Prix", melbourne: "Australian Grand Prix",
  china: "Chinese Grand Prix", shanghai: "Chinese Grand Prix",
  canada: "Canadian Grand Prix", montreal: "Canadian Grand Prix",
  austria: "Austrian Grand Prix", spielberg: "Austrian Grand Prix",
  azerbaiyan: "Azerbaijan Grand Prix", baku: "Azerbaijan Grand Prix",
  singapur: "Singapore Grand Prix",
  "estados unidos": "United States Grand Prix", austin: "United States Grand Prix",
  mexico: "Mexico City Grand Prix",
  brasil: "São Paulo Grand Prix", interlagos: "São Paulo Grand Prix",
  "sao paulo": "São Paulo Grand Prix",
  catar: "Qatar Grand Prix", lusail: "Qatar Grand Prix",
  "abu dabi": "Abu Dhabi Grand Prix", "yas marina": "Abu Dhabi Grand Prix",
  arabia: "Saudi Arabian Grand Prix", yeda: "Saudi Arabian Grand Prix",
  bahrein: "Bahrain Grand Prix", sakhir: "Bahrain Grand Prix",
  monaco: "Monaco Grand Prix", montecarlo: "Monaco Grand Prix",
  "monte carlo": "Monaco Grand Prix",
  portugal: "Portuguese Grand Prix", portimao: "Portuguese Grand Prix",
  francia: "French Grand Prix", "paul ricard": "French Grand Prix",
  rusia: "Russian Grand Prix", sochi: "Russian Grand Prix",
  turquia: "Turkish Grand Prix", estambul: "Turkish Grand Prix",
  "las vegas": "Las Vegas Grand Prix", miami: "Miami Grand Prix",
};
