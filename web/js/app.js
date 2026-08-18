/* ============================================================
   F1 Predictor — logica de la interfaz
   La pagina es 100% estatica: todo sale de los JSON de web/data,
   generados por el pipeline de Python.
   ============================================================ */

const DATA = "data";

const estado = {
  indice: null,
  metricas: null,
  pilotos: null,
  resultados: null,
  clasificacion: null,
  evento: null,      // JSON del GP seleccionado
  parrilla: [],      // [driverId, ...] en orden de salida
  charts: {},
};

// Colores oficiales aproximados de cada escuderia.
const COLORES_EQUIPO = {
  "red bull": "#3671C6", "ferrari": "#E8002D", "mercedes": "#27F4D2",
  "mclaren": "#FF8000", "aston martin": "#229971", "alpine": "#FF87BC",
  "williams": "#64C4FF", "rb": "#6692FF", "racing bulls": "#6692FF",
  "alphatauri": "#5E8FAA", "sauber": "#52E252", "alfa romeo": "#C92D4B",
  "haas": "#B6BABD", "audi": "#00A19B", "cadillac": "#B8A164",
};

function colorEquipo(nombre) {
  const n = String(nombre || "").toLowerCase();
  for (const [clave, color] of Object.entries(COLORES_EQUIPO)) {
    if (n.includes(clave)) return color;
  }
  return "#9a99a8";
}

