/* ============================================================
   F1 Predictor — datos en vivo

   Los JSON de web/data los genera el pipeline y se actualizan cuando
   corre el workflow de GitHub. Este modulo va por delante de eso:
   consulta APIs publicas directamente desde el navegador y refresca la
   clasificacion, la plantilla y los precios del mercado sin esperar a
   ningun despliegue.

   Las tres fuentes son gratuitas, sin clave, y responden con CORS
   abierto, que es lo unico que permite llamarlas desde una web
   estatica sin backend:

     jolpi.ca      sucesor de Ergast: clasificacion y plantilla
     gamma-api     Polymarket: precios como probabilidad
     clob          Polymarket: historico de precios para las curvas

   Lo que NO se puede hacer gratis, y por tanto no se promete en
   ningun sitio de la interfaz: el cronometraje en directo durante la
   carrera. La API de la F1 no es publica.

   Todo lo de aqui degrada bien: si una fuente falla, se queda el dato
   del pipeline y se marca como "sin conexion" en vez de vaciarse.
   ============================================================ */

(function () {

const Vivo = {
  datos: {
    clasificacion: null,   // { ronda, pilotos:[], equipos:[], en:Date }
    plantilla: null,       // { pilotos:[], en:Date }
    mercado: null,         // { pilotos:{...}, equipos:{...}, en:Date }
    cuotas: null,          // cuotas de casas de apuestas
  },
  fallos: {},
  _subs: {},
  _timers: [],
  temporada: new Date().getUTCFullYear(),
};

/* --------------------------- bus de eventos --------------------------- */

Vivo.on = function (evento, fn) {
  (Vivo._subs[evento] ??= []).push(fn);
  // Si el dato ya llego antes de suscribirse, se entrega de inmediato.
  if (Vivo.datos[evento]) fn(Vivo.datos[evento]);
};

Vivo._emitir = function (evento, dato) {
  Vivo.datos[evento] = dato;
  (Vivo._subs[evento] ?? []).forEach((fn) => {
    try { fn(dato); } catch (e) { console.error(e); }
  });
};

/* ------------------------------ utilidades ---------------------------- */

async function pedirJSON(url, etiqueta) {
  const ctrl = new AbortController();
  const corte = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    delete Vivo.fallos[etiqueta];
    return await r.json();
  } catch (e) {
    Vivo.fallos[etiqueta] = e.name === "AbortError" ? "sin respuesta" : e.message;
    throw e;
  } finally {
    clearTimeout(corte);
  }
}

/** "hace 12 s", "hace 4 min". Para el sello de frescura de cada panel. */
Vivo.hace = function (fecha) {
  if (!fecha) return "—";
  const s = Math.max(0, Math.round((Date.now() - fecha.getTime()) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return `hace ${Math.round(s / 3600)} h`;
};

/* --------------------------- CLASIFICACION ---------------------------- */
/* Formato Ergast. driverId y constructorId coinciden con los que usa el
   pipeline ("antonelli", "red_bull"), asi que el cruce con nuestros datos
   es directo y no hace falta una tabla de equivalencias. */

Vivo.traerClasificacion = async function () {
  const base = `${CONFIG.vivo.jolpica}/${Vivo.temporada}`;

  const [dj, cj] = await Promise.all([
    pedirJSON(`${base}/driverstandings/?format=json&limit=100`, "clasificacion"),
    pedirJSON(`${base}/constructorstandings/?format=json&limit=100`, "clasificacion"),
  ]);

  const lp = dj.MRData?.StandingsTable?.StandingsLists?.[0];
  const le = cj.MRData?.StandingsTable?.StandingsLists?.[0];
  if (!lp) throw new Error("sin clasificación para esta temporada");

  Vivo._emitir("clasificacion", {
    ronda: Number(lp.round),
    temporada: Number(lp.season),
    pilotos: (lp.DriverStandings ?? []).map((d) => ({
      pos: Number(d.position),
      driverId: d.Driver.driverId,
      abrev: d.Driver.code ?? d.Driver.driverId.slice(0, 3).toUpperCase(),
      nombre: `${d.Driver.givenName} ${d.Driver.familyName}`,
      equipo: d.Constructors?.at(-1)?.name ?? "",
      puntos: Number(d.points),
      victorias: Number(d.wins),
    })),
    equipos: (le?.ConstructorStandings ?? []).map((c) => ({
      pos: Number(c.position),
      equipoId: c.Constructor.constructorId,
      equipo: c.Constructor.name,
      puntos: Number(c.points),
      victorias: Number(c.wins),
    })),
    en: new Date(),
  });
};

/* ----------------------------- PLANTILLA ------------------------------ */
/* "Quien corre esta temporada y con quien". Ergast no da el equipo dentro
   de /drivers, asi que se saca de la clasificacion, que si lo trae. */

Vivo.traerPlantilla = async function () {
  if (!Vivo.datos.clasificacion) await Vivo.traerClasificacion();
  const cl = Vivo.datos.clasificacion;

  const j = await pedirJSON(
    `${CONFIG.vivo.jolpica}/${Vivo.temporada}/drivers/?format=json&limit=100`,
    "plantilla"
  );

  const porEquipo = new Map();
  for (const d of (j.MRData?.DriverTable?.Drivers ?? [])) {
    const enTabla = cl.pilotos.find((p) => p.driverId === d.driverId);
    // Sin fila en la clasificacion es un piloto que aun no ha corrido: no
    // se sabe de que equipo es, asi que no se inventa.
    if (!enTabla) continue;

    const piloto = {
      driverId: d.driverId,
      abrev: d.code ?? enTabla.abrev,
      nombre: `${d.givenName} ${d.familyName}`,
      dorsal: d.permanentNumber ? Number(d.permanentNumber) : null,
      nacionalidad: d.nationality,
      wiki: d.url,
      puntos: enTabla.puntos,
      pos: enTabla.pos,
      equipo: enTabla.equipo,
    };
    if (!porEquipo.has(piloto.equipo)) porEquipo.set(piloto.equipo, []);
    porEquipo.get(piloto.equipo).push(piloto);
  }

  const equipos = [...porEquipo.entries()]
    .map(([equipo, pilotos]) => ({
      equipo,
      pilotos: pilotos.sort((a, b) => a.pos - b.pos),
      puntos: cl.equipos.find((e) => e.equipo === equipo)?.puntos ?? 0,
      pos: cl.equipos.find((e) => e.equipo === equipo)?.pos ?? 99,
    }))
    .sort((a, b) => a.pos - b.pos);

  Vivo._emitir("plantilla", { equipos, temporada: cl.temporada, en: new Date() });
};

/* ------------------------------ MERCADO ------------------------------- */
/* Un contrato de Polymarket paga 1 dolar si el suceso ocurre, asi que su
   precio ES la probabilidad. La suma de precios de un mercado no da 1: esa
   diferencia es el margen, y se reparte antes de comparar con el modelo. */

function precioDe(m) {
  try {
    const p = JSON.parse(m.outcomePrices || "[]");
    return p.length ? Number(p[0]) : null;
  } catch { return null; }
}

async function traerEvento(slug) {
  const j = await pedirJSON(
    `${CONFIG.vivo.polymarket}/events?closed=false&limit=1&slug=${encodeURIComponent(slug)}`,
    "mercado"
  );
  const ev = Array.isArray(j) ? j[0] : null;
  if (!ev) return null;

  const opciones = (ev.markets ?? [])
    .map((m) => {
      const precio = precioDe(m);
      const nombre = (m.groupItemTitle || m.question || "").trim();
      if (precio == null || !nombre) return null;
      const bid = Number(m.bestBid), ask = Number(m.bestAsk);
      return {
        nombre,
        precio,
        // Cuanto se ha movido en 24 h: es lo que convierte una tabla en algo vivo.
        cambio24h: m.oneDayPriceChange != null ? Number(m.oneDayPriceChange) : null,
        // La horquilla compra/venta mide cuanta confianza hay: estrecha =
        // mercado liquido y con opinion firme; ancha = poco dinero.
        horquilla: Number.isFinite(bid) && Number.isFinite(ask) ? ask - bid : null,
        volumen: Number(m.volume) || 0,
        // Hace falta para pedir el historico de precios.
        tokenId: (() => { try { return JSON.parse(m.clobTokenIds || "[]")[0] ?? null; } catch { return null; } })(),
      };
    })
    .filter(Boolean);

  const bruto = opciones.reduce((s, o) => s + o.precio, 0);
  opciones.forEach((o) => { o.prob = bruto > 0 ? o.precio / bruto : 0; });
  opciones.sort((a, b) => b.prob - a.prob);

  return {
    titulo: ev.title,
    slug: ev.slug,
    cierra: String(ev.endDate || "").slice(0, 10),
    volumen: Number(ev.volume) || 0,
    liquidez: Number(ev.liquidity) || 0,
    // Cuanto se aleja de 1 la suma de precios: el margen del mercado.
    margen: bruto - 1,
    opciones,
  };
}

Vivo.traerMercado = async function (slugs) {
  const s = slugs ?? Vivo._slugs ?? {};
  if (!s.pilotos && !s.equipos) return;

  const [pilotos, equipos] = await Promise.all([
    s.pilotos ? traerEvento(s.pilotos).catch(() => null) : null,
    s.equipos ? traerEvento(s.equipos).catch(() => null) : null,
  ]);
  if (!pilotos && !equipos) throw new Error("Polymarket no respondió");

  Vivo._emitir("mercado", { pilotos, equipos, en: new Date() });
};

/** Serie temporal de precios de una opcion, para dibujar su evolucion. */
Vivo.historial = async function (tokenId, intervalo = "1m", fidelidad = 180) {
  if (!tokenId) return [];
  const j = await pedirJSON(
    `https://clob.polymarket.com/prices-history?market=${tokenId}` +
    `&interval=${intervalo}&fidelity=${fidelidad}`,
    "historial"
  );
  return (j.history ?? []).map((p) => ({ t: p.t * 1000, p: Number(p.p) }));
};

/* --------------------- CUOTAS DE CASAS DE APUESTAS -------------------- */
/* Dos origenes, y se muestran juntos:
     - The Odds API, si hay clave configurada
     - la tabla 'cuotas' de Supabase, que es donde entran a mano las casas
       sin API abierta (BetPlay es el caso que motiva esto)

   Una cuota decimal se convierte en probabilidad con 1/cuota. La suma de
   1/cuota de todas las selecciones pasa de 1, y ese exceso es el margen de
   la casa: hay que quitarlo antes de comparar con el modelo, o la casa
   parecera mas optimista que nadie con todo el mundo a la vez. */

Vivo.traerCuotas = async function () {
  const casas = [];

  if (CONFIG.hayCuotas()) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${CONFIG.oddsApi.deporte}` +
                  `/odds/?apiKey=${encodeURIComponent(CONFIG.oddsApi.clave)}` +
                  `&regions=${CONFIG.oddsApi.regiones}&markets=outrights&oddsFormat=decimal`;
      const j = await pedirJSON(url, "cuotas");
      for (const ev of (Array.isArray(j) ? j : [])) {
        for (const b of (ev.bookmakers ?? [])) {
          const mk = (b.markets ?? []).find((m) => m.key === "outrights");
          if (!mk?.outcomes?.length) continue;
          casas.push({
            casa: b.title,
            origen: "The Odds API",
            actualizado: b.last_update ? new Date(b.last_update) : null,
            selecciones: mk.outcomes.map((o) => ({ nombre: o.name, cuota: Number(o.price) })),
          });
        }
      }
    } catch (e) {
      console.warn("The Odds API:", e.message);
    }
  }

  // Cuotas cargadas a mano. Es lo que cubre BetPlay, que no tiene API publica.
  if (Cuenta?.sb) {
    try {
      const { data } = await Cuenta.sb
        .from("cuotas").select("casa, seleccion, cuota, actualizado")
        .eq("mercado", "campeon_pilotos");

      const porCasa = new Map();
      for (const f of (data ?? [])) {
        if (!porCasa.has(f.casa)) {
          porCasa.set(f.casa, {
            casa: f.casa, origen: "cargada a mano",
            actualizado: f.actualizado ? new Date(f.actualizado) : null,
            selecciones: [],
          });
        }
        porCasa.get(f.casa).selecciones.push({ nombre: f.seleccion, cuota: Number(f.cuota) });
      }
      casas.push(...porCasa.values());
    } catch (e) {
      console.warn("Cuotas manuales:", e.message);
    }
  }

  // Probabilidad implicita, y la misma sin el margen de la casa.
  for (const c of casas) {
    const bruto = c.selecciones.reduce((s, o) => s + 1 / o.cuota, 0);
    c.margen = bruto - 1;
    c.selecciones.forEach((o) => {
      o.implicita = 1 / o.cuota;
      o.prob = bruto > 0 ? o.implicita / bruto : 0;
    });
    c.selecciones.sort((a, b) => b.prob - a.prob);
  }

  Vivo._emitir("cuotas", { casas, en: new Date() });
};

/* ------------------------------ ARRANQUE ------------------------------ */

function repetir(fn, segundos, etiqueta) {
  const paso = async () => {
    // Con la pestana en segundo plano no se refresca: ni peticiones ni bateria
    // para algo que nadie esta mirando. Al volver se pide de inmediato.
    if (CONFIG.vivo.pausarOculto && document.hidden) return;
    try { await fn(); } catch (e) { console.warn(`${etiqueta}:`, e.message); }
    finally { Vivo._emitir("latido", { etiqueta, en: new Date() }); }
  };
  paso();
  Vivo._timers.push(setInterval(paso, segundos * 1000));
  return paso;
}

Vivo.arrancar = function ({ temporada, slugs } = {}) {
  if (temporada) Vivo.temporada = temporada;
  Vivo._slugs = slugs ?? {};

  const refrescos = [
    repetir(async () => { await Vivo.traerClasificacion(); await Vivo.traerPlantilla(); },
      CONFIG.vivo.refrescoClasificacion, "clasificación"),
    repetir(() => Vivo.traerMercado(), CONFIG.vivo.refrescoMercado, "mercado"),
  ];

  Vivo.traerCuotas().catch((e) => console.warn("cuotas:", e.message));

  // Al volver a la pestana, refresco inmediato: si no, el usuario ve datos
  // de hace media hora hasta que toque el siguiente intervalo.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refrescos.forEach((f) => f());
  });
};

Vivo.parar = function () {
  Vivo._timers.forEach(clearInterval);
  Vivo._timers = [];
};

window.Vivo = Vivo;
})();
