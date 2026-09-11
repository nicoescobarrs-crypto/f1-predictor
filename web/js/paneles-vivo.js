/* ============================================================
   F1 Predictor — paneles alimentados en vivo

   - Cinta de la cabecera: clasificacion que se desliza
   - Campeonato: tablas y plantilla con los datos de la API en vivo
   - Mercado: la seccion grande de Polymarket + casas de apuestas

   Todo se pinta primero con los JSON del pipeline (que siempre estan)
   y se sustituye en cuanto responde la API en vivo. Asi la pagina
   nunca aparece vacia esperando a una red lenta.
   ============================================================ */

(function () {

const PV = { anterior: {}, graficoHist: null, rango: "1m" };

const escP = (s) => (typeof escapar === "function" ? escapar(s) : String(s ?? ""));

/** Normaliza nombres de fuentes distintas: "Kimi Antonelli" = "Andrea Kimi Antonelli". */
function claveNombre(n) {
  return String(n ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z ]/g, "").trim().split(/\s+/).at(-1);
}

/** Anima un numero de su valor anterior al nuevo. */
function contar(el, hasta, { dec = 0, prefijo = "", sufijo = "", ms = 900 } = {}) {
  if (!el) return;
  const desde = Number(el.dataset.v ?? 0);
  el.dataset.v = hasta;
  // Con la pestana oculta requestAnimationFrame no corre y el numero se
  // quedaria a medias: se escribe el valor final directamente.
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || desde === hasta || document.hidden) {
    el.textContent = prefijo + hasta.toLocaleString("es", { maximumFractionDigits: dec, minimumFractionDigits: dec }) + sufijo;
    return;
  }
  const t0 = performance.now();
  const paso = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    const v = desde + (hasta - desde) * e;
    el.textContent = prefijo + v.toLocaleString("es", { maximumFractionDigits: dec, minimumFractionDigits: dec }) + sufijo;
    if (k < 1) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

function sello(id, fecha, fuente) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.en = fecha?.getTime() ?? "";
  el.innerHTML = `<span class="pulso-vivo">EN VIVO</span> <span class="hace">${Vivo.hace(fecha)}</span>
                  ${fuente ? `<span class="texto-tenue">· ${fuente}</span>` : ""}`;
}

// Los sellos "hace X s" se actualizan solos.
setInterval(() => {
  document.querySelectorAll("[data-en]").forEach((el) => {
    const h = el.querySelector(".hace");
    if (h && el.dataset.en) h.textContent = Vivo.hace(new Date(Number(el.dataset.en)));
  });
}, 5000);

/* =============================== CINTA =============================== */

function pintarCinta(c) {
  const el = document.getElementById("cinta");
  if (!el) return;
  const items = c.pilotos.slice(0, 12).map((p) => `
    <span class="cinta-item">
      <i style="background:${colorEquipo(p.equipo)}"></i>
      <b>${p.pos}</b> ${escP(p.abrev)} <em>${p.puntos}</em>
    </span>`).join("");
  // Duplicado para que el desplazamiento infinito no tenga salto.
  el.innerHTML = `<div class="cinta-pista">
    <span class="cinta-item etiqueta"><span class="pulso-vivo">EN VIVO</span> ${c.temporada} · tras la ronda ${c.ronda}</span>
    ${items}<span class="cinta-item etiqueta">·</span>${items}</div>`;
}

/* ============================ CAMPEONATO ============================= */

