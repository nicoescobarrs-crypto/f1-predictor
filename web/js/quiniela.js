/* ============================================================
   F1 Predictor — Quiniela

   Cada usuario predice el top 10 de un Gran Premio antes de la
   clasificacion. Tras la carrera se puntua contra el resultado real,
   y el modelo juega tambien con la misma regla: la pregunta de fondo
   es "¿le ganas a la maquina?".

   Quien decide que se puede y que no es Postgres (sql/schema.sql):
   el plazo se comprueba con la hora del servidor y nadie ve la
   quiniela de otro antes de que cierre. Aqui solo se pinta.
   ============================================================ */

(function () {

const Quiniela = {
  gps: [],             // calendario: [{slug, evento, fecha, cierra_en, ...}]
  slug: null,          // GP seleccionado
  pilotos: [],         // los que corren ese GP
  top10: Array(10).fill(null),
  abandonos: null,
  mia: null,           // la quiniela guardada del usuario para ese GP
  modeloTop10: null,   // lo que predice el modelo para ese GP
  calendarioBD: false, // true si el calendario sale de Supabase
  _reloj: null,
  _canal: null,
  _refrescoPendiente: null,
};

/* ------------------------------ PUNTUACION ----------------------------
   Copia exacta de public.calcular_puntos() en sql/schema.sql. La oficial
   es la de SQL; esta existe para dos cosas que no pueden esperar al
   servidor: la vista previa mientras montas el top 10, y la puntuacion
   del modelo, que no es un usuario y no tiene fila en quinielas.
   Si cambias una, cambia la otra. */
function calcularPuntos(pron, real, abPron, abReal) {
  let base = 0, exactos = 0, movidos = 0, bonus = 0;
  for (let i = 0; i < 10; i++) {
    const j = real.indexOf(pron[i]);
    if (j === i) { exactos++; base += 15; }
    else if (j >= 0) { movidos++; base += Math.max(0, 5 - Math.abs(j - i)); }
  }
  const ganador = pron[0] != null && pron[0] === real[0];
  if (ganador) bonus += 25;
  if (ganador && pron[1] === real[1] && pron[2] === real[2]) bonus += 30;
  if (abPron != null && abPron === abReal) bonus += 10;
  return { puntos: base + bonus, exactos, movidos, base, bonus, ganador };
}
const PLENO = 15 * 10 + 25 + 30 + 10;   // 215

/* ------------------------------- UTILES ------------------------------- */

const esc = (s) => (typeof escapar === "function" ? escapar(s) : String(s ?? ""));

/** "2026 Spanish Grand Prix" -> "2026-spanish-grand-prix", igual que el pipeline. */
function slugDe(temporada, nombre) {
  return `${temporada}-${nombre}`
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function fechaLarga(d) {
  return new Date(d).toLocaleString("es", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

const gpActual = () => Quiniela.gps.find((g) => g.slug === Quiniela.slug);
const abierta = (gp) => gp && new Date(gp.cierra_en) > new Date();
const piloto = (id) => Quiniela.pilotos.find((p) => p.driver_id === id);

/* ----------------------------- CALENDARIO ----------------------------- */

/** Calendario de la API publica, con la hora de la qualy como cierre. */
async function calendarioPublico(temporada) {
  const j = await fetch(`${CONFIG.vivo.jolpica}/${temporada}/races/?format=json&limit=100`)
    .then((r) => r.json());
  return (j.MRData?.RaceTable?.Races ?? []).map((r) => {
    // La quiniela cierra al empezar la clasificacion: a partir de ahi ya se
    // sabe la parrilla y predecir es mucho mas facil. Si la API no trae la
    // hora, se cierra el dia antes de la carrera a mediodia UTC.
    const q = r.Qualifying;
    const cierra = q?.date
      ? new Date(`${q.date}T${q.time ?? "12:00:00Z"}`)
      : new Date(new Date(`${r.date}T12:00:00Z`).getTime() - 86400000);
    return {
      slug: slugDe(r.season, r.raceName),
      evento: r.raceName,
      lugar: r.Circuit?.Location?.locality ?? "",
      pais: r.Circuit?.Location?.country ?? "",
      ronda: Number(r.round),
      temporada: Number(r.season),
      fecha: r.date,
      cierra_en: cierra.toISOString(),
      disputado: new Date(`${r.date}T${r.time ?? "23:59:00Z"}`) < new Date(),
    };
  });
}

async function cargarCalendario() {
  const temporada = estado.indice?.temporadas?.at(-1) ?? new Date().getFullYear();

  if (Cuenta.sb) {
    const { data, error } = await Cuenta.sb
      .from("grandes_premios").select("*").eq("temporada", temporada).order("ronda");
    if (!error && data?.length) {
      Quiniela.gps = data;
      Quiniela.calendarioBD = true;
      return;
    }
  }
  // Sin calendario en la BD (o sin BD): se juega en modo vista previa con el
  // publico. Guardar exige que el admin lo sincronice, por la RLS.
  Quiniela.gps = await calendarioPublico(temporada).catch(() => []);
  Quiniela.calendarioBD = false;
}

/* ------------------------------ PILOTOS ------------------------------- */

async function cargarPilotosDe(slug) {
  Quiniela.modeloTop10 = null;

  // 1) La prediccion del pipeline para ese GP: trae pilotos Y top 10 del modelo.
  const ev = await cargarJSON(`events/${slug}.json`).catch(() => null);
  if (ev?.prediccion?.length) {
    const orden = ev.prediccion.slice().sort((a, b) => a.pos_predicha - b.pos_predicha);
    Quiniela.pilotos = orden.map((p) => ({
      driver_id: p.driver_id, abrev: p.abrev, nombre: p.nombre, equipo: p.equipo,
    }));
    Quiniela.modeloTop10 = orden.slice(0, 10).map((p) => p.driver_id);
    return;
  }

  // 2) La plantilla en vivo.
  const pl = Vivo.datos.plantilla;
  if (pl?.equipos?.length) {
    Quiniela.pilotos = pl.equipos.flatMap((e) => e.pilotos.map((p) => ({
      driver_id: p.driverId, abrev: p.abrev, nombre: p.nombre, equipo: e.equipo,
    })));
    return;
  }

  // 3) La clasificacion del pipeline, que siempre esta.
  Quiniela.pilotos = (estado.clasificacion?.pilotos ?? []).map((p) => ({
    driver_id: p.DriverId, abrev: p.abrev, nombre: p.nombre, equipo: p.equipo,
  }));
}

/* ------------------------------ ESQUELETO ----------------------------- */

function pintarEsqueleto() {
  const raiz = document.getElementById("quiniela-raiz");
  raiz.innerHTML = `
    <div class="q-hero tarjeta brillo" id="q-hero"></div>

    <div id="q-aviso"></div>

    <div class="q-juego">
      <div class="tarjeta">
        <h2>Pilotos <span class="texto-tenue" style="font-weight:400">toca para colocar</span></h2>
        <div class="q-pilotos" id="q-pilotos"></div>
      </div>

      <div class="tarjeta q-slots-tarjeta">
        <h2>Tu top 10
          <span class="q-botones">
            <button class="accion secundaria" id="q-modelo" title="Parte de la predicción del modelo">🤖 Copiar al modelo</button>
            <button class="accion secundaria" id="q-vaciar">Vaciar</button>
          </span>
        </h2>
        <ol class="q-slots" id="q-slots"></ol>

        <div class="q-extra">
          <label class="campo">Abandonos <small>(+10 si aciertas)</small>
            <div class="stepper">
              <button type="button" data-ab="-1">−</button>
              <output id="q-ab">—</output>
              <button type="button" data-ab="1">+</button>
            </div>
          </label>
          <div class="q-preview" id="q-preview"></div>
        </div>

        <button class="accion grande" id="q-guardar">Guardar quiniela</button>
        <p class="texto-tenue q-estado" id="q-estado"></p>
      </div>
    </div>

    <div class="rejilla-2 q-inferior">
      <div class="tarjeta">
        <h2>Clasificación <span class="pulso-vivo" title="Se actualiza en tiempo real">EN VIVO</span></h2>
        <div id="q-ranking"></div>
      </div>
      <div class="pila">
        <div class="tarjeta">
          <h2>Tus quinielas</h2>
          <div id="q-historial"></div>
        </div>
        <div class="tarjeta metodo">
          <h2>Cómo se puntúa</h2>
          <ul class="q-reglas">
            <li><b>15</b> por cada piloto en su posición exacta</li>
            <li><b>5</b> si está en el top 10 pero en otro sitio, menos 1 por puesto de error</li>
            <li><b>+25</b> si aciertas el ganador</li>
            <li><b>+30</b> si aciertas el podio completo en orden</li>
            <li><b>+10</b> si aciertas cuántos abandonan</li>
          </ul>
          <p class="texto-tenue">Pleno: ${PLENO} puntos. Cierra al empezar la clasificación del sábado, con la hora del servidor.</p>
        </div>
      </div>
    </div>

    <div id="q-admin"></div>`;

  document.getElementById("q-modelo").onclick = () => {
    if (!Quiniela.modeloTop10) return;
    Quiniela.top10 = Quiniela.modeloTop10.slice();
    pintarJuego();
  };
  document.getElementById("q-vaciar").onclick = () => {
    Quiniela.top10 = Array(10).fill(null);
    pintarJuego();
  };
  document.querySelector(".stepper").addEventListener("click", (e) => {
    const d = Number(e.target.dataset.ab);
    if (!d) return;
    Quiniela.abandonos = Math.min(20, Math.max(0, (Quiniela.abandonos ?? 2) + (Quiniela.abandonos == null ? 0 : d)));
    pintarJuego();
  });
  document.getElementById("q-guardar").onclick = guardar;

  activarArrastre();
}

/* -------------------------------- HERO -------------------------------- */

function pintarHero() {
  const gp = gpActual();
  const hero = document.getElementById("q-hero");
  if (!gp) {
    hero.innerHTML = `<p class="texto-tenue">No hay Grandes Premios en el calendario.</p>`;
    return;
  }

  const opciones = Quiniela.gps
    .filter((g) => !g.disputado || g.slug === Quiniela.slug)
    .map((g) => `<option value="${g.slug}" ${g.slug === Quiniela.slug ? "selected" : ""}>
        R${g.ronda} · ${esc(g.evento)}</option>`).join("");

  hero.innerHTML = `
    <div class="q-hero-info">
      <span class="etiqueta-sup">Ronda ${gp.ronda} · ${esc(gp.lugar)}${gp.pais ? `, ${esc(gp.pais)}` : ""}</span>
      <h2 class="q-titulo">${esc(gp.evento)}</h2>
      <p class="texto-tenue">Cierra el ${fechaLarga(gp.cierra_en)}</p>
      <label class="campo" style="margin-top:.8rem">Gran Premio
        <select id="q-sel-gp">${opciones}</select>
      </label>
    </div>
    <div class="q-cuenta" id="q-cuenta"></div>
    <div class="q-jugadores" id="q-jugadores"></div>`;

  document.getElementById("q-sel-gp").onchange = (e) => seleccionarGP(e.target.value);
  tic();
}

/** Cuenta atras hasta el cierre. Un segundo por tic, y solo si se ve. */
function tic() {
  const cont = document.getElementById("q-cuenta");
  const gp = gpActual();
  if (!cont || !gp) return;

  const ms = new Date(gp.cierra_en) - Date.now();
  if (ms <= 0) {
    cont.innerHTML = `<div class="q-cerrada">🔒 Cerrada</div>`;
    return;
  }
  const d = Math.floor(ms / 86400000);
  const h = Math.floor(ms / 3600000) % 24;
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const caja = (v, k) => `<div class="q-caja"><b>${String(v).padStart(2, "0")}</b><span>${k}</span></div>`;
  cont.innerHTML = caja(d, "días") + caja(h, "horas") + caja(m, "min") + caja(s, "seg");
}

async function pintarJugadores() {
  const el = document.getElementById("q-jugadores");
  if (!el || !Cuenta.sb || !Quiniela.calendarioBD) return;
  const { data } = await Cuenta.sb.rpc("contar_quinielas", { slug: Quiniela.slug });
  if (typeof data === "number") {
    el.innerHTML = `<b class="contador" data-v="${data}">${data}</b>
                    <span>${data === 1 ? "quiniela enviada" : "quinielas enviadas"}</span>`;
  }
}

/* -------------------------------- JUEGO ------------------------------- */

function pintarJuego() {
  const usados = new Set(Quiniela.top10.filter(Boolean));
  const gp = gpActual();
  const cerrada = !abierta(gp);

  document.getElementById("q-pilotos").innerHTML = Quiniela.pilotos.map((p) => `
    <button class="q-piloto ${usados.has(p.driver_id) ? "usado" : ""}" data-id="${p.driver_id}"
            style="--color:${colorEquipo(p.equipo)}" ${cerrada ? "disabled" : ""}>
      <b>${esc(p.abrev)}</b><span>${esc(p.nombre.split(" ").slice(-1)[0])}</span>
    </button>`).join("");

  document.getElementById("q-slots").innerHTML = Quiniela.top10.map((id, i) => {
    const p = id ? piloto(id) : null;
    const podio = i < 3 ? ` podio p${i + 1}` : "";
    return `<li class="q-slot${podio}${p ? " lleno" : ""}" data-i="${i}"
                ${p && !cerrada ? 'draggable="true"' : ""} style="--color:${p ? colorEquipo(p.equipo) : "transparent"}">
      <span class="q-num">P${i + 1}</span>
      ${p ? `<span class="q-nombre"><b>${esc(p.abrev)}</b> ${esc(p.nombre)}<small>${esc(p.equipo)}</small></span>
             ${cerrada ? "" : `<span class="q-flechas">
               <button data-mover="-1" data-i="${i}" aria-label="Subir">▲</button>
               <button data-mover="1" data-i="${i}" aria-label="Bajar">▼</button>
               <button data-quitar="${i}" aria-label="Quitar">✕</button></span>`}`
          : `<span class="q-vacio">${cerrada ? "—" : "elige un piloto"}</span>`}
    </li>`;
  }).join("");

  document.getElementById("q-ab").textContent = Quiniela.abandonos ?? "—";
  document.getElementById("q-modelo").disabled = cerrada || !Quiniela.modeloTop10;
  document.getElementById("q-vaciar").disabled = cerrada;

  pintarPreview();
  pintarBotonGuardar();
  guardarBorrador();
}

/** "Si la carrera saliera como dice el modelo, harias X puntos". */
function pintarPreview() {
  const el = document.getElementById("q-preview");
  const n = Quiniela.top10.filter(Boolean).length;
  if (!Quiniela.modeloTop10 || n === 0) { el.innerHTML = ""; return; }

  const r = calcularPuntos(Quiniela.top10, Quiniela.modeloTop10, null, null);
  const coincide = r.exactos === 10;
  el.innerHTML = `
    <div class="q-medidor" style="--p:${Math.round((r.puntos / (PLENO - 10)) * 100)}">
      <b>${r.puntos}</b><span>pts</span>
    </div>
    <p class="texto-tenue">${coincide
      ? "Idéntica a la del modelo. Si acierta él, aciertas tú; pero no le ganarás nunca."
      : `Si la carrera saliera <b>exactamente</b> como predice el modelo, harías ${r.puntos} puntos
         (${r.exactos} exactos). Cuanto más te alejas, más arriesgas… y más le puedes ganar.`}</p>`;
}

function pintarBotonGuardar() {
  const btn = document.getElementById("q-guardar");
  const estadoTxt = document.getElementById("q-estado");
  const gp = gpActual();
  const completo = Quiniela.top10.every(Boolean);

  btn.hidden = false;
  if (!abierta(gp)) {
    btn.hidden = true;
    estadoTxt.textContent = Quiniela.mia
      ? (Quiniela.mia.puntos != null ? `Puntuada: ${Quiniela.mia.puntos} puntos.` : "Enviada. Se puntuará tras la carrera.")
      : "El plazo de este Gran Premio ya cerró.";
    return;
  }
  if (!CONFIG.hayCuenta()) {
    btn.disabled = true;
    estadoTxt.textContent = "Modo vista previa: falta configurar Supabase en js/config.js para poder guardar.";
    return;
  }
  if (!Cuenta.sesion) {
    btn.disabled = false;
    btn.textContent = "Entra para guardarla";
    estadoTxt.textContent = "Tu top 10 no se pierde: al entrar sigue aquí.";
    return;
  }
  if (!Quiniela.calendarioBD) {
    btn.disabled = true;
    estadoTxt.textContent = "El calendario aún no está en la base de datos. Un admin debe sincronizarlo (abajo).";
    return;
  }
  btn.textContent = Quiniela.mia ? "Actualizar quiniela" : "Guardar quiniela";
  btn.disabled = !completo;
  estadoTxt.textContent = completo
    ? (Quiniela.mia ? `Guardada el ${fechaLarga(Quiniela.mia.enviada_en)}. Puedes cambiarla hasta el cierre.` : "")
    : `Faltan ${Quiniela.top10.filter((x) => !x).length} pilotos.`;
}

/* ------------------------- CLICS Y ARRASTRE ------------------------- */

function activarArrastre() {
  const pilotos = document.getElementById("q-pilotos");
  const slots = document.getElementById("q-slots");

  // Tocar un piloto lo pone en el primer hueco libre. Tocarlo otra vez lo quita.
  pilotos.addEventListener("click", (e) => {
    const b = e.target.closest(".q-piloto");
    if (!b || b.disabled) return;
    const id = b.dataset.id;
    const ya = Quiniela.top10.indexOf(id);
    if (ya >= 0) Quiniela.top10[ya] = null;
    else {
      const hueco = Quiniela.top10.indexOf(null);
      if (hueco < 0) return aviso("El top 10 está completo: quita a alguien primero.");
      Quiniela.top10[hueco] = id;
    }
    pintarJuego();
  });

  slots.addEventListener("click", (e) => {
    const q = e.target.closest("[data-quitar]");
    if (q) { Quiniela.top10[Number(q.dataset.quitar)] = null; return pintarJuego(); }
    const m = e.target.closest("[data-mover]");
    if (m) {
      const i = Number(m.dataset.i), j = i + Number(m.dataset.mover);
      if (j < 0 || j > 9) return;
      [Quiniela.top10[i], Quiniela.top10[j]] = [Quiniela.top10[j], Quiniela.top10[i]];
      pintarJuego();
    }
  });

  // Arrastrar entre huecos intercambia los dos pilotos.
  let origen = null;
  slots.addEventListener("dragstart", (e) => {
    const li = e.target.closest(".q-slot");
    origen = li ? Number(li.dataset.i) : null;
    li?.classList.add("arrastrando");
    e.dataTransfer.effectAllowed = "move";
  });
  slots.addEventListener("dragover", (e) => {
    e.preventDefault();
    slots.querySelectorAll(".destino").forEach((x) => x.classList.remove("destino"));
    e.target.closest(".q-slot")?.classList.add("destino");
  });
  slots.addEventListener("drop", (e) => {
    e.preventDefault();
    const li = e.target.closest(".q-slot");
    if (li == null || origen == null) return;
    const d = Number(li.dataset.i);
    [Quiniela.top10[origen], Quiniela.top10[d]] = [Quiniela.top10[d], Quiniela.top10[origen]];
    origen = null;
    pintarJuego();
  });
  slots.addEventListener("dragend", () => {
    origen = null;
    slots.querySelectorAll(".arrastrando, .destino").forEach((x) => x.classList.remove("arrastrando", "destino"));
  });
}

function aviso(txt, tipo = "info") {
  const el = document.getElementById("q-estado");
  el.textContent = txt;
  el.className = `texto-tenue q-estado ${tipo}`;
}

/* ------------------------------ GUARDAR ------------------------------- */

async function guardar() {
  if (!Cuenta.sesion) return Cuenta.abrirModal("entrar");
  const btn = document.getElementById("q-guardar");
  btn.disabled = true;
  btn.textContent = "Guardando…";

  const { data, error } = await Cuenta.sb
    .from("quinielas")
    .upsert({
      usuario_id: Cuenta.sesion.user.id,
      evento_slug: Quiniela.slug,
      top10: Quiniela.top10,
      abandonos: Quiniela.abandonos,
      enviada_en: new Date().toISOString(),
    }, { onConflict: "usuario_id,evento_slug" })
    .select()
    .single();

  if (error) {
    pintarBotonGuardar();
    return aviso(traducirError(error.message), "error");
  }
  Quiniela.mia = data;
  pintarBotonGuardar();
  aviso("✔ Quiniela guardada. Suerte el domingo.", "ok");
  document.getElementById("q-slots").classList.add("guardado");
  setTimeout(() => document.getElementById("q-slots")?.classList.remove("guardado"), 900);
  pintarJugadores();
}

/* ------------------------------ RANKING ------------------------------- */

async function puntosDelModelo() {
  const { data } = await Cuenta.sb.from("resultados_gp").select("top10, abandonos, top10_modelo");
  let puntos = 0, jugadas = 0, mejor = 0, ganadores = 0;
  for (const r of (data ?? [])) {
    if (!r.top10_modelo?.length) continue;
    const c = calcularPuntos(r.top10_modelo, r.top10, null, r.abandonos);
    puntos += c.puntos; jugadas++; mejor = Math.max(mejor, c.puntos);
    if (c.ganador) ganadores++;
  }
  return jugadas ? { usuario: "Modelo", avatar: "🤖", puntos, jugadas, mejor, ganadores, esModelo: true } : null;
}

async function pintarRanking() {
  const el = document.getElementById("q-ranking");
  if (!Cuenta.sb) {
    el.innerHTML = `<p class="texto-tenue">El ranking entre usuarios necesita la base de datos.
      Configura Supabase en <code>js/config.js</code> (pasos en DEPLOY.md).</p>`;
    return;
  }

  const [{ data, error }, modelo] = await Promise.all([
    Cuenta.sb.from("tabla_general").select("*").order("puntos", { ascending: false }).limit(100),
    puntosDelModelo().catch(() => null),
  ]);
  if (error) { el.innerHTML = `<p class="texto-tenue">${esc(error.message)}</p>`; return; }

  const filas = (data ?? []).filter((f) => f.jugadas > 0);
  if (modelo) filas.push(modelo);
  filas.sort((a, b) => b.puntos - a.puntos);

  if (!filas.length) {
    el.innerHTML = `<p class="texto-tenue">Todavía no se ha puntuado ninguna carrera. Sé el primero en jugar.</p>`;
    return;
  }

  const yo = Cuenta.sesion?.user.id;
  const max = filas[0].puntos || 1;
  const posModelo = filas.findIndex((f) => f.esModelo);
  const miPos = filas.findIndex((f) => f.id === yo);

  el.innerHTML = `
    ${miPos >= 0 && posModelo >= 0 ? `<div class="q-vs ${miPos < posModelo ? "ganas" : "pierdes"}">
      ${miPos < posModelo ? "🏆 Vas por delante del modelo" : "🤖 El modelo te va ganando"}
      <b>${filas[miPos].puntos} – ${filas[posModelo].puntos}</b></div>` : ""}
    <ol class="ranking">
      ${filas.map((f, i) => `
        <li class="${f.id === yo ? "yo" : ""} ${f.esModelo ? "modelo" : ""}" style="--i:${i}">
          <span class="r-pos">${i + 1}</span>
          <span class="r-avatar">${f.avatar ?? "🏎️"}</span>
          <span class="r-nombre">${esc(f.usuario)}<small>${f.jugadas} GP · mejor ${f.mejor}${f.ganadores ? ` · ${f.ganadores} 🥇` : ""}</small></span>
          <span class="r-barra"><i style="width:${(f.puntos / max) * 100}%"></i></span>
          <b class="r-pts">${f.puntos}</b>
        </li>`).join("")}
    </ol>`;
}

async function pintarHistorial() {
  const el = document.getElementById("q-historial");
  if (!Cuenta.sesion) {
    el.innerHTML = `<p class="texto-tenue">${CONFIG.hayCuenta()
      ? `<a href="#" onclick="Cuenta.abrirModal('registro');return false">Crea una cuenta</a> para guardar tus quinielas y entrar en el ranking.`
      : "Disponible cuando se configure la base de datos."}</p>`;
    return;
  }
  const { data } = await Cuenta.sb
    .from("quinielas").select("evento_slug, puntos, detalle, enviada_en")
    .eq("usuario_id", Cuenta.sesion.user.id).order("enviada_en", { ascending: false });

  if (!data?.length) { el.innerHTML = `<p class="texto-tenue">Aún no has jugado ninguna.</p>`; return; }

  el.innerHTML = `<div class="tabla-wrap"><table><thead><tr>
      <th>Gran Premio</th><th class="num">Exactos</th><th class="num">Puntos</th></tr></thead><tbody>
      ${data.map((q) => {
        const gp = Quiniela.gps.find((g) => g.slug === q.evento_slug);
        return `<tr>
          <td>${esc(gp?.evento ?? q.evento_slug)}${q.detalle?.ganador ? " 🥇" : ""}</td>
          <td class="num">${q.detalle?.exactos ?? "—"}</td>
          <td class="num"><b>${q.puntos ?? '<span class="texto-tenue">pendiente</span>'}</b></td></tr>`;
      }).join("")}</tbody></table></div>`;
}

/* ------------------------------ TIEMPO REAL --------------------------- */
/* Cualquier cambio en quinielas que el usuario pueda ver (RLS filtra
   tambien los eventos de Realtime) refresca el ranking. Con debounce: al
   puntuar un GP llegan decenas de updates seguidos y basta un refresco. */

function suscribir() {
  if (!Cuenta.sb || Quiniela._canal) return;
  Quiniela._canal = Cuenta.sb
    .channel("quinielas-vivo")
    .on("postgres_changes", { event: "*", schema: "public", table: "quinielas" }, () => {
      clearTimeout(Quiniela._refrescoPendiente);
      Quiniela._refrescoPendiente = setTimeout(() => {
        pintarRanking();
        pintarHistorial();
        pintarJugadores();
      }, 600);
    })
    .subscribe();
}

/* -------------------------------- ADMIN ------------------------------- */

function pintarAdmin() {
  const el = document.getElementById("q-admin");
  if (!Cuenta.esAdmin()) { el.innerHTML = ""; return; }

  const pasados = Quiniela.gps.filter((g) => new Date(`${g.fecha}T23:59:00Z`) < new Date());
  el.innerHTML = `
    <div class="tarjeta admin">
      <h2>Panel de admin <span class="etiqueta-admin">solo tú lo ves</span></h2>
      <div class="rejilla-auto">
        <div>
          <h3>1 · Calendario</h3>
          <p class="texto-tenue">Copia el calendario de la temporada a la base de datos, con la hora
             de la qualy como cierre. Hazlo una vez al empezar y si cambia alguna fecha.</p>
          <button class="accion" id="adm-sync">Sincronizar calendario</button>
        </div>
        <div>
          <h3>2 · Puntuar una carrera</h3>
          <p class="texto-tenue">Descarga el resultado oficial, lo guarda y puntúa todas las quinielas.
             Se puede repetir sin problema.</p>
          <select id="adm-gp">${pasados.map((g) => `<option value="${g.slug}" data-ronda="${g.ronda}">
             R${g.ronda} · ${esc(g.evento)}${g.disputado ? " ✔" : ""}</option>`).join("")}</select>
          <button class="accion" id="adm-puntuar" ${pasados.length ? "" : "disabled"}>Puntuar</button>
        </div>
        <div>
          <h3>3 · Cuotas manuales (BetPlay…)</h3>
          <p class="texto-tenue">Una línea por piloto: <code>Nombre; cuota</code>. Sustituye las que
             ya hubiera de esa casa.</p>
          <input type="text" id="adm-casa" value="BetPlay" placeholder="Casa">
          <textarea id="adm-cuotas" rows="5" placeholder="Kimi Antonelli; 1.35&#10;Lewis Hamilton; 5.50"></textarea>
          <button class="accion" id="adm-guardar-cuotas">Guardar cuotas</button>
        </div>
      </div>
      <p class="texto-tenue" id="adm-log"></p>
    </div>`;

  const log = (t) => { document.getElementById("adm-log").textContent = t; };

  document.getElementById("adm-sync").onclick = async () => {
    log("Descargando calendario…");
    const temporada = estado.indice?.temporadas?.at(-1) ?? new Date().getFullYear();
    const cal = await calendarioPublico(temporada);
    const { error } = await Cuenta.sb.from("grandes_premios").upsert(cal, { onConflict: "slug" });
    if (error) return log("Error: " + error.message);
    log(`✔ ${cal.length} Grandes Premios sincronizados.`);
    await cargarCalendario();
    refrescarTodo();
  };

  document.getElementById("adm-puntuar").onclick = async () => {
    const sel = document.getElementById("adm-gp");
    const slug = sel.value;
    const gp = Quiniela.gps.find((g) => g.slug === slug);
    log(`Descargando resultado de ${gp.evento}…`);

    const j = await fetch(`${CONFIG.vivo.jolpica}/${gp.temporada}/${gp.ronda}/results/?format=json`)
      .then((r) => r.json());
    const res = j.MRData?.RaceTable?.Races?.[0]?.Results ?? [];
    if (res.length < 10) return log("La API todavía no tiene el resultado de esa carrera.");

    const orden = res.slice().sort((a, b) => Number(a.position) - Number(b.position));
    const top10 = orden.slice(0, 10).map((r) => r.Driver.driverId);
    // Terminar doblado NO es abandonar: es el mismo bug de 'Lapped' que el
    // README cuenta del pipeline, y aqui daria abandonos de mas.
    const abandonos = res.filter((r) => !/^(Finished|Lapped|\+\d+ Laps?)$/.test(r.status)).length;

    const ev = await cargarJSON(`events/${slug}.json`).catch(() => null);
    const top10_modelo = ev?.prediccion
      ? ev.prediccion.slice().sort((a, b) => a.pos_predicha - b.pos_predicha).slice(0, 10).map((p) => p.driver_id)
      : null;

    const { error } = await Cuenta.sb.from("resultados_gp")
      .upsert({ evento_slug: slug, top10, abandonos, top10_modelo }, { onConflict: "evento_slug" });
    if (error) return log("Error: " + error.message);

    const { data: n, error: e2 } = await Cuenta.sb.rpc("puntuar_evento", { slug });
    if (e2) return log("Error al puntuar: " + e2.message);
    log(`✔ ${gp.evento}: ${n} quinielas puntuadas. Ganó ${orden[0].Driver.familyName}, ${abandonos} abandonos.` +
        (top10_modelo ? "" : " (No había predicción del modelo guardada para este GP.)"));
    refrescarTodo();
  };

  document.getElementById("adm-guardar-cuotas").onclick = async () => {
    const casa = document.getElementById("adm-casa").value.trim();
    const filas = document.getElementById("adm-cuotas").value.split("\n")
      .map((l) => l.split(/[;\t]/).map((x) => x.trim()))
      .filter(([n, c]) => n && Number(c.replace(",", ".")) > 1)
      .map(([seleccion, c]) => ({
        casa, mercado: "campeon_pilotos", seleccion,
        cuota: Number(c.replace(",", ".")), cargado_por: Cuenta.perfil.id,
      }));
    if (!casa || !filas.length) return log("Escribe la casa y al menos una línea «Nombre; cuota» con cuota > 1.");

    // Borrar e insertar, en vez de upsert: el indice unico lleva una
    // expresion (coalesce) y PostgREST no puede usarlo como onConflict.
    const { error: e1 } = await Cuenta.sb.from("cuotas").delete()
      .eq("casa", casa).eq("mercado", "campeon_pilotos");
    if (e1) return log("Error: " + e1.message);
    const { error: e2 } = await Cuenta.sb.from("cuotas").insert(filas);
    if (e2) return log("Error: " + e2.message);
    log(`✔ ${filas.length} cuotas de ${casa} guardadas.`);
    Vivo.traerCuotas();
  };
}

/* ------------------------------ ORQUESTA ------------------------------ */

async function seleccionarGP(slug) {
  Quiniela.slug = slug;
  Quiniela.top10 = Array(10).fill(null);
  Quiniela.abandonos = null;
  Quiniela.mia = null;

  await cargarPilotosDe(slug);

  if (Cuenta.sesion && Quiniela.calendarioBD) {
    const { data } = await Cuenta.sb.from("quinielas").select("*")
      .eq("usuario_id", Cuenta.sesion.user.id).eq("evento_slug", slug).maybeSingle();
    if (data) {
      Quiniela.mia = data;
      Quiniela.top10 = data.top10.slice();
      Quiniela.abandonos = data.abandonos;
    }
  }

  // Top 10 a medias de antes de entrar: se conserva, que no se pierda.
  const borrador = leerBorrador(slug);
  if (!Quiniela.mia && borrador) Quiniela.top10 = borrador;

  pintarHero();
  pintarJuego();
  pintarJugadores();
}

function leerBorrador(slug) {
  try { return JSON.parse(localStorage.getItem(`quiniela:${slug}`)); } catch { return null; }
}
function guardarBorrador() {
  try { localStorage.setItem(`quiniela:${Quiniela.slug}`, JSON.stringify(Quiniela.top10)); } catch { /* sin almacenamiento */ }
}

function pintarAvisoGeneral() {
  const el = document.getElementById("q-aviso");
  if (!CONFIG.hayCuenta()) {
    el.innerHTML = `<div class="aviso">Estás en <b>modo vista previa</b>: puedes montar tu top 10 y
      compararlo con el modelo, pero guardar y el ranking necesitan la base de datos. Se activa
      rellenando <code>web/js/config.js</code> (paso a paso en DEPLOY.md).</div>`;
  } else if (!Quiniela.calendarioBD) {
    el.innerHTML = `<div class="aviso">El calendario de la temporada aún no está en la base de datos.
      ${Cuenta.esAdmin() ? "Pulsa <b>Sincronizar calendario</b> en el panel de admin, abajo."
                         : "Hasta que un admin lo sincronice, las quinielas no se pueden guardar."}</div>`;
  } else {
    el.innerHTML = "";
  }
}

async function refrescarTodo() {
  pintarAvisoGeneral();
  await seleccionarGP(Quiniela.slug ?? Quiniela.gps[0]?.slug);
  pintarRanking();
  pintarHistorial();
  pintarAdmin();
}

Quiniela.iniciar = async function () {
  pintarEsqueleto();
  await cargarCalendario();

  // Por defecto, el proximo GP que siga abierto; si no, el ultimo.
  const proximo = Quiniela.gps.find((g) => abierta(g)) ?? Quiniela.gps.at(-1);
  Quiniela.slug = proximo?.slug ?? null;
  if (!Quiniela.slug) {
    document.getElementById("quiniela-raiz").innerHTML =
      `<div class="tarjeta"><p class="texto-tenue">No se pudo cargar el calendario.</p></div>`;
    return;
  }

  Cuenta.alCambiar(() => { refrescarTodo(); });
  suscribir();

  clearInterval(Quiniela._reloj);
  Quiniela._reloj = setInterval(() => { if (!document.hidden) tic(); }, 1000);
};

window.Quiniela = Quiniela;
window.calcularPuntos = calcularPuntos;
})();
