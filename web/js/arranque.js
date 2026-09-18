/* ============================================================
   F1 Predictor — arranque de los modulos nuevos

   app.js carga los JSON y lanza "datos-listos". A partir de ahi se
   encienden, en este orden:

     3D de la cabecera   no depende de nada mas
     Cuentas             la quiniela y las cuotas manuales la necesitan
     Datos en vivo       clasificacion, plantilla, mercado, cuotas
     Quiniela            necesita cuentas y calendario

   Cada paso va en su propio try: si uno falla, los demas siguen.
   ============================================================ */

window.addEventListener("datos-listos", async () => {
  const intentar = async (nombre, fn) => {
    try { await fn(); } catch (e) { console.error(`[${nombre}]`, e); }
  };

  await intentar("3D", () => Escena3D.cabecera(document.getElementById("escena-cabecera")));
  await intentar("cuentas", () => Cuenta.iniciar());
  await intentar("vivo", () => PanelesVivo.iniciar());
  await intentar("quiniela", () => Quiniela.iniciar());

  Escena3D.activarTilt?.();
});

/* ------------------------- aviso de datos nuevos --------------------- */
/* La pagina lee los JSON una sola vez, al cargar. Si alguien la deja
   abierta varios dias, sigue ensenando la carrera de entonces aunque el
   workflow del lunes ya haya publicado la nueva. Cada 10 minutos (y al
   volver a la pestana) se mira si index.json cambio, y si es asi se
   ofrece recargar. */

(function () {
  let avisado = false;

  const comprobar = async () => {
    // estado es un const de app.js: existe como global, pero NO como window.estado.
    if (avisado || document.hidden || typeof estado === "undefined" || !estado.indice) return;
    try {
      const r = await fetch(`data/index.json?t=${Date.now()}`, { cache: "no-store" });
      const nuevo = await r.json();
      if (nuevo.generado && nuevo.generado !== estado.indice.generado) mostrar(nuevo);
    } catch { /* sin red: ya se comprobara en la siguiente vuelta */ }
  };

  const mostrar = (nuevo) => {
    avisado = true;
    const el = document.createElement("div");
    el.className = "aviso-datos";
    el.setAttribute("role", "status");
    el.innerHTML = `<span>Hay datos nuevos: ya está <b>${nuevo.ultima_carrera?.evento ?? "la última carrera"}</b>.</span>
                    <button class="accion">Actualizar</button>`;
    el.querySelector("button").onclick = () => location.reload();
    document.body.appendChild(el);
  };

  setInterval(comprobar, 10 * 60 * 1000);
  document.addEventListener("visibilitychange", comprobar);
})();

/* ------------------------ pestanas con enlace ------------------------ */
/* /#quiniela abre directamente esa pestana. Sirve para compartir el
   enlace de la quiniela por WhatsApp sin explicar donde hay que pulsar. */

(function () {
  const tabs = document.getElementById("tabs");
  if (!tabs) return;

  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-panel]");
    if (b) history.replaceState(null, "", `#${b.dataset.panel}`);
  });

  const abrirHash = () => {
    const id = location.hash.slice(1);
    const b = id && tabs.querySelector(`button[data-panel="${CSS.escape(id)}"]`);
    if (b) b.click();
  };
  window.addEventListener("hashchange", abrirHash);
  document.addEventListener("DOMContentLoaded", abrirHash);
})();
