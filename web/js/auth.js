/* ============================================================
   F1 Predictor — cuentas de usuario (Supabase Auth + PostgreSQL)

   Todo lo de aqui es opcional. Si CONFIG.supabase esta vacio, la web
   entera sigue funcionando: se oculta el boton de la cabecera y la
   pestana Quiniela explica que falta configurarlo, en vez de romperse.

   La clave anon esta a la vista en el codigo publicado, y es correcto
   que asi sea. Quien protege los datos son las politicas RLS de
   sql/schema.sql, que corren en el servidor de Postgres: da igual lo
   que haga alguien desde la consola del navegador.
   ============================================================ */

(function () {

const Cuenta = {
  sb: null,          // cliente de Supabase
  sesion: null,      // sesion de auth, o null
  perfil: null,      // fila de public.perfiles del usuario
  listeners: [],     // a quien avisar cuando cambia la sesion
};

/** Se suscribe a los cambios de sesion. Se llama al entrar y al salir. */
Cuenta.alCambiar = function (fn) {
  Cuenta.listeners.push(fn);
  // Se le da el estado actual de inmediato, para que no tenga que
  // duplicar el render inicial.
  fn(Cuenta.sesion, Cuenta.perfil);
};

Cuenta._avisar = function () {
  Cuenta.listeners.forEach((fn) => {
    try { fn(Cuenta.sesion, Cuenta.perfil); } catch (e) { console.error(e); }
  });
};

/* ------------------------------ ARRANQUE ------------------------------ */

Cuenta.iniciar = async function () {
  if (!CONFIG.hayCuenta()) {
    document.body.classList.add("sin-cuentas");
    return false;
  }

  if (typeof window.supabase?.createClient !== "function") {
    console.warn("supabase-js no se cargó; las cuentas quedan desactivadas.");
    document.body.classList.add("sin-cuentas");
    return false;
  }

  Cuenta.sb = window.supabase.createClient(
    CONFIG.supabase.url,
    CONFIG.supabase.anon,
    { auth: { persistSession: true, autoRefreshToken: true } }
  );

  const { data } = await Cuenta.sb.auth.getSession();
  Cuenta.sesion = data.session ?? null;
  if (Cuenta.sesion) await Cuenta._cargarPerfil();

  Cuenta.sb.auth.onAuthStateChange(async (_evento, sesion) => {
    Cuenta.sesion = sesion ?? null;
    Cuenta.perfil = null;
    if (sesion) await Cuenta._cargarPerfil();
    Cuenta._pintarCabecera();
    Cuenta._avisar();
  });

  Cuenta._montarUI();
  Cuenta._pintarCabecera();
  return true;
};

Cuenta._cargarPerfil = async function () {
  const { data, error } = await Cuenta.sb
    .from("perfiles")
    .select("id, usuario, nombre, avatar, equipo_fav, rol")
    .eq("id", Cuenta.sesion.user.id)
    .maybeSingle();

  if (error) { console.warn("No se pudo leer el perfil:", error.message); return; }

  // El perfil lo crea un trigger en la misma transaccion que el alta, pero
  // si alguien creo el usuario antes de instalar el trigger, no existe.
  if (!data) {
    const nick = "piloto" + Cuenta.sesion.user.id.slice(0, 6);
    await Cuenta.sb.from("perfiles").insert({ id: Cuenta.sesion.user.id, usuario: nick });
    Cuenta.perfil = { id: Cuenta.sesion.user.id, usuario: nick, avatar: "🏎️", rol: "usuario" };
    return;
  }
  Cuenta.perfil = data;
};

Cuenta.esAdmin = () => Cuenta.perfil?.rol === "admin";

/* ------------------------------ ACCIONES ------------------------------ */

Cuenta.registrar = async function (correo, clave, usuario) {
  const { data, error } = await Cuenta.sb.auth.signUp({
    email: correo,
    password: clave,
    // Lo lee el trigger crear_perfil() para poner el nick que eligio.
    options: { data: { usuario } },
  });
  if (error) throw new Error(traducirError(error.message));

  // Si el proyecto tiene la confirmacion por correo activada (viene asi de
  // fabrica), no hay sesion hasta que pulse el enlace.
  return { confirmar: !data.session };
};

Cuenta.entrar = async function (correo, clave) {
  const { error } = await Cuenta.sb.auth.signInWithPassword({
    email: correo, password: clave,
  });
  if (error) throw new Error(traducirError(error.message));
};

Cuenta.salir = async function () {
  await Cuenta.sb.auth.signOut();
};

Cuenta.recuperar = async function (correo) {
  const { error } = await Cuenta.sb.auth.resetPasswordForEmail(correo, {
    redirectTo: window.location.origin,
  });
  if (error) throw new Error(traducirError(error.message));
};

Cuenta.guardarPerfil = async function (cambios) {
  const { data, error } = await Cuenta.sb
    .from("perfiles")
    .update(cambios)
    .eq("id", Cuenta.perfil.id)
    .select()
    .single();
  if (error) throw new Error(traducirError(error.message));
  Cuenta.perfil = data;
  Cuenta._pintarCabecera();
  Cuenta._avisar();
};

/** Los mensajes de Supabase llegan en ingles y son poco claros. */
function traducirError(msg) {
  const m = String(msg).toLowerCase();
  if (m.includes("invalid login")) return "Correo o contraseña incorrectos.";
  if (m.includes("already registered")) return "Ese correo ya tiene cuenta. Entra en vez de registrarte.";
  if (m.includes("duplicate key") && m.includes("usuario")) return "Ese nombre de usuario ya está cogido.";
  if (m.includes("password should be")) return "La contraseña necesita al menos 6 caracteres.";
  if (m.includes("email rate limit")) return "Demasiados intentos. Espera un minuto.";
  if (m.includes("row-level security") || m.includes("violates row-level")) {
    return "El plazo para esta carrera ya cerró.";
  }
  if (m.includes("usuario_check")) return "El usuario solo admite letras, números y _ (3–20 caracteres).";
  return msg;
}

/* ------------------------------ CABECERA ------------------------------ */

Cuenta._pintarCabecera = function () {
  const cont = document.getElementById("caja-cuenta");
  if (!cont) return;

  if (!Cuenta.sesion) {
    cont.innerHTML = `<button class="accion" id="btn-entrar">Entrar</button>`;
    document.getElementById("btn-entrar").onclick = () => Cuenta.abrirModal("entrar");
    return;
  }

  const p = Cuenta.perfil ?? {};
  cont.innerHTML = `
    <button class="chip-usuario" id="btn-perfil" title="Tu perfil">
      <span class="avatar">${p.avatar || "🏎️"}</span>
      <span class="nick">${escapeHTML(p.usuario || "…")}</span>
      ${p.rol === "admin" ? '<span class="etiqueta-admin">admin</span>' : ""}
    </button>
    <button class="accion secundaria" id="btn-salir">Salir</button>`;

  document.getElementById("btn-perfil").onclick = () => Cuenta.abrirModal("perfil");
  document.getElementById("btn-salir").onclick = () => Cuenta.salir();
};

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* -------------------------------- MODAL ------------------------------- */

Cuenta._montarUI = function () {
  if (document.getElementById("modal-cuenta")) return;

  const el = document.createElement("div");
  el.id = "modal-cuenta";
  el.className = "modal";
  el.hidden = true;
  el.innerHTML = `
    <div class="modal-fondo" data-cerrar></div>
    <div class="modal-caja" role="dialog" aria-modal="true" aria-labelledby="modal-titulo">
      <button class="modal-cerrar" data-cerrar aria-label="Cerrar">&times;</button>
      <h2 id="modal-titulo"></h2>
      <div id="modal-cuerpo"></div>
      <p class="modal-error" id="modal-error" hidden></p>
    </div>`;
  document.body.appendChild(el);

  el.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-cerrar")) Cuenta.cerrarModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.hidden) Cuenta.cerrarModal();
  });
};

