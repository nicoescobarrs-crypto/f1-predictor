/* ============================================================
   F1 Predictor — 3D con Three.js (r158)

   Dos escenas y un efecto:
     cabecera()     circuito con pianos, linea de meta y coches con
                    estela recorriendolo, a la derecha del titulo
     podio()        podio con los tres primeros, sombras y confeti
     activarTilt()  inclinacion 3D de tarjetas al pasar el raton (CSS)

   Dos detalles de Three.js que explican la version anterior, que se
   veia oscura y cortada:

   - Desde r155 las luces puntuales y focales usan unidades fisicas:
     con intensidad 30 a 10 metros apenas iluminan. Aqui la luz
     principal es direccional y hemisferica, que no dependen de la
     distancia.
   - La camara no puede estar fija: el podio vive en una caja estrecha
     y alta, y con el mismo encuadre que en una ancha se sale por los
     lados. Se recalcula la distancia con el aspecto real del canvas.

   El 3D es decoracion: sin WebGL, con "reducir movimiento" activado
   o si Three.js no cargo, no se pinta y la pagina sigue igual de
   usable. Cada escena deja de renderizar fuera de pantalla y con la
   pestana oculta, para no gastar GPU ni bateria.
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

function nuevoRenderer(canvas, { sombras = false, ligero = false } = {}) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: !ligero, alpha: true, powerPreference: "high-performance" });
  r.setPixelRatio(Math.min(window.devicePixelRatio, ligero ? 1 : 1.75));
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.15;
  if (sombras) {
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  return r;
}

/** Ajusta tamano y encuadre cada vez que cambia la caja que contiene el canvas. */
function alRedimensionar(renderer, camara, el, encuadrar) {
  const hacer = () => {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camara.aspect = w / h;
    encuadrar?.(w, h);
    camara.updateProjectionMatrix();
  };
  hacer();
  new ResizeObserver(hacer).observe(el);
}

/* ------------------------------ texturas ------------------------------ */
/* Dibujadas en un canvas 2D: sin archivos de imagen que descargar. */

let _brillo = null;
function texturaBrillo() {
  if (_brillo) return _brillo;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  _brillo = new THREE.CanvasTexture(c);
  return _brillo;
}

