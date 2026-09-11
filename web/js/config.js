/* ============================================================
   F1 Predictor — configuracion de servicios externos

   ESTE ES EL UNICO ARCHIVO QUE TIENES QUE EDITAR.

   Todo lo de abajo es opcional: si lo dejas vacio, la web funciona
   exactamente igual que antes y las secciones que dependen de cada
   servicio se explican solas en vez de fallar.
   ============================================================ */

const CONFIG = {

  /* ----------------------------------------------------------------
     1. SUPABASE — registro de usuarios y quiniela

     Sacalo de: supabase.com -> tu proyecto -> Settings -> API
       url  = "Project URL"
       anon = "anon public"  (la clave publishable, NO la service_role)

     Es normal que esta clave sea visible en el codigo publicado: es su
     diseno. Lo que protege los datos son las politicas RLS de
     sql/schema.sql, no el secreto de la clave. La service_role, en
     cambio, no debe aparecer JAMAS aqui: se salta RLS entera.
     ---------------------------------------------------------------- */
  supabase: {
    url:  "",
    anon: "",
  },

  /* ----------------------------------------------------------------
     2. THE ODDS API — cuotas de casas de apuestas

     Clave gratuita en: the-odds-api.com  (500 peticiones al mes)

     Aviso honesto: el plan gratis no cubre todas las casas, y BetPlay
     casi con seguridad no esta (el catalogo es sobre todo europeo y
     norteamericano). Las casas que falten se cargan a mano en la tabla
     'cuotas' desde el panel de admin.

     Y un aviso de seguridad: una clave metida aqui viaja al navegador
     de cualquiera que abra la web. Es aceptable para un proyecto de
     clase con una clave gratuita y limitada, pero no lo hagas con una
     clave de pago. La alternativa correcta es que el pipeline la
     consulte y guarde el resultado en web/data/cuotas.json.
     ---------------------------------------------------------------- */
  oddsApi: {
    clave: "",
    // Regiones: uk, us, eu, au. 'eu' es donde mas F1 hay.
    regiones: "eu,uk",
    // El deporte tal y como lo llama la API.
    deporte: "motorsport_f1_drivers_championship_winner",
  },

  /* ----------------------------------------------------------------
     3. DATOS EN VIVO — cada cuanto se refresca cada cosa

     Todas estas APIs son publicas, gratuitas y sin clave. Las tres
     responden con CORS abierto, que es lo que permite llamarlas desde
     una web estatica sin backend.
     ---------------------------------------------------------------- */
  vivo: {
    // Clasificacion y plantilla de pilotos. Sucesor de Ergast.
    jolpica: "https://api.jolpi.ca/ergast/f1",
    // Precios de Polymarket. Se leen como probabilidad directamente.
    polymarket: "https://gamma-api.polymarket.com",

    // Cada cuanto se repregunta, en segundos.
    refrescoMercado: 30,      // los precios se mueven de verdad
    refrescoClasificacion: 300,

    // Con la pestana en segundo plano no se refresca nada: no tiene
    // sentido gastar peticiones ni bateria para algo que nadie mira.
    pausarOculto: true,
  },

  /* ----------------------------------------------------------------
     4. 3D

     El 3D se apaga solo si el dispositivo no da la talla, si no hay
     WebGL, o si el sistema pide menos animacion
     (prefers-reduced-motion). Aqui solo se fuerza si hace falta.
     ---------------------------------------------------------------- */
  tresD: {
    activo: true,
    // Por debajo de esta anchura se usa la version ligera de la escena.
    anchoMinimo: 760,
  },
};

/** true si Supabase esta configurado y se puede intentar el registro. */
CONFIG.hayCuenta = () =>
  Boolean(CONFIG.supabase.url && CONFIG.supabase.anon);

/** true si hay clave para pedir cuotas de casas de apuestas. */
CONFIG.hayCuotas = () => Boolean(CONFIG.oddsApi.clave);

window.CONFIG = CONFIG;
