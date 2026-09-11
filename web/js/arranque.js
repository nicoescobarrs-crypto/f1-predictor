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