function pintarCampeonatoVivo(c) {
  const previo = PV.anterior.clasificacion;
  // Referencia para las flechas: la ultima vez que se vio, o el pipeline.
  const base = previo ?? {
    pilotos: (estado.clasificacion?.pilotos ?? []).map((p) => ({ driverId: p.DriverId, pos: p.pos, puntos: p.puntos })),
    ronda: estado.clasificacion?.carreras_disputadas,
  };

  const t = document.getElementById("titulo-pilotos-camp");
  if (t) t.textContent = `Pilotos — ${c.temporada} (${c.ronda} carreras)`;

  const thead = document.querySelector("#tabla-camp-pilotos thead");
  if (thead) thead.innerHTML = `<tr><th class="num">#</th><th>Piloto</th><th>Equipo</th>
    <th class="num">Pts</th><th class="num">V</th><th class="num" title="Puestos ganados o perdidos desde los datos del modelo">±</th></tr>`;

  const tb = document.querySelector("#tabla-camp-pilotos tbody");
  if (tb) {
    const lider = c.pilotos[0]?.puntos || 1;
    tb.innerHTML = c.pilotos.map((p, i) => {
      const b = base.pilotos.find((x) => x.driverId === p.driverId);
      const mov = b ? b.pos - p.pos : 0;
      const subio = b && p.puntos > b.puntos;
      return `<tr class="${subio && previo ? "destello" : ""}" style="--i:${i}">
        <td class="num">${badgePos(p.pos)}</td>
        <td>${celdaPiloto({ abrev: p.abrev, nombre: p.nombre, equipo: p.equipo }, false)}
            <div class="mini-barra"><i style="width:${(p.puntos / lider) * 100}%;background:${colorEquipo(p.equipo)}"></i></div></td>
        <td class="texto-tenue">${escP(p.equipo)}</td>
        <td class="num"><b>${p.puntos}</b></td>
        <td class="num">${p.victorias}</td>
        <td class="num mov ${mov > 0 ? "sube" : mov < 0 ? "baja" : ""}">${mov > 0 ? `▲${mov}` : mov < 0 ? `▼${-mov}` : "–"}</td>
      </tr>`;
    }).join("");
  }

  const te = document.querySelector("#tabla-camp-equipos tbody");
  if (te) {
    const lider = c.equipos[0]?.puntos || 1;
    te.innerHTML = c.equipos.map((e) => `<tr>
      <td class="num">${badgePos(e.pos)}</td>
      <td><span class="equipo-chip" style="background:${colorEquipo(e.equipo)}"></span>${escP(e.equipo)}
          <div class="mini-barra"><i style="width:${(e.puntos / lider) * 100}%;background:${colorEquipo(e.equipo)}"></i></div></td>
      <td class="num"><b>${e.puntos}</b></td>
      <td class="num">${e.victorias}</td>
      <td class="num texto-tenue">—</td></tr>`).join("");
  }

  sello("sello-campeonato", c.en, "jolpica-f1");

  // Si la API va por delante del pipeline, se dice: es justo lo que aporta.
  const avance = document.getElementById("avance-campeonato");
  const rp = estado.clasificacion?.carreras_disputadas;
  if (avance && rp && c.ronda > rp) {
    avance.hidden = false;
    avance.innerHTML = `Los datos en vivo van <b>${c.ronda - rp} ${c.ronda - rp === 1 ? "carrera" : "carreras"}
      por delante</b> de los del modelo (ronda ${c.ronda} frente a ${rp}). Las predicciones se
      recalculan cuando corre el pipeline; la clasificación ya está al día.`;
  }
  PV.anterior.clasificacion = c;
}

function pintarPlantilla(pl) {
  const el = document.getElementById("plantilla-vivo");
  if (!el) return;
  el.innerHTML = pl.equipos.map((e, i) => `
    <article class="equipo-tarjeta tilt" style="--color:${colorEquipo(e.equipo)};--i:${i}">
      <header>
        <span class="eq-pos">P${e.pos}</span>
        <h3>${escP(e.equipo)}</h3>
        <b class="eq-pts">${e.puntos}<small> pts</small></b>
      </header>
      <div class="eq-pilotos">
        ${e.pilotos.map((p) => `
          <div class="eq-piloto">
            <span class="dorsal">${p.dorsal ?? ""}</span>
            <div><b>${escP(p.nombre)}</b><small>${escP(p.nacionalidad ?? "")} · P${p.pos} · ${p.puntos} pts</small></div>
          </div>`).join("")}
      </div>
    </article>`).join("");
  sello("sello-plantilla", pl.en, "jolpica-f1");
  Escena3D?.activarTilt?.(el);
}

