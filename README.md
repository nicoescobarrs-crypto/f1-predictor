# 🏎️ F1 Predictor

Predicción del resultado de las carreras de Fórmula 1 con *gradient boosting*, y una web
estática para explorar las predicciones, el histórico y el rendimiento del modelo.

Proyecto de la asignatura **Introducción a la Ciencia de Datos**.

---

## Qué hace

- Descarga los resultados oficiales de F1 (2021–2026) con [FastF1](https://docs.fastf1.dev/).
- Construye 17 variables por piloto y carrera **sin fuga de datos temporal**.
- Entrena un regresor que estima cuántas posiciones gana o pierde cada piloto respecto
  a su parrilla, y cuatro clasificadores (victoria, podio, puntos, abandono).
- Exporta todo a JSON y sirve una web donde puedes **reordenar la parrilla y ver cómo
  cambia el resultado previsto**.
- Incluye un **asistente conversacional sin LLM**: entiende preguntas en español y las
  responde consultando los datos y el modelo de verdad.

## Resultados actuales

| Métrica | Valor |
|---|---|
| Error medio (MAE) | **3.13 posiciones** |
| Baseline "termina donde sale" | 3.46 posiciones |
| Mejora sobre el baseline | **+9.5 %** |
| Carreras en el dataset | 126 (2021–2026) |
| AUC victoria / podio / puntos | 0.98 / 0.93 / 0.81 |
| AUC abandono | 0.55 *(ver nota abajo)* |

Validación **temporal**: se entrena con las primeras carreras y se prueba con las últimas
(2083 filas de entrenamiento, 401 de prueba). Nunca aleatoria.

---

## Puesta en marcha

```bash
pip install -r requirements.txt
```

Genera los datos y entrena (la primera vez descarga ~130 carreras, unos 5 minutos;
después queda en caché y tarda ~40 segundos):

```bash
python pipeline/run.py --refrescar
```

Levanta la web **con el asistente** (recomendado en local):

```bash
python server/app.py
```

Y abre <http://localhost:5000>. Tarda unos 5 segundos en arrancar porque entrena los
modelos al iniciar.

O solo la web estática, sin asistente:

```bash
python -m http.server 8000 --directory web
```

> ⚠️ Abrir `web/index.html` con doble clic **no funciona**: el navegador bloquea `fetch()`
> sobre `file://`. Hay que servirlo por HTTP.

### Después de cada Gran Premio

```bash
python pipeline/run.py --refrescar
```

Vuelve a descargar lo que falte, reentrena y regenera los JSON.

### Otras opciones

```bash
python pipeline/run.py --eventos 8        # predecir las 8 próximas carreras
python pipeline/run.py --anios 2024 2025 2026
python pipeline/experimento.py            # comparar variantes del modelo
```

---

## Estructura

```
f1-predictor/
├── pipeline/
│   ├── config.py       Rutas, hiperparámetros, lista de features
│   ├── data.py         Descarga con FastF1 + caché en disco
│   ├── features.py     Limpieza e ingeniería de variables (sin fuga)
│   ├── models.py       Entrenamiento, split temporal, métricas
│   ├── export.py       Genera los JSON que consume la web
│   ├── run.py          Orquesta todo el pipeline
│   └── experimento.py  Banco de pruebas para comparar configuraciones
├── server/
│   ├── nlu.py          Intención + entidades (sin LLM, con rapidfuzz)
│   ├── asistente.py    Genera la respuesta consultando datos y modelo
│   └── app.py          Servidor Flask: sirve la web y expone /api/chat
├── web/
│   ├── index.html      Interfaz (6 pestañas)
│   ├── css/style.css
│   ├── js/app.js
│   └── data/           JSON generados (no editar a mano)
├── cache/              Caché de FastF1 (ignorado por git)
└── data/               Dataset intermedio (ignorado por git)
```

---

## Decisiones de modelado que conviene poder defender

**1. El objetivo del regresor son las posiciones ganadas, no la posición final.**
Predecir directamente la posición obliga al modelo a reaprender que quien sale delante
llega delante. Prediciendo la *desviación* respecto a la parrilla, la mejora sobre el
baseline pasó de +4.0 % a +9.9 %.

**2. Árboles poco profundos.** Con ~2000 filas, `max_depth=6` sobreajustaba.
`max_depth=4` da mejor MAE en el conjunto de prueba. Está medido en `experimento.py`,
no elegido a ojo.

**3. Split temporal, nunca aleatorio.** Un split aleatorio dejaría carreras futuras en el
entrenamiento y las métricas saldrían falsamente buenas.

**4. `.shift(1)` en toda variable histórica.** Ninguna fila puede ver su propio resultado.

**5. El baseline importa.** En F1, "cada piloto termina donde salió" ya acierta bastante
(MAE 3.45). Reportar solo el MAE del modelo sin compararlo con eso sería engañoso.

### El bug de `Lapped`, y por qué desconfiar de una métrica demasiado buena

FastF1 usa **tres** etiquetas para quien termina la carrera: `Finished`, `+1 Lap` y
`Lapped`. La primera versión solo reconocía las dos primeras, así que marcaba como
abandono a 372 pilotos (de 2520) que habían terminado doblados.

El síntoma no era un error visible, sino una métrica **sospechosamente buena**: el
clasificador de abandono daba AUC 0.73. Lo que estaba detectando en realidad era
"coche lento y doblado", que sí es muy predecible. Corregido el bug, el AUC bajó a 0.57.

Ese 0.57 es el número honesto: **los abandonos son casi impredecibles**, porque dependen
de fallos mecánicos y accidentes. Se deja tal cual en la web en vez de maquillarlo.

### Las probabilidades necesitaron tres arreglos, y el AUC no detectó ninguno

Los cuatro clasificadores se entrenan por separado y eso les dejaba decir cosas imposibles:

**1. No eran monótonos en la parrilla.** El modelo daba más probabilidad de ganar saliendo
P8 (22.7 %) que saliendo P5 (11.8 %), y un 15.7 % saliendo último. En los datos reales, quien
sale de P11 hacia atrás gana el **0.2 %** de las veces:

| Sale desde | Modelo (antes) | Realidad |
|---|---|---|
| P1 | 23.0 % | 56.5 % |
| P4–P6 | 11.8 % | 2.4 % |
| P7–P10 | 22.7 % | 1.0 % |
| P11+ | 15.7 % | 0.2 % |

La causa: las variables de forma del piloto dominan, un piloto rápido «parece ganador» salga
de donde salga, y en el histórico casi nunca sale al fondo, así que el modelo nunca vio ese
caso. Se corrige con `monotonic_cst` sobre la posición de salida, imponiendo lo que sabemos
con certeza: a igualdad de todo lo demás, salir más atrás no puede mejorarte el resultado.
Hubo que restringir también `TeammateGridDelta`, porque cambia al mover al piloto y por sí
sola rompía la monotonía.

**2. No eran coherentes entre sí.** Un piloto podía tener 69 % de podio y 54 % de puntos, y
subir al podio implica puntuar. Se impone `victoria ≤ podio ≤ puntos`.

**3. Estaban poco calibrados.** La victoria predice 0.025 de media cuando la tasa real es
0.047, y las probabilidades de una carrera suman 0.53 en vez de 1. Reescalarlas es legítimo,
pero sin tope la normalización se descontrolaba: con una parrilla inventada la suma del campo
se hundía y el reparto daba un 37 % de victoria a un piloto saliendo último cuando el modelo
crudo decía 5 %. Se acota la amplificación al factor que respalda la medición.

**Lo importante:** el AUC de victoria era **0.98 antes y después**. Una métrica de ordenación
no ve que las probabilidades sean absurdas. Hay que mirar predicciones concretas una por una.

### Efecto del cambio de reglamento de 2026

Desglosando el conjunto de prueba por año, el modelo mejora **+13 % en 2025** pero solo
**+8 % en 2026**. Tiene sentido: 2026 estrena reglamento, el orden de fuerzas cambia y el
histórico previo vale menos. Es un buen ejemplo de *distribution shift*.

---

## Limitaciones

- La web es estática. Al reordenar la parrilla, la estimación de cada piloto se busca en
  su curva de sensibilidad, calculada moviéndolo a él y dejando al resto en la parrilla de
  referencia. La diferencia con recalcular el escenario completo es pequeña (solo afecta a
  la variable del duelo con el compañero), pero existe.
- No se modela meteorología, estrategia de neumáticos, coches de seguridad ni accidentes,
  que es justo lo que hace impredecible una carrera. Por eso el error no baja de ~3 posiciones.
- Los pilotos novatos sin historial previo se descartan en su primera carrera.
- **La probabilidad de victoria es la parte más floja del modelo.** Aun con las
  restricciones de monotonía, sigue dando ~10 % a un piloto rápido saliendo último, y su
  orden entre pilotos no siempre coincide con el del regresor. Al leer una predicción, el
  orden previsto y las probabilidades de podio y puntos son más de fiar.

---

## Actualización automática

`.github/workflows/actualizar.yml` corre los lunes a las 06:00 UTC: descarga la carrera del
domingo, reentrena, commitea los JSON y republica en Firebase. Sin tocar nada.

Dos detalles que lo hacen funcionar:

**El despliegue va dentro del mismo workflow.** Un push hecho por Actions con el
`GITHUB_TOKEN` no dispara otros workflows. Si solo commiteara los datos, `firebase.yml` no se
enteraría y la web se quedaría con los datos viejos aunque el commit fuese correcto.

**La descarga es incremental y resumible.** FastF1 permite 500 llamadas por hora, y una
descarga completa no cabe en una sola tanda: al añadir la sesión de clasificación se duplicaron
las llamadas por carrera y la cuota reventó a mitad, dejando el dataset en 87 carreras de 126.
Ahora `construir_dataset` guarda después de cada temporada, salta lo que ya tiene y, si la
cuota se agota, avisa y se puede reanudar sin perder nada.

---

## Datos externos

Tres fuentes, todas gratuitas y sin clave de API:

| Fuente | Qué aporta | Dónde |
|---|---|---|
| FastF1 | resultados, y además el **clima registrado** durante la carrera | `pipeline/data.py` |
| Open-Meteo | **pronóstico** para las carreras futuras | `pipeline/clima.py` |
| Polymarket | probabilidades de campeonato del mercado | `pipeline/mercado.py` |

### El clima entra en el modelo; la clasificación no

Se midieron ambos con `pipeline/experimento_variables.py`, comparando conjuntos de variables
sobre **cinco cortes temporales distintos** (una sola partición no distingue una mejora real
del azar):

| Conjunto | Mejora en | MAE medio |
|---|---|---|
| Clima | **5 de 5 cortes** | −0.051 |
| Clasificación | 4 de 5 | −0.016 |
| Clasificación *encima* del clima | **1 de 5** | **+0.015** (empeora) |

El clima ayuda de forma consistente. La clasificación no, y añadirla encima del clima
**empeora** el modelo. Tiene sentido: la parrilla ya *es* el resultado de la clasificación, así
que el tiempo es en buena parte redundante, y con ~2 100 filas dos dimensiones de más cuestan
más de lo que aportan. Los tiempos se siguen descargando y guardando, pero fuera del modelo.

### Dos conversiones imprescindibles

FastF1 da el viento en **m/s** y Open-Meteo en **km/h**: sin dividir entre 3.6, el modelo vería
vendavales inexistentes. Y la **temperatura del asfalto no la mide ningún servicio**
meteorológico, así que se estima con el desfase histórico de cada circuito, sacado de nuestros
propios datos: en Monza el asfalto va ~15 °C por encima del aire; en Spa, ~5 °C.

---

## Modelo vs Mercado

Dos formas independientes de estimar quién gana el campeonato: el modelo simula la temporada
4 000 veces, y Polymarket agrega el dinero de miles de personas.

**No es una sección de consejos de apuestas.** Es un ejercicio de calibración, y la
probabilidad de victoria sigue siendo la parte más floja del modelo.

### El bug que enseña algo sobre simulaciones

La primera versión daba **98.9 %** de título al líder donde el mercado daba 75 %. Descomponiendo
el error del modelo sobre el conjunto de prueba aparecen dos componentes muy distintos:

| Componente | Tamaño | Comportamiento |
|---|---|---|
| Por carrera | 4.42 posiciones | se diluye al promediar (1/√n) |
| Persistente por piloto | 1.40 posiciones | **no se diluye nunca** |

Sorteando solo el primero, once carreras de ruido independiente se cancelan entre sí y el
campeonato sale casi determinado. Añadiendo el segundo —sorteado una vez por temporada
simulada— la cifra baja al 93 %, que sigue siendo más tajante que el mercado pero ya es una
discrepancia discutible y no un error.

---

## El asistente

Un chat que responde preguntas en español sobre los datos y el modelo.

**No usa ningún modelo de lenguaje.** Es un clasificador de intención por palabras clave más
un extractor de entidades con coincidencia difusa, y un generador de respuestas.

Precisamente por ser determinista existe **dos veces**, y la página usa la que tenga:

| | Dónde | Predicciones |
|---|---|---|
| `web/js/asistente.js` | en el navegador | curvas de sensibilidad precalculadas |
| `server/asistente.py` | servidor Flask | modelo en vivo, con pandas y scikit-learn |

Así el chat **funciona en la web publicada**, sin backend ni credenciales. Si además levantas
`python server/app.py`, la página lo detecta y prefiere el motor de Python, que consulta el
modelo de verdad en lugar de la aproximación.

`web/js/difuso.js` es un port del subconjunto de `rapidfuzz` que hacía falta: similitud por
subsecuencia común más larga. Da los mismos números que Python — 94.7 entre «verstapen» y
«verstappen», 72.7 entre «alonso» y «albon» — que es lo que evita confundir dos pilotos.

Ventajas de no usar un LLM: no hay clave de API que proteger, no cuesta dinero, y es
imposible que se invente una cifra porque todas salen de una consulta real. Desventaja: solo
entiende preguntas parecidas a las previstas.

Entiende erratas y nombres coloquiales de circuitos:

```
¿cómo le irá a verstapen en monza saliendo P3?   → Max Verstappen, Italian GP, grid 3
¿qué pasó en hungria 2026?                       → Hungarian Grand Prix 2026
¿a quién se le da bien spa?                      → Belgian Grand Prix
compara a norris y piastri                       → duelo directo, 80 carreras juntos
y si alonso sale último                          → recalcula con él al fondo de la parrilla
```

Probar el motor de comprensión por separado, sin levantar el servidor:

```bash
python server/nlu.py "como le ira a alonso en montmelo saliendo 5"
```

Mantiene el contexto entre preguntas: tras preguntar por Verstappen en Monza, un «¿y si sale
desde la pole?» sigue hablando del mismo piloto y del mismo circuito.

---

## Despliegue

La web se publica en **Firebase Hosting** desde GitHub, sin instalar nada: `git push` y
GitHub Actions la despliega. Paso a paso en [DEPLOY.md](DEPLOY.md).

El asistente no se publica (es un servidor Python y Firebase Hosting solo sirve estáticos);
la página lo detecta y lo explica. Para la demo, `python server/app.py` en local.

## Créditos

Datos: [FastF1](https://docs.fastf1.dev/) sobre la API oficial de la Fórmula 1.
Modelos: [scikit-learn](https://scikit-learn.org/). Gráficos: [Chart.js](https://www.chartjs.org/).

Este proyecto no está afiliado a la Formula One Group. Uso académico.