function texturaCuadros() {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 16;
  const g = c.getContext("2d");
  for (let x = 0; x < 16; x++) for (let y = 0; y < 4; y++) {
    g.fillStyle = (x + y) % 2 ? "#111" : "#f4f4f4";
    g.fillRect(x * 4, y * 4, 4, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function texturaNumero(n, color) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(0,0,0,0)";
  g.fillRect(0, 0, 256, 256);
  g.font = "italic 900 190px Orbitron, 'Titillium Web', Arial, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = color;
  g.shadowBlur = 24;
  g.fillStyle = color;
  g.fillText(String(n), 128, 140);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function brilloSprite(color, escala, opacidad = 1) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texturaBrillo(), color, transparent: true, opacity: opacidad,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  s.scale.setScalar(escala);
  return s;
}

/* ---------------------------- monoplaza F1 ---------------------------- */
/* Largo ~3.2, ancho ~1.5, mirando hacia +x y apoyado en y = 0. El chasis
   es un perfil lateral extruido: con cajas sueltas parecia un ladrillo. */

function coche(color) {
  const g = new THREE.Group();
  const pintura = new THREE.MeshStandardMaterial({
    color, metalness: 0.55, roughness: 0.28, emissive: color, emissiveIntensity: 0.12,
  });
  const carbono = new THREE.MeshStandardMaterial({ color: 0x17171e, metalness: 0.4, roughness: 0.55 });
  const goma = new THREE.MeshStandardMaterial({ color: 0x0b0b0e, roughness: 0.95 });
  const blanco = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, metalness: 0.2, roughness: 0.35 });

  const perfil = new THREE.Shape();
  perfil.moveTo(-1.18, 0.1);
  perfil.lineTo(1.92, 0.1);
  perfil.lineTo(1.95, 0.15);
  perfil.quadraticCurveTo(1.3, 0.2, 0.62, 0.29);
  perfil.lineTo(0.28, 0.33);
  perfil.quadraticCurveTo(0.02, 0.36, -0.12, 0.56);   // toma de aire
  perfil.quadraticCurveTo(-0.3, 0.6, -0.5, 0.48);
  perfil.quadraticCurveTo(-0.95, 0.38, -1.18, 0.3);
  perfil.closePath();
  const chasis = new THREE.ExtrudeGeometry(perfil, {
    depth: 0.3, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.035,
    bevelSegments: 3, curveSegments: 10,
  });
  chasis.translate(0, 0, -0.15);
  g.add(new THREE.Mesh(chasis, pintura));

  const pontones = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.2, 0.84), pintura);
  pontones.position.set(-0.2, 0.22, 0);
  g.add(pontones);

  const fondo = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.03, 0.98), carbono);
  fondo.position.set(-0.05, 0.085, 0);
  g.add(fondo);

  // Aleron delantero: plano principal, flap en color y dos derivas.
  const ad = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 1.5), carbono);
  ad.position.set(1.86, 0.08, 0);
  g.add(ad);
  const flap = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.03, 1.44), pintura);
  flap.position.set(1.8, 0.13, 0);
  flap.rotation.z = 0.25;
  g.add(flap);
  [-0.76, 0.76].forEach((z) => {
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.15, 0.02), carbono);
    d.position.set(1.86, 0.14, z);
    g.add(d);
  });

  // Aleron trasero.
  const at = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 1.04), pintura);
  at.position.set(-1.26, 0.7, 0);
  g.add(at);
  const at2 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.035, 1.04), carbono);
  at2.position.set(-1.17, 0.61, 0);
  g.add(at2);
  [-0.53, 0.53].forEach((z) => {
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.5, 0.025), carbono);
    d.position.set(-1.22, 0.48, z);
    g.add(d);
  });
  const pilar = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.05), carbono);
  pilar.position.set(-1.1, 0.5, 0);
  g.add(pilar);

  // Halo: medio toro tumbado alrededor de la cabina.
  const haloGeo = new THREE.TorusGeometry(0.21, 0.026, 6, 20, Math.PI);
  haloGeo.rotateX(-Math.PI / 2);
  haloGeo.rotateY(-Math.PI / 2);
  const halo = new THREE.Mesh(haloGeo, carbono);
  halo.position.set(0.08, 0.5, 0);
  g.add(halo);

  const casco = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), blanco);
  casco.position.set(-0.02, 0.45, 0);
  g.add(casco);

  // Ruedas: delanteras mas estrechas que las traseras, como las de verdad.
  const rueda = (r, a) => {
    const geo = new THREE.CylinderGeometry(r, r, a, 20);
    geo.rotateX(Math.PI / 2);
    return geo;
  };
  const del = rueda(0.22, 0.24);
  const tras = rueda(0.26, 0.32);
  [[1.12, 0.63, del, 0.22], [1.12, -0.63, del, 0.22],
   [-0.84, 0.66, tras, 0.26], [-0.84, -0.66, tras, 0.26]].forEach(([x, z, geo, r]) => {
    const m = new THREE.Mesh(geo, goma);
    m.position.set(x, r, z);
    g.add(m);
  });

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  g.userData.pintura = pintura;
  return g;
}

/** Cambia el color de la escuderia de un coche ya creado. */
function pintar(c, color) {
  const m = c.userData.pintura;
  m.color.set(color);
  m.emissive.set(color);
}

/* ----------------------- geometria del circuito ----------------------- */

