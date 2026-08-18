# Publicar la web en GitHub + Firebase

La web es 100 % estática (HTML + CSS + JS + JSON), así que se publica gratis en Firebase
Hosting, en el plan Spark (sin tarjeta de crédito).

**No necesitas instalar Node.js, ni usar git, ni la consola.** Subes los archivos
arrastrándolos en la web de GitHub y GitHub Actions los publica en Firebase por ti.

```
tu equipo ──arrastrar──> GitHub ──GitHub Actions──> Firebase Hosting
                                                     tu-proyecto.web.app
```

Son 8 pasos: los 1–4 en GitHub, los 5–7 en Firebase, y el 8 es comprobar.

---

## Qué archivos van a GitHub (33 en total)

Ya están todos preparados en `C:\Users\Nicoe\Documents\f1-predictor-SUBIR-A-GITHUB`.
No tienes que crear ni editar ninguno antes de subirlos.

**Configuración del despliegue** — los que hacen que esto funcione:

| Archivo | Para qué sirve |
|---|---|
| `.github/workflows/firebase.yml` | Publica en Firebase con cada push. **Automático.** |
| `.github/workflows/pages.yml` | Alternativa en GitHub Pages. Manual, no se ejecuta solo. |
| `firebase.json` | Le dice a Firebase que publique la carpeta `web/`. |
| `.firebaserc` | Tu Project ID. **Es el único archivo que debes editar** (paso 5). |
| `.gitignore` | Excluye `cache/` y `data/`, que pesan cientos de MB. |
| `actualizar_subida.py` | Regenera la carpeta de subida tras cada carrera. |

**La web** (lo que se publica):

```
web/index.html          la página
web/css/style.css
web/js/app.js
web/data/index.json          ← metadatos y resumen del modelo
web/data/metricas.json       ← métricas de rendimiento
web/data/pilotos.json        ← fichas y trayectorias
web/data/resultados.json     ← histórico de 124 carreras
web/data/clasificacion.json  ← campeonato actual
web/data/events/*.json       ← 4 predicciones (una por GP futuro)
```

**El código del proyecto** (no se publica, pero conviene tenerlo versionado):

```
pipeline/    config, data, features, models, export, run, experimento
server/      nlu, asistente, app        (el chat, ver el final del documento)
notebooks/   analisis_f1.ipynb, generar_notebook.py
README.md, DEPLOY.md, requirements.txt
```

**Lo que NO se sube:** `cache/` y `data/`. Se regeneran solos con
`python pipeline/run.py --refrescar`.

> ⚠️ `web/data/` **sí** se sube, aunque se llame "data". Las barras iniciales de `.gitignore`
> (`/cache/`, `/data/`) son lo que marca la diferencia: sin ellas el patrón también excluiría
> `web/data/` y publicarías una web sin datos.

---

## Paso 1. Abre la carpeta preparada

Todo lo que hay que subir está ya separado en:

```
C:\Users\Nicoe\Documents\f1-predictor-SUBIR-A-GITHUB
```

Son **33 archivos, 1.2 MB**. Esa carpeta contiene exactamente lo que va al repositorio: ni
`cache/` ni `data/`, que pesan cientos de MB y no deben subirse.

> No arrastres la carpeta original `f1-predictor` a GitHub. Llevaría la caché entera.

## Paso 2. Crea el repositorio en GitHub

Ve a <https://github.com/new>:

- **Repository name:** `f1-predictor`
- **Public** o **Private**: con Firebase funciona con los dos
- **No marques** "Add a README", ".gitignore" ni "license"

Pulsa *Create repository*. Verás una página con instrucciones de git: ignórala.

## Paso 3. Sube los archivos arrastrándolos

En esa misma página, pulsa el enlace **uploading an existing file**.
(Si ya saliste, es el botón **Add file → Upload files**.)

Abre el Explorador en `f1-predictor-SUBIR-A-GITHUB`, selecciona **todo** el contenido con
`Ctrl+E` y arrástralo a la zona de subida del navegador.

Ojo: selecciona **el contenido de la carpeta**, no la carpeta en sí. Si arrastras la carpeta
entera, GitHub creará un nivel de más y la web no funcionará.