const pct = (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
const num = (v, d = 1) => (v == null || Number.isNaN(v) ? "—" : Number(v).toFixed(d));

async function cargarJSON(ruta) {
  const r = await fetch(`${DATA}/${ruta}`);
  if (!r.ok) throw new Error(`No se pudo cargar ${ruta} (${r.status})`);
  return r.json();
}

/* ============================ COMPONENTES ============================== */

function celdaPiloto(p, mostrarEquipo = true) {
  const color = colorEquipo(p.equipo);
  return `<div class="piloto-celda">
            <span class="equipo-chip" style="background:${color}"></span>
            <span class="abrev">${p.abrev ?? ""}</span>
            <span>${p.nombre ?? ""}</span>
            ${mostrarEquipo ? `<span class="equipo">${p.equipo ?? ""}</span>` : ""}
          </div>`;
}

function badgePos(pos) {
  const p = Number(pos);
  let clase = "";
  if (p === 1) clase = "p1";
  else if (p === 2) clase = "p2";
  else if (p === 3) clase = "p3";
  else if (p <= 10) clase = "puntos";
  return `<span class="pos-badge ${clase}">${p}</span>`;
}

function barra(valor, tipo) {
  const v = valor == null ? 0 : valor;
  const ancho = Math.max(0, Math.min(100, v * 100));
  return `<div class="barra ${tipo}">
            <i style="width:${ancho}%"></i>
            <span>${pct(valor)}</span>
          </div>`;
}

function tarjetaMetrica(valor, etiqueta, nota = "") {
  return `<div class="metrica">
            <div class="valor">${valor}</div>
            <div class="etiqueta">${etiqueta}</div>
            ${nota ? `<div class="nota">${nota}</div>` : ""}
          </div>`;
}

function destruirChart(clave) {
  if (estado.charts[clave]) {
    estado.charts[clave].destroy();
    delete estado.charts[clave];
  }
}

// Ajustes comunes para que todos los graficos se lean bien sobre fondo oscuro.
const EJE = {
  grid: { color: "rgba(255,255,255,.07)" },
  ticks: { color: "#9a99a8", font: { size: 11 } },
};
const LEYENDA = { labels: { color: "#f4f2f0", boxWidth: 12, font: { size: 11 } } };

/* ============================== PREDICCION ============================= */

async function seleccionarEvento(slug) {
  const cont = document.querySelector("#tabla-prediccion tbody");
  cont.innerHTML = `<tr><td colspan="8" class="cargando">Cargando predicción…</td></tr>`;

  estado.evento = await cargarJSON(`events/${slug}.json`);
  estado.parrilla = estado.evento.grid_referencia
    .slice()
    .sort((a, b) => a.grid - b.grid)
    .map((e) => e.driver_id);

  const aviso = document.getElementById("aviso-evento");
  const ev = estado.evento;
  if (ev.futuro === false) {
    aviso.hidden = false;
    aviso.textContent =
      "Esta carrera ya se disputó: la predicción se muestra como re-simulación, " +
      "útil para comparar con el resultado real en la pestaña Carreras.";
  } else {
    aviso.hidden = false;
    aviso.textContent =
      "Todavía no hay clasificación para este Gran Premio. La parrilla de partida " +
      "es una estimación basada en la posición de salida media reciente de cada piloto: " +
      "reordénala cuando se dispute la qualy.";
  }

  llenarSelectorCurva();
  renderParrilla();
  recomputar();
}

function infoPiloto(driverId) {
  return (
    estado.evento.prediccion.find((p) => p.driver_id === driverId) || {
      driver_id: driverId, abrev: driverId, nombre: driverId, equipo: "",
    }
  );
}

/** Busca en la curva de sensibilidad la estimacion de un piloto para un grid dado. */
function estimacion(driverId, grid) {
  const curva = estado.evento.sensibilidad[driverId];
  if (!curva) return null;
  return curva[Math.min(Math.max(grid, 1), curva.length) - 1];
}

function renderParrilla() {
  const ol = document.getElementById("parrilla");
  ol.innerHTML = estado.parrilla
    .map((did, i) => {
      const p = infoPiloto(did);
      return `<li draggable="true" data-id="${did}">
        <span class="puesto">${i + 1}</span>
        <span class="equipo-chip" style="background:${colorEquipo(p.equipo)}"></span>
        <span class="nombre"><b>${p.abrev}</b> ${p.nombre}<small>${p.equipo}</small></span>
        <button class="mover" data-dir="-1" title="Subir">▲</button>
        <button class="mover" data-dir="1" title="Bajar">▼</button>
      </li>`;
    })
    .join("");
}

/** Recalcula el resultado previsto a partir de la parrilla actual. */
function recomputar() {
  const filas = estado.parrilla.map((did, i) => {
    const grid = i + 1;
    const est = estimacion(did, grid) || {};
    return { ...infoPiloto(did), grid, ...est };
  });

  // El regresor da un numero continuo; el orden de llegada sale de ordenarlo.
  filas.sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99));

  const tbody = document.querySelector("#tabla-prediccion tbody");
  tbody.innerHTML = filas
    .map((f, i) => {
      const delta = f.grid - (i + 1);
      const signo = delta > 0 ? "+" : "";
      const color = delta > 0 ? "var(--verde)" : delta < 0 ? "var(--rojo-suave)" : "var(--texto-tenue)";
      return `<tr>
        <td class="num">${badgePos(i + 1)}</td>
        <td>${celdaPiloto(f)}</td>
        <td class="num">${f.grid}</td>
        <td class="num" style="color:${color};font-weight:700">${delta === 0 ? "—" : signo + delta}</td>
        <td>${barra(f.victoria, "victoria")}</td>
        <td>${barra(f.podio, "podio")}</td>
        <td>${barra(f.puntos, "puntos")}</td>
        <td>${barra(f.abandono, "abandono")}</td>
      </tr>`;
    })
    .join("");

  dibujarSensibilidad();
}

function llenarSelectorCurva() {
  const sel = document.getElementById("sel-piloto-curva");
  sel.innerHTML = estado.evento.prediccion
    .map((p) => `<option value="${p.driver_id}">${p.abrev} — ${p.nombre}</option>`)
    .join("");
}