Cuenta.cerrarModal = function () {
  const el = document.getElementById("modal-cuenta");
  if (el) el.hidden = true;
};

Cuenta._error = function (msg) {
  const p = document.getElementById("modal-error");
  p.textContent = msg;
  p.hidden = !msg;
};

Cuenta.abrirModal = function (vista) {
  Cuenta._montarUI();
  const el = document.getElementById("modal-cuenta");
  el.hidden = false;
  Cuenta._error("");
  ({ entrar: pintarEntrar, registro: pintarRegistro, perfil: pintarPerfil }[vista] ?? pintarEntrar)();
};

function pintarEntrar() {
  document.getElementById("modal-titulo").textContent = "Entrar";
  document.getElementById("modal-cuerpo").innerHTML = `
    <form id="form-auth" class="form-vertical">
      <label class="campo">Correo
        <input type="email" name="correo" required autocomplete="email" placeholder="tu@correo.com">
      </label>
      <label class="campo">Contraseña
        <input type="password" name="clave" required autocomplete="current-password" minlength="6">
      </label>
      <button class="accion grande" type="submit">Entrar</button>
    </form>
    <p class="modal-pie">
      ¿No tienes cuenta? <a href="#" id="ir-registro">Regístrate</a> ·
      <a href="#" id="ir-recuperar">He olvidado la contraseña</a>
    </p>`;

  document.getElementById("ir-registro").onclick = (e) => { e.preventDefault(); pintarRegistro(); };
  document.getElementById("ir-recuperar").onclick = async (e) => {
    e.preventDefault();
    const correo = document.querySelector("#form-auth [name=correo]").value.trim();
    if (!correo) return Cuenta._error("Escribe primero tu correo arriba.");
    try {
      await Cuenta.recuperar(correo);
      Cuenta._error("Te hemos enviado un enlace para cambiarla.");
    } catch (err) { Cuenta._error(err.message); }
  };

  enviarForm(async (f) => {
    await Cuenta.entrar(f.correo.value.trim(), f.clave.value);
    Cuenta.cerrarModal();
  });
}