/* ============================== MERCADO ============================== */

/** Probabilidad del modelo (simulacion del pipeline) para un nombre. */
function probModelo(nombre, tipo = "pilotos") {
  const lista = estado.mercado?.[tipo] ?? [];
  const k = claveNombre(nombre);
  const f = lista.find((x) => claveNombre(x.nombre ?? x.equipo) === k);
  return f?.prob_titulo ?? null;
}

function colorDe(nombre) {
  const k = claveNombre(nombre);
  const p = (estado.clasificacion?.pilotos ?? []).find((x) => claveNombre(x.nombre) === k);
  return colorEquipo(p?.equipo ?? nombre);
}

function pintarMercadoVivo(m) {
  const pil = m.pilotos;
  if (!pil) return;

  // --- cifras grandes ---
  contar(document.getElementById("mv-volumen"), pil.volumen / 1e6, { dec: 1, prefijo: "$", sufijo: "M" });
  contar(document.getElementById("mv-liquidez"), pil.liquidez / 1e6, { dec: 2, prefijo: "$", sufijo: "M" });
  // La suma de precios, no el margen: en Polymarket suele quedar por debajo
  // de 100 % y un "margen negativo" parece un error aunque no lo sea.
  contar(document.getElementById("mv-margen"), (pil.margen + 1) * 100, { dec: 1, sufijo: "%" });
  const lider = pil.opciones[0];
  const ml = document.getElementById("mv-lider");
  if (ml && lider) ml.textContent = lider.nombre;
  contar(document.getElementById("mv-lider-p"), lider.prob * 100, { dec: 1, sufijo: "%" });
  sello("sello-mercado", m.en, "Polymarket");

  // --- la carrera por el titulo ---
  const prev = PV.anterior.mercado?.pilotos?.opciones ?? [];
  const top = pil.opciones.filter((o) => o.prob > 0.003).slice(0, 10);
  const escala = Math.max(...top.map((o) => Math.max(o.prob, probModelo(o.nombre) ?? 0)), 0.01);

  const pista = document.getElementById("mv-carrera");
  pista.innerHTML = top.map((o, i) => {
    const antes = prev.find((x) => x.nombre === o.nombre);
    const flash = antes && Math.abs(antes.prob - o.prob) > 1e-4 ? (o.prob > antes.prob ? "flash-sube" : "flash-baja") : "";
    const mod = probModelo(o.nombre);
    const c24 = o.cambio24h;
    const color = colorDe(o.nombre);
    return `<div class="carril ${flash}" style="--color:${color};--i:${i}">
      <span class="c-pos">${i + 1}</span>
      <span class="c-nombre">${escP(o.nombre)}</span>
      <div class="c-pista">
        <i class="c-barra" style="width:${(o.prob / escala) * 100}%"><span class="c-coche">🏎️</span></i>
        ${mod != null ? `<span class="c-modelo" style="left:${(mod / escala) * 100}%" title="Modelo: ${pct(mod)}"></span>` : ""}
      </div>
      <b class="c-prob">${(o.prob * 100).toFixed(1)}%</b>
      <span class="c-24 ${c24 > 0 ? "sube" : c24 < 0 ? "baja" : ""}">${c24 == null ? "" : `${c24 > 0 ? "▲" : c24 < 0 ? "▼" : "•"} ${Math.abs(c24 * 100).toFixed(1)}`}</span>
    </div>`;
  }).join("");

  // --- podio 3D del mercado ---
  const podio = pil.opciones.slice(0, 3).map((o) => ({
    nombre: o.nombre, valor: o.prob, color: colorDe(o.nombre),
  }));
  Escena3D?.podio?.(document.getElementById("mv-podio"), podio);

  // --- constructores, en compacto ---
  const eq = m.equipos;
  const ce = document.getElementById("mv-equipos");
  if (eq && ce) {
    const esc2 = Math.max(...eq.opciones.slice(0, 6).map((o) => o.prob), 0.01);
    ce.innerHTML = eq.opciones.slice(0, 6).map((o) => {
      const mod = probModelo(o.nombre, "equipos");
      return `<div class="carril compacto" style="--color:${colorEquipo(o.nombre)}">
        <span class="c-nombre">${escP(o.nombre)}</span>
        <div class="c-pista"><i class="c-barra" style="width:${(o.prob / esc2) * 100}%"></i>
          ${mod != null ? `<span class="c-modelo" style="left:${Math.min(100, (mod / esc2) * 100)}%"></span>` : ""}</div>
        <b class="c-prob">${(o.prob * 100).toFixed(1)}%</b></div>`;
    }).join("");
  }

  // El historico solo se pide la primera vez: cambia despacio.
  if (!PV.anterior.mercado) pintarHistorial(pil);
  PV.anterior.mercado = m;
  pintarMatriz();
}