function dibujarSensibilidad() {
  const did = document.getElementById("sel-piloto-curva").value;
  const curva = estado.evento?.sensibilidad?.[did];
  if (!curva) return;

  const p = infoPiloto(did);
  const color = colorEquipo(p.equipo);
  const gridActual = estado.parrilla.indexOf(did) + 1;

  destruirChart("sensibilidad");
  estado.charts.sensibilidad = new Chart(
    document.getElementById("chart-sensibilidad"),
    {
      type: "line",
      data: {
        labels: curva.map((c) => c.grid),
        datasets: [
          {
            label: "Posición final estimada",
            data: curva.map((c) => c.pos),
            borderColor: color,
            backgroundColor: color + "33",
            tension: 0.25,
            pointRadius: 3,
            fill: true,
          },
          {
            label: "Salida = llegada",
            data: curva.map((c) => c.grid),
            borderColor: "#5a5a68",
            borderDash: [6, 4],
            pointRadius: 0,
            tension: 0,
          },
          {
            label: "Parrilla actual",
            data: curva.map((c) =>
              c.grid === gridActual ? curva[gridActual - 1].pos : null
            ),
            borderColor: "#fff",
            backgroundColor: "#fff",
            pointRadius: 7,
            pointStyle: "rectRot",
            showLine: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: LEYENDA,
          tooltip: {
            callbacks: {
              title: (t) => `Sale desde P${t[0].label}`,
              label: (c) => `${c.dataset.label}: P${num(c.parsed.y)}`,
            },
          },
        },
        scales: {
          x: { ...EJE, title: { text: "Posición de salida", display: true, color: "#9a99a8" } },
          y: {
            ...EJE,
            reverse: true,
            min: 1,
            title: { text: "Posición final", display: true, color: "#9a99a8" },
          },
        },
      },
    }
  );
}

/* ------------------------- arrastrar y soltar -------------------------- */
function activarParrillaInteractiva() {
  const ol = document.getElementById("parrilla");
  let origen = null;

  ol.addEventListener("dragstart", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    origen = li.dataset.id;
    li.classList.add("arrastrando");
    e.dataTransfer.effectAllowed = "move";
  });

  ol.addEventListener("dragend", (e) => {
    e.target.closest("li")?.classList.remove("arrastrando");
    ol.querySelectorAll("li").forEach((l) => l.classList.remove("destino"));
  });

  ol.addEventListener("dragover", (e) => {
    e.preventDefault();
    const li = e.target.closest("li");
    if (!li) return;
    ol.querySelectorAll("li").forEach((l) => l.classList.remove("destino"));
    li.classList.add("destino");
  });

  ol.addEventListener("drop", (e) => {
    e.preventDefault();
    const li = e.target.closest("li");
    if (!li || !origen) return;
    mover(origen, estado.parrilla.indexOf(li.dataset.id));
    origen = null;
  });

  // Botones de subir/bajar: alternativa accesible al arrastre.
  ol.addEventListener("click", (e) => {
    const btn = e.target.closest("button.mover");
    if (!btn) return;
    const did = btn.closest("li").dataset.id;
    const i = estado.parrilla.indexOf(did);
    mover(did, i + Number(btn.dataset.dir));
  });
}

function mover(driverId, destino) {
  const desde = estado.parrilla.indexOf(driverId);
  if (desde < 0 || destino < 0 || destino >= estado.parrilla.length || desde === destino) return;
  estado.parrilla.splice(desde, 1);
  estado.parrilla.splice(destino, 0, driverId);
  renderParrilla();
  recomputar();
}

/* ================================ PILOTOS ============================== */

function llenarSelectorPilotos(filtro = "") {
  const sel = document.getElementById("sel-piloto");
  const f = filtro.trim().toLowerCase();
  const lista = estado.pilotos.filter(
    (p) =>
      !f ||
      p.nombre.toLowerCase().includes(f) ||
      String(p.abrev).toLowerCase().includes(f) ||
      String(p.equipo).toLowerCase().includes(f)
  );

  const previo = sel.value;
  sel.innerHTML = lista
    .map(
      (p) =>
        `<option value="${p.driver_id}">${p.abrev} — ${p.nombre}${p.activo ? "" : " (inactivo)"}</option>`
    )
    .join("");

  if (lista.some((p) => p.driver_id === previo)) sel.value = previo;
  if (sel.value) renderPiloto(sel.value);
}