function pintarRegistro() {
  document.getElementById("modal-titulo").textContent = "Crear cuenta";
  document.getElementById("modal-cuerpo").innerHTML = `
    <form id="form-auth" class="form-vertical">
      <label class="campo">Nombre de usuario
        <input type="text" name="usuario" required minlength="3" maxlength="20"
               pattern="[a-zA-Z0-9_]+" placeholder="ferrari_fan"
               title="Letras, números y guion bajo. Entre 3 y 20 caracteres.">
      </label>
      <label class="campo">Correo
        <input type="email" name="correo" required autocomplete="email">
      </label>
      <label class="campo">Contraseña
        <input type="password" name="clave" required minlength="6" autocomplete="new-password">
      </label>
      <button class="accion grande" type="submit">Crear cuenta</button>
    </form>
    <p class="modal-pie">¿Ya tienes una? <a href="#" id="ir-entrar">Entrar</a></p>`;

  document.getElementById("ir-entrar").onclick = (e) => { e.preventDefault(); pintarEntrar(); };

  enviarForm(async (f) => {
    const { confirmar } = await Cuenta.registrar(
      f.correo.value.trim(), f.clave.value, f.usuario.value.trim()
    );
    if (confirmar) {
      document.getElementById("modal-cuerpo").innerHTML =
        `<p class="ok-grande">Revisa tu correo</p>
         <p class="texto-tenue">Te hemos mandado un enlace de confirmación.
         Al pulsarlo, vuelve aquí y entra con tu contraseña.</p>`;
    } else {
      Cuenta.cerrarModal();
    }
  });
}

const AVATARES = ["🏎️", "🏁", "🏆", "🥇", "⚡", "🔥", "🦁", "🐂", "🐎", "🦅", "🛞", "🧯"];

function pintarPerfil() {
  const p = Cuenta.perfil ?? {};
  document.getElementById("modal-titulo").textContent = "Tu perfil";
  document.getElementById("modal-cuerpo").innerHTML = `
    <form id="form-auth" class="form-vertical">
      <label class="campo">Nombre de usuario
        <input type="text" name="usuario" required minlength="3" maxlength="20"
               pattern="[a-zA-Z0-9_]+" value="${escapeHTML(p.usuario || "")}">
      </label>
      <label class="campo">Nombre visible (opcional)
        <input type="text" name="nombre" maxlength="60" value="${escapeHTML(p.nombre || "")}">
      </label>
      <label class="campo">Escudería favorita
        <input type="text" name="equipo_fav" maxlength="40" value="${escapeHTML(p.equipo_fav || "")}"
               placeholder="Ferrari, McLaren…">
      </label>
      <fieldset class="campo">
        <legend>Avatar</legend>
        <div class="rejilla-avatares">
          ${AVATARES.map((a) => `
            <label class="avatar-opcion">
              <input type="radio" name="avatar" value="${a}" ${a === p.avatar ? "checked" : ""}>
              <span>${a}</span>
            </label>`).join("")}
        </div>
      </fieldset>
      <button class="accion grande" type="submit">Guardar</button>
    </form>`;

  enviarForm(async (f) => {
    await Cuenta.guardarPerfil({
      usuario: f.usuario.value.trim(),
      nombre: f.nombre.value.trim() || null,
      equipo_fav: f.equipo_fav.value.trim() || null,
      avatar: f.avatar.value,
    });
    Cuenta.cerrarModal();
  });
}

/** Envoltorio comun: bloquea el boton, muestra el error y no recarga la pagina. */
function enviarForm(accion) {
  const form = document.getElementById("form-auth");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    const txt = btn.textContent;
    btn.disabled = true;
    btn.textContent = "…";
    Cuenta._error("");
    try {
      await accion(form.elements);
    } catch (err) {
      Cuenta._error(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = txt;
    }
  });
}

window.Cuenta = Cuenta;
window.traducirError = traducirError;
})();
