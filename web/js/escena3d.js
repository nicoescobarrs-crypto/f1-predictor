/* ============================================================
   F1 Predictor — 3D con Three.js

   Dos escenas y un efecto:
     cabecera()  circuito luminoso con coches recorriendolo
     podio()     podio con los tres primeros, que se puede girar
     activarTilt()  inclinacion 3D de tarjetas al pasar el raton (CSS)

   El 3D es decoracion: si no hay WebGL, si el sistema pide menos
   animacion o si Three.js no cargo, no se pinta y la pagina queda
   exactamente igual de usable. Nada importante vive solo aqui.

   Rendimiento: cada escena deja de renderizar cuando sale de
   pantalla o la pestana se oculta. Sin eso, un canvas animado
   gasta GPU y bateria aunque nadie lo este mirando.
   ============================================================ */

(function () {

const Escena3D = {};

const MENOS_MOVIMIENTO = matchMedia("(prefers-reduced-motion: reduce)").matches;

function hayWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch { return false; }
}

Escena3D.disponible = () =>
  CONFIG.tresD.activo && typeof THREE !== "undefined" && hayWebGL() && !MENOS_MOVIMIENTO;

/** Bucle de render que se pausa fuera de pantalla y con la pestana oculta. */
function bucle(canvas, frame) {
  let visible = true, id = null;
  const tick = (t) => { frame(t); id = requestAnimationFrame(tick); };
  const arrancar = () => { if (id == null && visible && !document.hidden) id = requestAnimationFrame(tick); };
  const parar = () => { if (id != null) cancelAnimationFrame(id); id = null; };

  new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? arrancar() : parar(); })
    .observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? parar() : arrancar()));
  arrancar();
}

function ajustar(renderer, camara, el) {
  const w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camara.aspect = w / h;
  camara.updateProjectionMatrix();
}

/* ------------------------- un coche de F1 low-poly ---------------------- */
/* Hecho de cajas y cilindros: pesa nada y a esta distancia se lee como
   un monoplaza. El color es el de la escuderia. */
function coche(color) {
  const g = new THREE.Group();
  const carroceria = new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.3 });
  const negro = new THREE.MeshStandardMaterial({ color: 0x111116, metalness: 0.2, roughness: 0.8 });

  const cuerpo = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.22, 0.42), carroceria);
  cuerpo.position.y = 0.2;
  g.add(cuerpo);

  const morro = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.9, 4), carroceria);
  morro.rotation.z = -Math.PI / 2;
  morro.rotation.x = Math.PI / 4;
  morro.position.set(1.35, 0.17, 0);
  g.add(morro);

  const pontones = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.2, 0.8), carroceria);
  pontones.position.set(-0.1, 0.2, 0);
  g.add(pontones);

  const cabina = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.18, 0.28), negro);
  cabina.position.set(0.15, 0.38, 0);
  g.add(cabina);

  const aleronDel = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 1.2), carroceria);
  aleronDel.position.set(1.72, 0.08, 0);
  g.add(aleronDel);

  const aleronTras = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 0.95), carroceria);
  aleronTras.position.set(-1.0, 0.52, 0);
  g.add(aleronTras);

  const rueda = new THREE.CylinderGeometry(0.2, 0.2, 0.2, 14);
  rueda.rotateX(Math.PI / 2);
  [[0.95, 0.52], [0.95, -0.52], [-0.75, 0.55], [-0.75, -0.55]].forEach(([x, z]) => {
    const r = new THREE.Mesh(rueda, negro);
    r.position.set(x, 0.2, z);
    g.add(r);
  });

  return g;
}

/* =============================== CABECERA ============================ */