/** Cinta plana que sigue la curva, entre dos distancias al eje (con signo). */
function cinta(muestras, desde, hasta, { y = 0, filtro = null, colores = null } = {}) {
  const pos = [], uv = [], col = [], idx = [];
  const n = muestras.length;
  muestras.forEach((m, i) => {
    const a = m.p.clone().addScaledVector(m.n, desde);
    const b = m.p.clone().addScaledVector(m.n, hasta);
    pos.push(a.x, y, a.z, b.x, y, b.z);
    uv.push(0, i / (n - 1), 1, i / (n - 1));
    if (colores) {
      const c = colores(i);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  });
  for (let i = 0; i < n - 1; i++) {
    if (filtro && !filtro(i)) continue;
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  if (colores) geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/* =============================== CABECERA ============================ */

Escena3D.cabecera = function (canvas) {
  if (!canvas || !Escena3D.disponible()) {
    document.body.classList.add("sin-3d");
    return;
  }
  const ligera = window.innerWidth < CONFIG.tresD.anchoMinimo;
  const renderer = nuevoRenderer(canvas, { ligero: ligera });

  const escena = new THREE.Scene();
  escena.fog = new THREE.FogExp2(0x07070c, 0.022);
  const camara = new THREE.PerspectiveCamera(36, 2, 0.1, 300);

  escena.add(new THREE.HemisphereLight(0xc8d6ff, 0x2a0505, 0.9));
  const sol = new THREE.DirectionalLight(0xffffff, 2.4);
  sol.position.set(10, 16, 8);
  escena.add(sol);
  const contra = new THREE.DirectionalLight(0xff3b30, 1.6);
  contra.position.set(-12, 6, -10);
  escena.add(contra);

  const pista = new THREE.Group();
  escena.add(pista);

  // Trazado inventado con pinta de circuito: recta larga, horquilla,
  // eses y una curva rapida.
  const trazado = [
    [-13, 1], [-5, 0.2], [4, -0.6], [10, -2.6], [13.4, -0.4], [12.2, 3.2],
    [7.8, 3.6], [5.2, 6.6], [1.4, 7.2], [-1.2, 4.4], [-4.4, 5.8], [-8.6, 6.4],
    [-12.6, 5.4], [-14.6, 3.2],
  ].map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curva = new THREE.CatmullRomCurve3(trazado, true, "centripetal");

  const N = ligera ? 260 : 520;
  const ANCHO = 0.78;
  const arriba = new THREE.Vector3(0, 1, 0);
  const muestras = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const p = curva.getPointAt(u % 1);
    const t = curva.getTangentAt(u % 1);
    muestras.push({ p, t, n: new THREE.Vector3().crossVectors(arriba, t).normalize() });
  }
  // Curvatura: cuanto gira la tangente alrededor de cada punto. Decide
  // donde van los pianos y cuanto frenan los coches.
  const curv = muestras.map((m, i) => {
    const a = muestras[(i - 4 + N) % N].t, b = muestras[(i + 4) % N].t;
    return a.angleTo(b);
  });
  const curvaEn = (u) => curv[Math.floor((((u % 1) + 1) % 1) * N)];

  // Halo rojo debajo del asfalto: el "brillo" sin posprocesado.
  pista.add(new THREE.Mesh(
    cinta(muestras, -ANCHO * 3.2, ANCHO * 3.2, { y: -0.03 }),
    new THREE.MeshBasicMaterial({
      color: 0xff2d26, transparent: true, opacity: 0.1,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    })
  ));

  // Asfalto.
  pista.add(new THREE.Mesh(
    cinta(muestras, -ANCHO, ANCHO),
    new THREE.MeshStandardMaterial({ color: 0x2a2a34, roughness: 0.82, metalness: 0.15, side: THREE.DoubleSide })
  ));

  // Lineas blancas de los bordes.
  const lineaMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, side: THREE.DoubleSide });
  pista.add(new THREE.Mesh(cinta(muestras, ANCHO - 0.05, ANCHO, { y: 0.005 }), lineaMat));
  pista.add(new THREE.Mesh(cinta(muestras, -ANCHO, -ANCHO + 0.05, { y: 0.005 }), lineaMat));

  // Pianos rojiblancos, solo en las curvas.
  const rojo = new THREE.Color(0xe10600), blanco = new THREE.Color(0xf4f4f4);
  const colorPiano = (i) => (Math.floor(i / 3) % 2 ? rojo : blanco);
  const enCurva = (i) => curv[i] > 0.16;
  const pianoMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: 0x220000, side: THREE.DoubleSide });
  pista.add(new THREE.Mesh(cinta(muestras, ANCHO, ANCHO + 0.22, { y: 0.01, filtro: enCurva, colores: colorPiano }), pianoMat));
  pista.add(new THREE.Mesh(cinta(muestras, -ANCHO - 0.22, -ANCHO, { y: 0.01, filtro: enCurva, colores: colorPiano }), pianoMat));

  // Linea de meta a cuadros.
  const meta = new THREE.Mesh(
    cinta(muestras.slice(0, 4), -ANCHO, ANCHO, { y: 0.012 }),
    new THREE.MeshBasicMaterial({ map: texturaCuadros(), side: THREE.DoubleSide })
  );
  pista.add(meta);

  // Suelo: rejilla que se pierde en la niebla.
  const rejilla = new THREE.GridHelper(200, 100, 0x6a1a1a, 0x1c1c2a);
  rejilla.material.transparent = true;
  rejilla.material.opacity = 0.45;
  rejilla.position.y = -0.05;
  escena.add(rejilla);

  // Coches con los colores de los que van delante en el mundial.
  const lideres = (estado.clasificacion?.pilotos ?? []).slice(0, ligera ? 3 : 5);
  const colores = lideres.length
    ? lideres.map((p) => colorEquipo(p.equipo))
    : ["#27F4D2", "#E8002D", "#FF8000", "#3671C6", "#27F4D2"];
  const ESTELA = ligera ? 8 : 16;
  const coches = colores.map((c, i) => {
    const m = coche(new THREE.Color(c));
    m.scale.setScalar(0.4);
    pista.add(m);
    const luz = brilloSprite(new THREE.Color(c), 2.6, 0.85);
    pista.add(luz);
    const estela = Array.from({ length: ESTELA }, (_, k) => {
      const s = brilloSprite(new THREE.Color(c), 1.3 * (1 - k / ESTELA) + 0.2, 0.55 * (1 - k / ESTELA));
      pista.add(s);
      return s;
    });
    return {
      m, luz, estela,
      u: 0.9 - i * 0.022,
      v: 0.034 - i * 0.0012,
      carril: (i % 2 ? 1 : -1) * 0.28,
    };
  });

  // Chispas que suben despacio.
  const NP = ligera ? 160 : 420;
  const pp = new Float32Array(NP * 3);
  for (let i = 0; i < NP; i++) {
    pp[i * 3] = (Math.random() - 0.5) * 70;
    pp[i * 3 + 1] = Math.random() * 14;
    pp[i * 3 + 2] = (Math.random() - 0.5) * 50;
  }
  const geoP = new THREE.BufferGeometry();
  geoP.setAttribute("position", new THREE.BufferAttribute(pp, 3));
  const chispas = new THREE.Points(geoP, new THREE.PointsMaterial({
    map: texturaBrillo(), color: 0xff5a4f, size: 0.28, transparent: true, opacity: 0.8,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  escena.add(chispas);

  // Encuadre: en pantallas anchas el circuito va a la derecha, que es
  // donde no hay texto. En estrechas, centrado y detras del titulo.
  const encuadre = { pos: new THREE.Vector3(), mira: new THREE.Vector3() };
  const encuadrar = (w, h) => {
    const ancha = w / h > 1.9 && w > 900;
    if (ancha) {
      pista.position.set(11.5, 0, -1);
      encuadre.pos.set(-1, 8.5, 21);
      encuadre.mira.set(6, 0, 1.5);
    } else {
      pista.position.set(0, 0, -2);
      encuadre.pos.set(0, 15, 24);
      encuadre.mira.set(0, 0, 1);
    }
    camara.position.copy(encuadre.pos);
  };

  const raton = { x: 0, y: 0 };
  window.addEventListener("pointermove", (e) => {
    raton.x = e.clientX / window.innerWidth - 0.5;
    raton.y = e.clientY / window.innerHeight - 0.5;
  }, { passive: true });

  alRedimensionar(renderer, camara, canvas.parentElement, encuadrar);

  const reloj = new THREE.Clock();
  const tan = new THREE.Vector3(), nor = new THREE.Vector3(), p = new THREE.Vector3();
  const mira = new THREE.Vector3();

  const situar = (obj, u, carril, y) => {
    curva.getPointAt(((u % 1) + 1) % 1, p);
    curva.getTangentAt(((u % 1) + 1) % 1, tan);
    nor.crossVectors(arriba, tan).normalize();
    obj.position.set(p.x + nor.x * carril, y, p.z + nor.z * carril);
    return tan;
  };

  bucle(canvas, () => {
    const dt = Math.min(reloj.getDelta(), 0.05);
    const t = reloj.elapsedTime;

    coches.forEach((c) => {
      // Frenan en las curvas y aceleran en las rectas.
      c.u = (c.u + c.v * dt * (1 - Math.min(0.55, curvaEn(c.u) * 1.1))) % 1;
      const tg = situar(c.m, c.u, c.carril, 0);
      c.m.rotation.y = Math.atan2(-tg.z, tg.x);
      situar(c.luz, c.u + 0.002, c.carril, 0.25);
      c.estela.forEach((s, k) => situar(s, c.u - (k + 1) * 0.0032, c.carril, 0.18));
    });

    const arr = geoP.attributes.position.array;
    for (let i = 1; i < arr.length; i += 3) {
      arr[i] += dt * 0.35;
      if (arr[i] > 14) arr[i] = 0;
    }
    geoP.attributes.position.needsUpdate = true;

    pista.rotation.y = Math.sin(t * 0.06) * 0.12;
    camara.position.x += (encuadre.pos.x + raton.x * 3 - camara.position.x) * 0.04;
    camara.position.y += (encuadre.pos.y - raton.y * 2 - camara.position.y) * 0.04;
    mira.copy(encuadre.mira);
    camara.lookAt(mira);

    renderer.render(escena, camara);
  });
};

/* ================================ PODIO ============================== */
/* Se llama cada vez que llegan precios nuevos. La escena se crea una
   sola vez; las siguientes llamadas solo cambian colores y alturas. */

const podios = new WeakMap();
const ORDEN = [1, 0, 2];                          // plata, oro, bronce
const METAL = ["#f5c542", "#c9ced6", "#cd7f4a"];  // por puesto (1.º, 2.º, 3.º)
const ALTO = [1.55, 1.12, 0.82];

Escena3D.podio = function (cont, top3) {
  if (!cont || !top3?.length) return;

  // Etiquetas HTML bajo el canvas: mas nitidas que texto 3D, y alineadas
  // con los tres bloques porque el podio ya no gira libremente.
  let et = cont.querySelector(".podio-etiquetas");
  if (!et) {
    et = document.createElement("div");
    et.className = "podio-etiquetas";
    cont.appendChild(et);
  }
  et.innerHTML = ORDEN.map((i) => top3[i] ? `
    <div class="podio-et p${i + 1}" style="--color:${top3[i].color}">
      <span class="pe-pos">${i + 1}</span>
      <b>${escapar(top3[i].nombre.split(" ").at(-1))}</b>
      <span class="pe-val">${(top3[i].valor * 100).toFixed(1)}%</span>
    </div>` : "<div></div>").join("");

  if (!Escena3D.disponible()) { cont.classList.add("podio-plano"); return; }

  const s = podios.get(cont) ?? crearPodio(cont);
  if (!s) return;

  ORDEN.forEach((i, col) => {
    const d = top3[i];
    s.columnas[col].grupo.visible = !!d;
    if (d) pintar(s.columnas[col].coche, d.color);
  });
  s.brilloOro.material.color.set(top3[0]?.color ?? METAL[0]);
};

function crearPodio(cont) {
  const canvas = document.createElement("canvas");
  canvas.className = "podio-canvas";
  canvas.setAttribute("aria-hidden", "true");
  cont.prepend(canvas);

  let renderer;
  try { renderer = nuevoRenderer(canvas, { sombras: true }); } catch { return null; }

  const escena = new THREE.Scene();
  const camara = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const objetivo = new THREE.Vector3(0, 1.0, 0);

  escena.add(new THREE.HemisphereLight(0xffffff, 0x3a3a55, 1.3));
  const clave = new THREE.DirectionalLight(0xffffff, 2.6);
  clave.position.set(4, 9, 7);
  clave.castShadow = true;
  clave.shadow.mapSize.set(1024, 1024);
  Object.assign(clave.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
  clave.shadow.bias = -0.0005;
  escena.add(clave);
  const contraRoja = new THREE.DirectionalLight(0xff2d26, 2.2);
  contraRoja.position.set(-5, 4, -6);
  escena.add(contraRoja);
  const relleno = new THREE.DirectionalLight(0x7dd3fc, 0.7);
  relleno.position.set(-7, 3, 5);
  escena.add(relleno);

  const grupo = new THREE.Group();
  escena.add(grupo);

  // Plataforma redonda con aro luminoso.
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(4.2, 4.45, 0.22, 72),
    new THREE.MeshStandardMaterial({ color: 0x191922, metalness: 0.5, roughness: 0.4 })
  );
  base.position.y = -0.11;
  base.receiveShadow = true;
  grupo.add(base);
  const aro = new THREE.Mesh(
    new THREE.TorusGeometry(4.3, 0.035, 8, 120),
    new THREE.MeshBasicMaterial({ color: 0xff2d26 })
  );
  aro.rotation.x = -Math.PI / 2;
  aro.position.y = 0.005;
  grupo.add(aro);
  const halo = brilloSprite(new THREE.Color(0xff2d26), 11, 0.18);
  halo.position.set(0, 0.2, -1);
  grupo.add(halo);

  const bloqueMat = new THREE.MeshStandardMaterial({ color: 0x33334a, metalness: 0.35, roughness: 0.38 });
  const columnas = [-2.15, 0, 2.15].map((x, col) => {
    const puesto = ORDEN[col];
    const g = new THREE.Group();
    g.position.x = x;
    grupo.add(g);

    const geo = new THREE.BoxGeometry(1.95, 1, 1.95);
    geo.translate(0, 0.5, 0);           // base en y = 0: se escala hacia arriba
    const bloque = new THREE.Mesh(geo, bloqueMat);
    bloque.scale.y = 0.01;
    bloque.castShadow = bloque.receiveShadow = true;
    g.add(bloque);

    const filo = new THREE.Mesh(
      new THREE.BoxGeometry(1.99, 0.07, 1.99),
      new THREE.MeshStandardMaterial({
        color: METAL[puesto], metalness: 0.9, roughness: 0.18,
        emissive: METAL[puesto], emissiveIntensity: 0.35,
      })
    );
    g.add(filo);

    const numero = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: texturaNumero(puesto + 1, METAL[puesto]), transparent: true, depthWrite: false })
    );
    numero.position.z = 0.985;
    g.add(numero);

    const c = coche(0xffffff);
    c.scale.setScalar(0.52);
    g.add(c);

    return { grupo: g, bloque, filo, numero, coche: c, alto: ALTO[puesto], fase: col * 1.7 };
  });

  // Destello dorado detras del ganador.
  const brilloOro = brilloSprite(new THREE.Color(METAL[0]), 3.4, 0.35);
  columnas[1].grupo.add(brilloOro);

  // Confeti sobre el ganador.
  const NC = 140;
  const conf = new Float32Array(NC * 3), velC = new Float32Array(NC);
  const colC = new Float32Array(NC * 3);
  const paleta = [new THREE.Color(METAL[0]), new THREE.Color(0xffffff), new THREE.Color(0xff2d26)];
  const reiniciar = (i, arriba) => {
    conf[i * 3] = (Math.random() - 0.5) * 3.2;
    conf[i * 3 + 1] = arriba ? 4.5 + Math.random() * 1.5 : 1.6 + Math.random() * 4.4;
    conf[i * 3 + 2] = (Math.random() - 0.5) * 2.4;
    velC[i] = 0.35 + Math.random() * 0.5;
  };
  for (let i = 0; i < NC; i++) {
    reiniciar(i, false);
    const c = paleta[i % 3];
    colC.set([c.r, c.g, c.b], i * 3);
  }
  const geoC = new THREE.BufferGeometry();
  geoC.setAttribute("position", new THREE.BufferAttribute(conf, 3));
  geoC.setAttribute("color", new THREE.BufferAttribute(colC, 3));
  const confeti = new THREE.Points(geoC, new THREE.PointsMaterial({
    size: 0.07, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false,
  }));
  grupo.add(confeti);

  // Encuadre segun el aspecto real: el podio mide ~6.6 de ancho y ~2.4 de
  // alto (bloque mas alto y coche). Se aleja la camara lo que haga falta
  // para que quepa entero en ambos sentidos.
  const encuadrar = (w, h) => {
    const vfov = THREE.MathUtils.degToRad(camara.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (w / h));
    const dist = Math.max(3.55 / Math.tan(hfov / 2), 1.75 / Math.tan(vfov / 2));
    const elev = THREE.MathUtils.degToRad(17);
    camara.position.set(0, objetivo.y + Math.sin(elev) * dist, Math.cos(elev) * dist);
    camara.lookAt(objetivo);
  };
  alRedimensionar(renderer, camara, canvas, encuadrar);

  // Arrastrar inclina el podio; al soltar vuelve a su sitio para que las
  // etiquetas de abajo sigan coincidiendo con cada bloque.
  let arrastre = null, giro = 0;
  canvas.addEventListener("pointerdown", (e) => { arrastre = e.clientX; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (arrastre == null) return;
    giro = THREE.MathUtils.clamp(giro + (e.clientX - arrastre) * 0.008, -0.75, 0.75);
    arrastre = e.clientX;
  });
  const soltar = () => { arrastre = null; };
  canvas.addEventListener("pointerup", soltar);
  canvas.addEventListener("pointercancel", soltar);

  const reloj = new THREE.Clock();
  bucle(canvas, () => {
    const dt = Math.min(reloj.getDelta(), 0.05);
    const t = reloj.elapsedTime;

    if (arrastre == null) giro += (Math.sin(t * 0.35) * 0.12 - giro) * 0.04;
    grupo.rotation.y = giro;

    columnas.forEach((c) => {
      const b = c.bloque;
      b.scale.y += (c.alto - b.scale.y) * 0.05;   // crecen al aparecer
      const h = b.scale.y;
      c.filo.position.y = h - 0.03;
      const lado = Math.min(0.9, h * 0.75);
      c.numero.scale.setScalar(lado);
      c.numero.position.y = h / 2;
      c.coche.position.y = h + 0.02 + Math.sin(t * 1.8 + c.fase) * 0.03;
      c.coche.rotation.y = -0.55 + Math.sin(t * 0.5 + c.fase) * 0.35;
    });
    brilloOro.position.set(0, columnas[1].bloque.scale.y + 0.45, -0.4);
    brilloOro.material.opacity = 0.3 + Math.sin(t * 2) * 0.08;

    for (let i = 0; i < NC; i++) {
      conf[i * 3 + 1] -= velC[i] * dt;
      conf[i * 3] += Math.sin(t * 2 + i) * dt * 0.15;
      if (conf[i * 3 + 1] < columnas[1].bloque.scale.y + 0.05) reiniciar(i, true);
    }
    geoC.attributes.position.needsUpdate = true;

    renderer.render(escena, camara);
  });

  const s = { columnas, brilloOro };
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