function renderPiloto(driverId) {
  const p = estado.pilotos.find((d) => d.driver_id === driverId);
  if (!p) return;

  document.getElementById("fichas-piloto").innerHTML = [
    tarjetaMetrica(p.nombre, p.equipo, `#${p.numero ?? "—"} · ${p.carreras} carreras`),
    tarjetaMetrica(`P${num(p.media_pos)}`, "Llegada media", `Salida media P${num(p.media_grid)}`),
    tarjetaMetrica(`${p.victorias} / ${p.podios}`, "Victorias / podios", `${num(p.puntos, 0)} puntos en total`),
    tarjetaMetrica(pct(p.tasa_dnf), "Tasa de abandono",
      `${p.ganancia >= 0 ? "+" : ""}${num(p.ganancia)} posiciones ganadas de media`),
  ].join("");

  const t = p.trayectoria;
  const color = colorEquipo(p.equipo);
  const etiquetas = t.map((r) => `${r.anio} R${r.ronda}`);

  destruirChart("trayectoria");
  estado.charts.trayectoria = new Chart(document.getElementById("chart-trayectoria"), {
    type: "line",
    data: {
      labels: etiquetas,
      datasets: [
        {
          label: "Llegada",
          data: t.map((r) => r.pos),
          borderColor: color,
          backgroundColor: color + "22",
          tension: 0.2,
          pointRadius: 2,
        },
        {
          label: "Salida",
          data: t.map((r) => r.grid),
          borderColor: "#6b6b7a",
          borderDash: [5, 4],
          pointRadius: 0,
          tension: 0.2,
        },
        {
          label: "Abandono",
          data: t.map((r) => (r.dnf ? r.pos : null)),
          borderColor: "#e10600",
          backgroundColor: "#e10600",
          pointRadius: 7,
          pointStyle: "crossRot",
          borderWidth: 2,
          showLine: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: LEYENDA,
        tooltip: {
          callbacks: {
            title: (c) => t[c[0].dataIndex].evento,
            label: (c) => `${c.dataset.label}: P${num(c.parsed.y, 0)}`,
          },
        },
      },
      scales: {
        x: { ...EJE, ticks: { ...EJE.ticks, maxTicksLimit: 14, maxRotation: 45 } },
        y: { ...EJE, reverse: true, min: 1, title: { text: "Posición", display: true, color: "#9a99a8" } },
      },
    },
  });
}

/* ================================ CARRERAS ============================= */

function llenarSelectorAnios() {
  const anios = [...new Set(estado.resultados.map((c) => c.anio))].sort((a, b) => b - a);
  document.getElementById("sel-anio").innerHTML = anios
    .map((a) => `<option value="${a}">${a}</option>`)
    .join("");
  llenarSelectorCarreras();
}

function llenarSelectorCarreras() {
  const anio = Number(document.getElementById("sel-anio").value);
  const carreras = estado.resultados.filter((c) => c.anio === anio);
  document.getElementById("sel-carrera").innerHTML = carreras
    .map((c) => `<option value="${c.slug}">R${c.ronda} — ${c.evento}</option>`)
    .join("");
  if (carreras.length) renderCarrera(carreras[carreras.length - 1].slug);
}

function renderCarrera(slug) {
  const c = estado.resultados.find((x) => x.slug === slug);
  if (!c) return;
  document.getElementById("sel-carrera").value = slug;

  const ganador = c.resultados[0];
  const dnfs = c.resultados.filter((r) => r.dnf).length;
  const mayorSubida = c.resultados.reduce(
    (mejor, r) => ((r.grid - r.pos) > (mejor.grid - mejor.pos) ? r : mejor),
    c.resultados[0]
  );

  document.getElementById("titulo-carrera").textContent = `${c.evento} ${c.anio}`;
  document.getElementById("resumen-carrera").innerHTML = [
    tarjetaMetrica(ganador.abrev, "Ganador", `${ganador.equipo} · salió P${num(ganador.grid, 0)}`),
    tarjetaMetrica(c.lugar, "Circuito", `${c.fecha} · ${c.urbano ? "urbano" : "permanente"}`),
    tarjetaMetrica(dnfs, "Abandonos", `de ${c.resultados.length} coches`),
    tarjetaMetrica(
      `+${num(mayorSubida.grid - mayorSubida.pos, 0)}`,
      "Mayor remontada",
      `${mayorSubida.abrev}: P${num(mayorSubida.grid, 0)} → P${num(mayorSubida.pos, 0)}`
    ),
  ].join("");

  document.querySelector("#tabla-carrera tbody").innerHTML = c.resultados
    .map((r) => {
      const delta = r.grid - r.pos;
      const signo = delta > 0 ? "+" : "";
      const color = delta > 0 ? "var(--verde)" : delta < 0 ? "var(--rojo-suave)" : "var(--texto-tenue)";
      return `<tr>
        <td class="num">${r.dnf ? '<span class="pos-badge">—</span>' : badgePos(r.pos)}</td>
        <td>${celdaPiloto(r, false)}</td>
        <td class="texto-tenue">${r.equipo}</td>
        <td class="num">${num(r.grid, 0)}</td>
        <td class="num" style="color:${color};font-weight:700">${delta === 0 ? "—" : signo + num(delta, 0)}</td>
        <td class="num">${num(r.puntos, 0)}</td>
        <td class="texto-tenue">${r.estado}</td>
      </tr>`;
    })
    .join("");
}

/* ============================= CLASIFICACION =========================== */

function renderClasificacion() {
  const c = estado.clasificacion;
  document.getElementById("titulo-pilotos-camp").textContent =
    `Pilotos — ${c.temporada} (${c.carreras_disputadas} carreras)`;

  document.querySelector("#tabla-camp-pilotos tbody").innerHTML = c.pilotos
    .map(
      (p) => `<tr>
        <td class="num">${badgePos(p.pos)}</td>
        <td>${celdaPiloto({ abrev: p.abrev, nombre: p.nombre, equipo: p.equipo })}</td>
        <td class="texto-tenue">${p.equipo}</td>
        <td class="num"><b>${num(p.puntos, 0)}</b></td>
        <td class="num">${p.victorias}</td>
        <td class="num">${p.podios}</td>
      </tr>`
    )
    .join("");

  document.querySelector("#tabla-camp-equipos tbody").innerHTML = c.equipos
    .map(
      (e) => `<tr>
        <td class="num">${badgePos(e.pos)}</td>
        <td><span class="equipo-chip" style="background:${colorEquipo(e.TeamName)}"></span>${e.TeamName}</td>
        <td class="num"><b>${num(e.puntos, 0)}</b></td>
        <td class="num">${e.victorias}</td>
        <td class="num">${e.podios}</td>
      </tr>`
    )
    .join("");
}

/* ================================ MODELO =============================== */

function renderModelo() {
  const m = estado.metricas;

  document.getElementById("metricas-modelo").innerHTML = [
    tarjetaMetrica(`${num(m.mae_modelo, 2)}`, "Error medio (posiciones)",
      `Baseline "termina donde sale": ${num(m.mae_baseline, 2)}`),
    tarjetaMetrica(`${m.mejora_pct >= 0 ? "+" : ""}${num(m.mejora_pct, 1)}%`,
      "Mejora sobre el baseline", "Cuanto más alto, más aporta el modelo"),
    tarjetaMetrica(`${num(m.orden.acierto_ganador_pct, 0)}%`, "Ganador acertado",
      `En ${m.orden.carreras_evaluadas} carreras de prueba`),
    tarjetaMetrica(`${num(m.orden.acierto_podio_pct, 0)}%`, "Podio acertado",
      "Pilotos del podio identificados"),
    tarjetaMetrica(`${m.n_train} / ${m.n_test}`, "Filas entrenamiento / prueba",
      `Corte: temporada ${m.corte.year}, ronda ${m.corte.round}`),
  ].join("");

  document.querySelector("#tabla-temporadas tbody").innerHTML = (m.por_temporada ?? [])
    .map((d) => {
      const color = d.mejora_pct >= 10 ? "var(--verde)"
                  : d.mejora_pct >= 0 ? "var(--ambar)" : "var(--rojo-suave)";
      return `<tr>
        <td><b>${d.anio}</b></td>
        <td class="num">${d.n}</td>
        <td class="num">${num(d.mae_modelo, 2)}</td>
        <td class="num texto-tenue">${num(d.mae_baseline, 2)}</td>
        <td class="num" style="color:${color};font-weight:700">${d.mejora_pct >= 0 ? "+" : ""}${num(d.mejora_pct, 1)}%</td>
      </tr>`;
    })
    .join("");

  const imp = m.importancias.slice(0, 12).reverse();
  destruirChart("importancias");
  estado.charts.importancias = new Chart(document.getElementById("chart-importancias"), {
    type: "bar",
    data: {
      labels: imp.map((d) => d.etiqueta),
      datasets: [{
        label: "Aumento del error al desordenar la variable",
        data: imp.map((d) => d.valor),
        backgroundColor: "#e10600cc",
        borderColor: "#e10600",
        borderWidth: 1,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ...EJE },
        y: { ...EJE, ticks: { ...EJE.ticks, font: { size: 10 } } },
      },
    },
  });

  const claves = Object.keys(m.auc);
  destruirChart("auc");
  estado.charts.auc = new Chart(document.getElementById("chart-auc"), {
    type: "bar",
    data: {
      labels: claves.map((k) => m.etiquetas_objetivo[k] ?? k),
      datasets: [{
        label: "AUC",
        data: claves.map((k) => m.auc[k]),
        backgroundColor: ["#e10600cc", "#2ecc71cc", "#38bdf8cc", "#f5a623cc"],
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `AUC ${num(c.parsed.y, 3)}`,
            afterLabel: (c) => {
              const v = c.parsed.y;
              if (v >= 0.9) return "Discriminación excelente";
              if (v >= 0.8) return "Buena";
              if (v >= 0.7) return "Aceptable";
              if (v >= 0.6) return "Débil";
              return "Apenas mejor que el azar";
            },
          },
        },
      },
      scales: {
        x: { ...EJE },
        y: { ...EJE, min: 0.5, max: 1, title: { text: "AUC", display: true, color: "#9a99a8" } },
      },
    },
  });
}