Escena3D.cabecera = function (canvas) {
  if (!canvas || !Escena3D.disponible()) {
    document.body.classList.add("sin-3d");
    return;
  }
  const ligera = window.innerWidth < CONFIG.tresD.anchoMinimo;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !ligera, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, ligera ? 1 : 1.75));

  const escena = new THREE.Scene();
  escena.fog = new THREE.Fog(0x0b0b12, 18, 46);
  const camara = new THREE.PerspectiveCamera(42, 2, 0.1, 100);
  camara.position.set(0, 13, 22);
  camara.lookAt(0, 0, 0);

  escena.add(new THREE.AmbientLight(0xffffff, 0.35));
  const clave = new THREE.DirectionalLight(0xffffff, 1.2);
  clave.position.set(6, 12, 8);
  escena.add(clave);
  const roja = new THREE.PointLight(0xe10600, 30, 30);
  roja.position.set(0, 4, 0);
  escena.add(roja);

  // Trazado inventado con forma de circuito: rectas, horquilla y chicane.
  const puntos = [
    [-11, 0], [-4, -1], [4, -1.5], [10, -3], [12, 0], [10, 3.5], [5, 3],
    [2, 5.5], [-2, 5], [-4, 2.5], [-8, 4.5], [-12, 3],
  ].map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curva = new THREE.CatmullRomCurve3(puntos, true, "catmullrom", 0.35);

  const asfalto = new THREE.Mesh(
    new THREE.TubeGeometry(curva, 260, 0.55, 8, true),
    new THREE.MeshStandardMaterial({ color: 0x1b1b24, roughness: 0.9 })
  );
  asfalto.scale.y = 0.12;
  escena.add(asfalto);

  // El borde luminoso: lo que hace que se lea como circuito a lo lejos.
  const brillo = new THREE.Mesh(
    new THREE.TubeGeometry(curva, 260, 0.06, 6, true),
    new THREE.MeshBasicMaterial({ color: 0xff2d26 })
  );
  brillo.position.y = 0.12;
  escena.add(brillo);

  // Suelo de rejilla, con el tono de la marca.
  const rejilla = new THREE.GridHelper(80, 60, 0x3a1515, 0x1c1c28);
  rejilla.position.y = -0.1;
  escena.add(rejilla);

  // Coches: los colores de los equipos que van delante en el campeonato.
  const colores = (estado.clasificacion?.pilotos ?? []).slice(0, ligera ? 3 : 6)
    .map((p) => colorEquipo(p.equipo));
  if (!colores.length) colores.push("#27F4D2", "#E8002D", "#FF8000");
  const coches = colores.map((c, i) => {
    const m = coche(new THREE.Color(c));
    m.scale.setScalar(0.55);
    escena.add(m);
    return { m, t: i * 0.035, v: 0.045 - i * 0.0018 };
  });

  // Particulas: polvo luminoso que da sensacion de velocidad.
  const n = ligera ? 150 : 500;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 60;
    pos[i * 3 + 1] = Math.random() * 12;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 40;
  }
  const geoP = new THREE.BufferGeometry();
  geoP.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const polvo = new THREE.Points(geoP, new THREE.PointsMaterial({
    color: 0xff5a4f, size: 0.07, transparent: true, opacity: 0.6,
  }));
  escena.add(polvo);

  // El raton inclina ligeramente la camara: parallax.
  const raton = { x: 0, y: 0 };
  window.addEventListener("pointermove", (e) => {
    raton.x = e.clientX / window.innerWidth - 0.5;
    raton.y = e.clientY / window.innerHeight - 0.5;
  }, { passive: true });

  const el = canvas.parentElement;
  ajustar(renderer, camara, el);
  new ResizeObserver(() => ajustar(renderer, camara, el)).observe(el);

  const reloj = new THREE.Clock();
  const tangente = new THREE.Vector3();
  bucle(canvas, () => {
    const dt = Math.min(reloj.getDelta(), 0.05);
    const t = reloj.elapsedTime;

    coches.forEach((c) => {
      c.t = (c.t + c.v * dt) % 1;
      const p = curva.getPointAt(c.t);
      curva.getTangentAt(c.t, tangente);
      c.m.position.set(p.x, 0.08, p.z);
      c.m.rotation.y = Math.atan2(-tangente.z, tangente.x);
    });

    polvo.rotation.y = t * 0.02;
    roja.intensity = 25 + Math.sin(t * 2) * 6;
    escena.rotation.y = Math.sin(t * 0.08) * 0.25;

    camara.position.x += (raton.x * 6 - camara.position.x) * 0.03;
    camara.position.y += (13 - raton.y * 4 - camara.position.y) * 0.03;
    camara.lookAt(0, 0, 1);

    renderer.render(escena, camara);
  });
};

/* ================================ PODIO ============================== */
/* Se llama cada vez que llegan datos nuevos. La escena se crea una sola
   vez; las siguientes llamadas solo actualizan colores, alturas y
   etiquetas, sin reconstruir nada. */

const podios = new WeakMap();

Escena3D.podio = function (cont, top3) {
  if (!cont || !top3?.length) return;

  // Etiquetas HTML encima del canvas: mas nitidas que texto en 3D.
  const orden = [1, 0, 2];   // plata, oro, bronce, de izquierda a derecha
  let et = cont.querySelector(".podio-etiquetas");
  if (!et) {
    et = document.createElement("div");
    et.className = "podio-etiquetas";
    cont.appendChild(et);
  }
  et.innerHTML = orden.map((i) => top3[i] ? `
    <div class="podio-et p${i + 1}">
      <span class="pe-pos">${i + 1}</span>
      <b>${escapar(top3[i].nombre.split(" ").at(-1))}</b>
      <span class="pe-val">${(top3[i].valor * 100).toFixed(1)}%</span>
    </div>` : "<div></div>").join("");

  if (!Escena3D.disponible()) { cont.classList.add("podio-plano"); return; }

  let s = podios.get(cont);
  if (!s) s = crearPodio(cont);
  if (!s) return;

  const max = Math.max(...top3.map((x) => x.valor), 0.01);
  orden.forEach((i, col) => {
    const d = top3[i];
    const bloque = s.bloques[col];
    if (!d) { bloque.visible = false; return; }
    // Altura fija por puesto (es un podio) mas un extra por probabilidad.
    const alto = [2.2, 1.6, 1.2][i] + (d.valor / max) * 0.8;
    bloque.userData.objetivo = alto;
    s.coches[col].children.forEach((m) => {
      if (m.material?.metalness > 0.5) m.material.color.set(d.color);
    });
  });
};