async function pintarHistorial(pil) {
  pil = pil ?? Vivo.datos.mercado?.pilotos;
  if (!pil || typeof Chart === "undefined") return;
  const top = pil.opciones.slice(0, 5).filter((o) => o.tokenId);
  const fidelidad = { "1d": 10, "1w": 60, "1m": 180, max: 720 }[PV.rango] ?? 180;

  const series = await Promise.all(top.map((o) =>
    Vivo.historial(o.tokenId, PV.rango, fidelidad).then((h) => ({ o, h })).catch(() => ({ o, h: [] }))));

  const canvas = document.getElementById("chart-historial");
  PV.graficoHist?.destroy();
  PV.graficoHist = new Chart(canvas, {
    type: "line",
    data: {
      datasets: series.filter((s) => s.h.length).map(({ o, h }) => {
        const c = colorDe(o.nombre);
        return {
          label: o.nombre.split(" ").at(-1),
          data: h.map((p) => ({ x: p.t, y: p.p * 100 })),
          borderColor: c, backgroundColor: c + "22", fill: true,
          borderWidth: 2.2, pointRadius: 0, tension: 0.3,
        };
      }),
    },
    options: {
      responsive: true, maintainAspectRatio: false, parsing: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: LEYENDA,
        tooltip: {
          callbacks: {
            title: (it) => new Date(it[0].parsed.x).toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
            label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%`,
          },
        },
      },
      scales: {
        x: { ...EJE, type: "linear", ticks: { ...EJE.ticks, maxTicksLimit: 6,
             callback: (v) => new Date(v).toLocaleDateString("es", { day: "numeric", month: "short" }) } },
        y: { ...EJE, title: { text: "Probabilidad (%)", display: true, color: "#9a99a8" } },
      },
    },
  });
  estado.charts.historial = PV.graficoHist;
}

/* ------------------------ CASAS DE APUESTAS ------------------------- */

function pintarCuotas(c) {
  const cont = document.getElementById("mv-casas");
  if (!cont) return;

  if (!c.casas.length) {
    cont.innerHTML = `<div class="casa-vacia">
      <p><b>Aún no hay cuotas de casas de apuestas.</b></p>
      <p class="texto-tenue">${CONFIG.hayCuotas()
        ? "The Odds API respondió sin mercados de campeonato de F1 para las regiones configuradas."
        : "Pon tu clave gratuita de The Odds API en <code>js/config.js</code>."}
      BetPlay no tiene API pública: sus cuotas las carga un admin desde la pestaña Quiniela.</p></div>`;
    pintarMatriz();
    return;
  }

  cont.innerHTML = c.casas.map((casa, i) => {
    const fav = casa.selecciones[0];
    return `<article class="casa tilt" style="--i:${i}">
      <header><h3>${escP(casa.casa)}</h3><span class="texto-tenue">${escP(casa.origen)}</span></header>
      <div class="casa-fav">
        <span class="texto-tenue">Favorito</span>
        <b>${escP(fav.nombre)}</b>
        <div class="casa-cuota">${fav.cuota.toFixed(2)}</div>
        <span class="texto-tenue">≈ ${(fav.prob * 100).toFixed(1)}% sin margen</span>
      </div>
      <footer>
        <span>Margen de la casa <b class="${casa.margen > 0.15 ? "alto" : ""}">${(casa.margen * 100).toFixed(1)}%</b></span>
        ${casa.actualizado ? `<span class="texto-tenue">${Vivo.hace(casa.actualizado)}</span>` : ""}
      </footer>
    </article>`;
  }).join("");
  Escena3D?.activarTilt?.(cont);
  pintarMatriz();
}

/** Tabla cruzada: cada piloto, lo que dice cada fuente. */
function pintarMatriz() {
  const el = document.getElementById("mv-matriz");
  if (!el) return;
  const pm = Vivo.datos.mercado?.pilotos?.opciones ?? [];
  const casas = Vivo.datos.cuotas?.casas ?? [];

  const nombres = pm.filter((o) => o.prob > 0.005).slice(0, 10).map((o) => o.nombre);
  if (!nombres.length) { el.innerHTML = ""; return; }

  const celda = (p, extra = "") => p == null ? `<td class="num texto-tenue">—</td>`
    : `<td class="num ${extra}"><span class="calor" style="--a:${Math.min(1, p * 1.6)}">${(p * 100).toFixed(1)}%</span></td>`;

  el.innerHTML = `<div class="tabla-wrap"><table class="matriz">
    <thead><tr><th>Piloto</th><th class="num">🤖 Modelo</th><th class="num">Polymarket</th>
      ${casas.map((c) => `<th class="num">${escP(c.casa)}</th>`).join("")}
      <th class="num" title="Modelo menos la media del mercado y las casas">Δ modelo</th></tr></thead>
    <tbody>${nombres.map((n) => {
      const k = claveNombre(n);
      const mod = probModelo(n);
      const poly = pm.find((o) => o.nombre === n)?.prob ?? null;
      const deCasas = casas.map((c) => c.selecciones.find((s) => claveNombre(s.nombre) === k)?.prob ?? null);
      const fuera = [poly, ...deCasas].filter((x) => x != null);
      const media = fuera.length ? fuera.reduce((a, b) => a + b, 0) / fuera.length : null;
      const d = mod != null && media != null ? mod - media : null;
      return `<tr><td><span class="equipo-chip" style="background:${colorDe(n)}"></span>${escP(n)}</td>
        ${celda(mod)}${celda(poly)}${deCasas.map((p) => celda(p)).join("")}
        <td class="num" style="font-weight:700;color:${d == null ? "var(--texto-tenue)" : d > 0.01 ? "var(--verde)" : d < -0.01 ? "var(--rojo-suave)" : "var(--texto-tenue)"}">
          ${d == null ? "—" : `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}`}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

/* ============================== ARRANQUE ============================= */

const PanelesVivo = {
  iniciar() {
    // Pintado inmediato con el pipeline, para que no haya huecos.
    const cp = estado.clasificacion;
    if (cp) {
      pintarCinta({
        temporada: cp.temporada, ronda: cp.carreras_disputadas,
        pilotos: cp.pilotos.map((p) => ({ pos: p.pos, abrev: p.abrev, puntos: p.puntos, equipo: p.equipo })),
      });
    }

    Vivo.on("clasificacion", (c) => { pintarCinta(c); pintarCampeonatoVivo(c); });
    Vivo.on("plantilla", pintarPlantilla);
    Vivo.on("mercado", pintarMercadoVivo);
    Vivo.on("cuotas", pintarCuotas);

    document.getElementById("mv-rango")?.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-rango]");
      if (!b) return;
      PV.rango = b.dataset.rango;
      document.querySelectorAll("#mv-rango button").forEach((x) => x.classList.toggle("activa", x === b));
      pintarHistorial();
    });

    const mk = estado.mercado?.mercado;
    Vivo.arrancar({
      temporada: estado.indice?.temporadas?.at(-1),
      slugs: {
        pilotos: mk?.pilotos?.slug ?? `${new Date().getFullYear()}-f1-drivers-champion`,
        equipos: mk?.equipos?.slug ?? "f1-constructors-champion",
      },
    });
  },
};

window.PanelesVivo = PanelesVivo;
})();