Verás cómo se van listando los archivos con su ruta (`web/data/pilotos.json`, etc.). Cuando
estén los 33, escribe abajo un mensaje como `F1 Predictor: pipeline de ML, web y asistente`
y pulsa **Commit changes**.

## Paso 4. Comprueba que subió todo

En la portada del repositorio debes ver estas carpetas:

```
.github/    notebooks/    pipeline/    server/    web/
```

más `README.md`, `DEPLOY.md`, `requirements.txt`, `firebase.json`, `.firebaserc` y
`.gitignore`.

Dos comprobaciones que conviene hacer:

1. Entra en `web/data/` y confirma que hay **9 archivos JSON** (5 sueltos y la carpeta
   `events/` con 4). Sin ellos la web se publica vacía.
2. Entra en `.github/workflows/` y confirma que están `firebase.yml` y `pages.yml`.

**Si falta la carpeta `.github`**, algunos navegadores se saltan las carpetas que empiezan por
punto al arrastrar. Créala a mano:

- **Add file → Create new file**
- En el nombre escribe: `.github/workflows/firebase.yml` — al teclear cada `/` GitHub va
  creando las carpetas solas
- Pega el contenido de ese mismo archivo (ábrelo con el Bloc de notas desde la carpeta
  preparada) y pulsa *Commit changes*
- Repite con `.github/workflows/pages.yml`

## Paso 5. Pon tu Project ID en `.firebaserc`

Entra en <https://console.firebase.google.com/> y crea un proyecto si no lo tienes.

El **Project ID** no es el nombre visible, es el identificador. Lo ves en
⚙️ *Configuración del proyecto* → *ID del proyecto*. Tiene esta pinta: `f1-predictor-4c2a1`.

**Edítalo directamente en GitHub**, no hace falta volver a subir nada:

1. En tu repositorio, pulsa sobre el archivo `.firebaserc`
2. Pulsa el icono del lápiz (*Edit this file*), arriba a la derecha
3. Sustituye `PON-AQUI-TU-PROJECT-ID` por tu identificador, dejándolo así:

```json
{
  "projects": {
    "default": "f1-predictor-4c2a1"
  }
}
```

4. Pulsa **Commit changes**

Es el único archivo que tienes que editar. El workflow lee el ID de aquí, así que no hay que
escribirlo en dos sitios.

> Al guardar, GitHub lanzará el workflow y **fallará**. Es normal: todavía falta el secreto
> del paso 7. Sigue adelante.

## Paso 6. Activa Hosting en la consola de Firebase

En el menú lateral: **Compilación → Hosting** → *Comenzar*.

Te enseñará instrucciones para instalar la CLI. **Ignóralas y ve pulsando Siguiente** hasta
terminar el asistente. Solo necesitas que Hosting quede activado en el proyecto; el
despliegue lo hará GitHub.

## Paso 7. Crea la clave de servicio y guárdala como secreto

Esto es lo que permite a GitHub publicar en tu Firebase.

**7a. Genera la clave.** En Firebase: ⚙️ *Configuración del proyecto* → pestaña **Cuentas de
servicio** → botón **Generar nueva clave privada** → *Generar clave*.

Se descargará un archivo `.json`. **Es una credencial: no la subas a GitHub ni la pegues en
ningún chat.** Solo va en el paso siguiente, y luego puedes borrarla de Descargas.

**7b. Guárdala como secreto.** En tu repositorio de GitHub:

**Settings → Secrets and variables → Actions → New repository secret**

- **Name:** `FIREBASE_SERVICE_ACCOUNT` (exactamente así, respetando mayúsculas)
- **Secret:** abre el `.json` descargado con el Bloc de notas, selecciona **todo** el
  contenido (desde la primera `{` hasta la última `}`) y pégalo aquí

Pulsa *Add secret*.

## Paso 8. Lanza el despliegue y comprueba

Ya está todo configurado. Solo falta relanzar el workflow que falló en el paso 5:

1. Ve a la pestaña **Actions** de tu repositorio
2. En la lista de la izquierda, pulsa **Publicar en Firebase**
3. Pulsa el botón **Run workflow** → *Run workflow*