/* ================================= INIT ================================ */

function activarTabs() {
  document.getElementById("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-panel]");
    if (!btn) return;
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.remove("activa"));
    document.querySelectorAll("section.panel").forEach((s) => s.classList.remove("activo"));
    btn.classList.add("activa");
    document.getElementById(`panel-${btn.dataset.panel}`).classList.add("activo");
    // Chart.js necesita un empujon al mostrarse un canvas que estaba oculto.
    Object.values(estado.charts).forEach((c) => c.resize());
  });
}

async function init() {
  activarTabs();
  activarParrillaInteractiva();

  try {
    const [indice, metricas, pilotos, resultados, clasificacion] = await Promise.all([
      cargarJSON("index.json"),
      cargarJSON("metricas.json"),
      cargarJSON("pilotos.json"),
      cargarJSON("resultados.json"),
      cargarJSON("clasificacion.json"),
    ]);
    Object.assign(estado, { indice, metricas, pilotos, resultados, clasificacion });
  } catch (err) {
    document.querySelector("main").innerHTML =
      `<div class="tarjeta"><h2>No se pudieron cargar los datos</h2>
       <p class="texto-tenue">${err.message}</p>
       <p class="texto-tenue">Genera los JSON con <code>python pipeline/run.py</code> y
       sirve la carpeta con <code>python -m http.server 8000 --directory web</code>
       (abrir el HTML con doble clic no funciona: el navegador bloquea fetch en file://).</p>
       </div>`;
    return;
  }

  const i = estado.indice;
  document.getElementById("sub-cabecera").textContent =
    `${i.total_carreras} carreras · temporadas ${i.temporadas[0]}–${i.temporadas.at(-1)} · ` +
    `error medio ${num(i.resumen_modelo.mae_modelo, 2)} posiciones`;
  document.getElementById("pie-generado").textContent = `Datos generados el ${i.generado}`;

  // --- Prediccion ---
  const selEv = document.getElementById("sel-evento");
  selEv.innerHTML = i.eventos
    .map((e) => `<option value="${e.slug}">${e.evento}${e.fecha ? ` — ${e.fecha}` : ""}</option>`)
    .join("");
  selEv.addEventListener("change", () => seleccionarEvento(selEv.value));
  document.getElementById("sel-piloto-curva").addEventListener("change", dibujarSensibilidad);

  document.getElementById("btn-reset").addEventListener("click", () => {
    estado.parrilla = estado.evento.grid_referencia
      .slice().sort((a, b) => a.grid - b.grid).map((e) => e.driver_id);
    renderParrilla();
    recomputar();
  });

  document.getElementById("btn-invertir").addEventListener("click", () => {
    estado.parrilla.reverse();
    renderParrilla();
    recomputar();
  });

  if (i.eventos.length) await seleccionarEvento(i.eventos[0].slug);

  // --- Pilotos ---
  document.getElementById("sel-piloto").addEventListener("change", (e) => renderPiloto(e.target.value));
  document.getElementById("buscar-piloto").addEventListener("input", (e) =>
    llenarSelectorPilotos(e.target.value)
  );
  llenarSelectorPilotos();

  // --- Carreras ---
  document.getElementById("sel-anio").addEventListener("change", llenarSelectorCarreras);
  document.getElementById("sel-carrera").addEventListener("change", (e) => renderCarrera(e.target.value));
  llenarSelectorAnios();

  // --- Campeonato y modelo ---
  renderClasificacion();
  renderModelo();
}