function crearPodio(cont) {
  const canvas = document.createElement("canvas");
  canvas.className = "podio-canvas";
  cont.prepend(canvas);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch { return null; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));

  const escena = new THREE.Scene();
  const camara = new THREE.PerspectiveCamera(38, 2, 0.1, 100);
  camara.position.set(0, 4.6, 9.5);
  camara.lookAt(0, 1.4, 0);

  escena.add(new THREE.AmbientLight(0xffffff, 0.45));
  const foco = new THREE.SpotLight(0xffffff, 60, 30, Math.PI / 5, 0.5);
  foco.position.set(0, 10, 4);
  escena.add(foco);
  const roja = new THREE.PointLight(0xe10600, 12, 20);
  roja.position.set(-4, 3, 3);
  escena.add(roja);

  const grupo = new THREE.Group();
  escena.add(grupo);

  const metales = [0xc0c4cc, 0xd4af37, 0xb06a3b];   // plata, oro, bronce
  const bloques = [], coches = [];
  [-2.3, 0, 2.3].forEach((x, col) => {
    const b = new THREE.Mesh(
      new THREE.BoxGeometry(2.1, 1, 2.1),
      new THREE.MeshStandardMaterial({ color: 0x20202c, metalness: 0.3, roughness: 0.5 })
    );
    b.position.x = x;
    b.scale.y = 0.01;
    b.userData.objetivo = 1;
    grupo.add(b);
    bloques.push(b);

    // Franja de metal en el frente del bloque.
    const franja = new THREE.Mesh(
      new THREE.BoxGeometry(2.12, 0.14, 2.12),
      new THREE.MeshStandardMaterial({ color: metales[col], metalness: 0.9, roughness: 0.2, emissive: metales[col], emissiveIntensity: 0.15 })
    );
    b.add(franja);
    b.userData.franja = franja;

    const c = coche(0xffffff);
    c.scale.setScalar(0.62);
    grupo.add(c);
    coches.push(c);
  });

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(4.6, 4.9, 0.25, 48),
    new THREE.MeshStandardMaterial({ color: 0x14141c, metalness: 0.4, roughness: 0.6 })
  );
  base.position.y = -0.13;
  grupo.add(base);

  // Arrastrar gira el podio; al soltar vuelve a girar solo.
  let arrastre = null, giroManual = 0, velocidad = 0.25;
  canvas.addEventListener("pointerdown", (e) => { arrastre = e.clientX; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (arrastre == null) return;
    giroManual += (e.clientX - arrastre) * 0.01;
    arrastre = e.clientX;
  });
  canvas.addEventListener("pointerup", () => { arrastre = null; });

  ajustar(renderer, camara, cont);
  new ResizeObserver(() => ajustar(renderer, camara, cont)).observe(cont);

  const reloj = new THREE.Clock();
  bucle(canvas, () => {
    const dt = Math.min(reloj.getDelta(), 0.05);
    const t = reloj.elapsedTime;
    if (arrastre == null) giroManual += dt * velocidad * Math.sin(t * 0.4) * 0.6;
    grupo.rotation.y = giroManual;

    bloques.forEach((b, i) => {
      // Crecen hacia su altura objetivo: animacion al llegar datos nuevos.
      b.scale.y += (b.userData.objetivo - b.scale.y) * 0.06;
      b.position.y = b.scale.y / 2;
      b.userData.franja.position.y = 0.5 - 0.07 / b.scale.y;
      b.userData.franja.scale.y = 1 / b.scale.y;
      const c = coches[i];
      c.position.set(b.position.x, b.scale.y + 0.02 + Math.sin(t * 2 + i) * 0.04, 0);
      c.rotation.y = t * 0.6 + i;
    });

    renderer.render(escena, camara);
  });

  const s = { bloques, coches };
  podios.set(cont, s);
  return s;
}

/* ========================== TILT DE TARJETAS ========================= */
/* CSS 3D puro: funciona aunque no haya WebGL. En pantallas tactiles no
   se activa, porque ahi no hay "pasar el raton" y el efecto estorba. */

Escena3D.activarTilt = function (raiz = document) {
  if (MENOS_MOVIMIENTO || matchMedia("(pointer: coarse)").matches) return;
  raiz.querySelectorAll(".tilt:not([data-tilt])").forEach((el) => {
    el.dataset.tilt = "1";
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `perspective(900px) rotateY(${x * 9}deg) rotateX(${-y * 9}deg) translateZ(6px)`;
      el.style.setProperty("--mx", `${(x + 0.5) * 100}%`);
      el.style.setProperty("--my", `${(y + 0.5) * 100}%`);
    });
    el.addEventListener("pointerleave", () => { el.style.transform = ""; });
  });
};

window.Escena3D = Escena3D;
})();