Tarda un minuto. Si prefieres, también puedes entrar en la ejecución que falló y darle a
*Re-run all jobs*: es equivalente.

Cuando esté en verde, tu página está en:

```
https://TU-PROJECT-ID.web.app
```

También la ves en Firebase → Hosting, con su historial de versiones.

---

## Actualizar después de cada Gran Premio

El pipeline no se ejecuta en el servidor: los JSON se generan en tu equipo y se suben.

**1.** Regenera los datos:

```bash
python pipeline/run.py --refrescar
```

**2.** Vuelve a copiar la web a la carpeta de subida:

```bash
python actualizar_subida.py
```

**3.** En GitHub, entra en la carpeta `web` de tu repositorio y usa **Add file → Upload
files**. Arrastra la carpeta `web` desde `f1-predictor-SUBIR-A-GITHUB`... o más simple:
arrastra solo los archivos de `web/data/` que hayan cambiado. GitHub sustituye los que ya
existen con el mismo nombre y conserva el resto.

Pulsa *Commit changes* y el workflow republica solo. No hay que tocar Firebase.

> Subir solo `web/data/` es suficiente tras una carrera: el HTML, el CSS y el JS no cambian.

---

## El asistente no se publica, y es a propósito

El chat (`server/app.py`) es un servidor Python. Firebase Hosting solo sirve archivos
estáticos, así que **no funciona en la web publicada**.

Está previsto: la página lo detecta y lo explica en su pestaña. Las otras cinco funcionan con
normalidad. Para la demo en clase, levántalo en tu portátil:

```bash
python server/app.py
```

Y abre <http://localhost:5000>.

¿Y Firebase Cloud Functions? Ejecutarían Python, pero **exigen el plan Blaze**, que pide
tarjeta de crédito aunque el uso real cueste 0 €. Si algún día lo quieres publicar, sale más
a cuenta un hosting gratuito con Python (Render, Railway, PythonAnywhere): añade un
`Procfile` con `web: gunicorn server.app:app`, mete `gunicorn` en `requirements.txt`, y en
`web/js/app.js` cambia las rutas `/api/...` por la URL completa de ese backend.

---

## Alternativa: GitHub Pages

Si prefieres saltarte Firebase, el repositorio ya trae `.github/workflows/pages.yml`. Está en
manual a propósito, para que no falle si no lo activas.

1. Settings → Pages → en *Source* elige **GitHub Actions**
2. El repositorio debe ser **público** (en cuentas gratuitas, Pages no va con repos privados)
3. Pestaña Actions → "Publicar en GitHub Pages" → *Run workflow*

Queda en `https://TU-USUARIO.github.io/f1-predictor/`. Puedes tener las dos publicaciones a
la vez sin ningún problema.

---

## Problemas frecuentes

**El workflow falla con "Falta el Project ID".**
No editaste `.firebaserc`, o lo dejaste con el texto de ejemplo. Paso 5.

**El workflow falla con "Falta web/data/index.json".**
No se subieron los datos. Comprueba con `git ls-files web/data` que aparecen los 9 JSON. Si
no, revisa que `.gitignore` diga `/data/` con barra inicial y no `data/`.

**Error de autenticación en el despliegue.**
El secreto `FIREBASE_SERVICE_ACCOUNT` falta, está mal escrito, o el JSON se pegó incompleto.
Tiene que ser el contenido entero del archivo, llaves incluidas. Bórralo y vuelve a crearlo.

**"HTTP Error: 403, Firebase Hosting API has not been used in project..."**
No completaste el paso 6. Activa Hosting en la consola de Firebase.

**La web carga pero las tablas están vacías.**
Faltan los JSON de `web/data/`. Mismo diagnóstico que arriba.

**"No se pudieron cargar los datos" al abrirlo en local.**
Estás abriendo `index.html` con doble clic y el navegador bloquea `fetch()` sobre `file://`.
Sírvelo por HTTP:

```bash
python -m http.server 8000 --directory web
```

**Los gráficos no aparecen.**
`Chart.js` se carga desde un CDN. Si tu red lo bloquea, descarga `chart.umd.min.js` a
`web/js/` y apunta el `<script>` de `index.html` al archivo local.