document.addEventListener("DOMContentLoaded", init);

/* ================================ CHAT ================================= */
/* El asistente vive en el backend Flask (server/app.py). Si no está
   levantado, la pestaña lo explica en vez de fallar en silencio: la web
   estática publicada sigue siendo válida sin él. */

const chat = { disponible: false, ocupado: false, historial: [] };

function escapar(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Markdown mínimo: **negrita** y saltos de párrafo. Escapa el HTML antes. */
function textoRico(s) {
  return escapar(s)
    .split(/\n\n+/)
    .map((p) => `<p>${p.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function bloqueHTML(b) {
  if (b.tipo === "tabla") {
    const filas = b.filas
      .map((f) => {
        const destacada = b.destacar && f.some((c) => String(c).includes(b.destacar));
        return `<tr class="${destacada ? "destacada" : ""}">${
          f.map((c) => `<td>${escapar(c)}</td>`).join("")}</tr>`;
      })
      .join("");
    return `${b.titulo ? `<h4>${escapar(b.titulo)}</h4>` : ""}
      <div class="tabla-wrap"><table>
        <thead><tr>${b.columnas.map((c) => `<th>${escapar(c)}</th>`).join("")}</tr></thead>
        <tbody>${filas}</tbody>
      </table></div>`;
  }

  if (b.tipo === "probabilidades") {
    return `${b.titulo ? `<h4>${escapar(b.titulo)}</h4>` : ""}
      <div class="chat-probs">${b.items
        .map((i) => `<div class="linea">
             <span class="et">${escapar(i.etiqueta)}</span>
             ${barra(i.valor, i.clase)}
           </div>`)
        .join("")}</div>`;
  }

  if (b.tipo === "metricas") {
    return `<div class="chat-metricas">${b.items
      .map((i) => `<div class="m">
           <div class="v">${escapar(i.valor)}</div>
           <div class="e">${escapar(i.etiqueta)}</div>
           ${i.nota ? `<div class="n">${escapar(i.nota)}</div>` : ""}
         </div>`)
      .join("")}</div>`;
  }

  if (b.tipo === "lista") {
    return `${b.titulo ? `<h4>${escapar(b.titulo)}</h4>` : ""}
      <ul>${b.items
        .map((i) => `<li>${escapar(i).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")}</li>`)
        .join("")}</ul>`;
  }

  return "";
}

function pintarMensaje(quien, texto, bloques = []) {
  const cont = document.getElementById("chat-mensajes");
  const div = document.createElement("div");
  div.className = `msg ${quien}`;
  div.innerHTML = `<div class="burbuja">${
    quien === "usuario" ? escapar(texto) : textoRico(texto) + bloques.map(bloqueHTML).join("")
  }</div>`;
  cont.appendChild(div);
  cont.scrollTop = cont.scrollHeight;
  return div;
}

function pintarSugerencias(items) {
  const cont = document.getElementById("chat-sugerencias");
  cont.innerHTML = (items || [])
    .map((s) => `<button class="chip">${escapar(s)}</button>`)
    .join("");
}

async function preguntar(texto) {
  if (chat.ocupado || !texto.trim()) return;
  chat.ocupado = true;
  document.getElementById("chat-enviar").disabled = true;

  pintarMensaje("usuario", texto);
  pintarSugerencias([]);

  const esperando = pintarMensaje("bot", "");
  esperando.querySelector(".burbuja").innerHTML =
    '<div class="escribiendo"><span></span><span></span><span></span></div>';

  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pregunta: texto }),
    });
    const datos = await r.json();
    esperando.remove();

    if (!r.ok) {
      pintarMensaje("bot", datos.error || "El servidor ha devuelto un error.");
    } else {
      pintarMensaje("bot", datos.texto, datos.bloques);
      pintarSugerencias(datos.sugerencias);
    }
  } catch (e) {
    esperando.remove();
    pintarMensaje("bot",
      "No he podido contactar con el asistente. ¿Sigue levantado `python server/app.py`?");
  } finally {
    chat.ocupado = false;
    document.getElementById("chat-enviar").disabled = false;
    document.getElementById("chat-input").focus();
  }
}

async function iniciarChat() {
  const aviso = document.getElementById("asistente-offline");
  const form = document.getElementById("chat-form");

  try {
    const r = await fetch("/api/estado");
    if (!r.ok) throw new Error("no listo");
    const s = await r.json();

    chat.disponible = true;
    aviso.hidden = true;
    document.getElementById("chat-estado").textContent =
      `${s.carreras} carreras · error medio ${s.mae} posiciones`;

    pintarMensaje("bot",
      "Hola. Puedo predecir carreras, comparar pilotos, consultar el histórico y " +
      "explicarte cómo funciona el modelo.\n\n" +
      "Escribe con normalidad: entiendo erratas y nombres coloquiales de circuitos " +
      "(Monza, Spa, Montmeló…).");
    pintarSugerencias([
      "¿Quién gana la próxima carrera?",
      "Compara a Verstappen y Norris",
      "¿Qué tan fiable es el modelo?",
      "¿Qué pasó en Hungría 2026?",
    ]);
  } catch (e) {
    // Modo estático: el backend no está. Se explica, no se rompe.
    chat.disponible = false;
    aviso.hidden = false;
    aviso.innerHTML =
      "<b>El asistente necesita el servidor local.</b><br>" +
      "Esta página está funcionando en modo estático, así que el chat no está activo. " +
      "Para usarlo, ejecuta <code>python server/app.py</code> y abre " +
      "<code>http://localhost:5000</code>. El resto de pestañas funcionan sin él.";
    form.querySelector("input").disabled = true;
    form.querySelector("button").disabled = true;
    document.getElementById("chat-estado").textContent = "sin conexión";
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const t = input.value;
    input.value = "";
    preguntar(t);
  });

  document.getElementById("chat-sugerencias").addEventListener("click", (e) => {
    const chip = e.target.closest("button.chip");
    if (chip) preguntar(chip.textContent);
  });
}

document.addEventListener("DOMContentLoaded", iniciarChat);
