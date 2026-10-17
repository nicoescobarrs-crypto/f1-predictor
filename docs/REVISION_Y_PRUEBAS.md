# Revisión de F1 Predictor y guía de pruebas

Revisión del 17 de octubre de 2026 sobre el commit
`da76200b5a8feed4181ef81da9dac211408f7e40`.
Este primer bloque corrige permisos de las quinielas y mensajes de conexión.
Los cambios de SQL necesitan aplicarse en Supabase; subir el archivo a GitHub
no actualiza por sí solo la base de datos.

## Cómo entender el proyecto

| Parte | Responsabilidad | Archivos principales |
|---|---|---|
| Página | Estructura y aspecto de las pantallas | `web/index.html`, `web/css/` |
| Interacciones | Cargar JSON, mostrar tablas y modificar la parrilla | `web/js/app.js` |
| Cuentas | Registro, entrada y perfil a través de Supabase Auth | `web/js/auth.js` |
| Quiniela | Seleccionar pilotos, guardar predicciones y mostrar ranking | `web/js/quiniela.js` |
| Datos externos | Consultas a servicios de clasificación y mercados | `web/js/vivo.js`, `web/js/paneles-vivo.js` |
| Modelo | Descargar datos, preparar variables, entrenar y exportar JSON | `pipeline/` |
| Base de datos | Tablas, permisos, cierre de plazo y puntuación oficial | `sql/schema.sql` |
| Publicación | Entregar la carpeta `web/` desde Firebase Hosting | `firebase.json`, `.github/workflows/firebase.yml` |

GitHub guarda los archivos y ejecuta los workflows. Firebase entrega HTML,
CSS, JavaScript y JSON al navegador. El JavaScript que se ejecuta en el
navegador llama a Supabase para consultar y guardar datos de los usuarios.
El modelo Python genera datos que la web puede leer; no necesita entrenarse
de nuevo por cada visita. El directorio `server/` contiene un servidor Flask
opcional para desarrollo local.

Una quiniela recorre estos pasos:

1. La persona elige pilotos en el navegador. Hay un borrador local del top 10.
2. Al guardar, el navegador envía el usuario, el GP, los pilotos y los abandonos.
3. PostgreSQL comprueba permisos y plazo antes de escribir. La fecha la fija el servidor.
4. Tras el cierre, un administrador carga el resultado y solicita puntuar.
5. La función calcula los puntos y el ranking los suma desde las quinielas.

## Problemas confirmados en el código revisado

### Permisos de puntos y puntuación

Las políticas RLS limitaban qué filas podía cambiar cada usuario, pero no
protegían las columnas `puntos`, `detalle` y `puntuada_en` frente a los permisos
de tabla habituales de Supabase. La corrección concede escritura únicamente
en las columnas de la predicción.

`puntuar_evento()` usa `SECURITY DEFINER`, por lo que necesita comprobar
explícitamente el rol de quien la llama. Ahora autoriza administradores y
la clave de servicio, rechaza anónimos y usuarios normales, y exige que el GP
haya cerrado. También se corrige el `UPDATE` que referenciaba la tabla destino
desde un `LATERAL`, usando una subconsulta correlacionada válida.

La política de actualización ahora verifica tanto la fila anterior como la
nueva: no se puede mover una predicción de un GP abierto a uno cerrado.
La fecha del último envío se establece con un trigger del servidor.

Esto describe el SQL del repositorio. No confirma cuáles de esas reglas están
instaladas actualmente en el proyecto de Supabase.

### Mensajes de conexión

En el navegador de revisión, la clasificación de la quiniela mostró
`TypeError: Failed to fetch`. Esa observación no demuestra una caída general
del servicio. El código trataba tanto un error de consulta como una consulta
vacía como si faltara sincronizar el calendario.

Ahora se distinguen esos casos, se muestra un mensaje comprensible con opción
de reintentar y se conserva el uso del calendario público como vista previa.
También se validan los borradores locales para ignorar datos corruptos,
pilotos desconocidos y duplicados.

### Controles y cabecera

Los botones para reordenar incluyen el nombre del piloto y se desactivan en
los extremos de la lista. La cabecera reduce el espacio reservado cuando
el 3D está desactivado o no disponible. Esta regla CSS aún necesita comprobación
visual en dispositivos reales y en la vista publicada tras integrar la rama.

## Ejecutar las comprobaciones

Requiere Node.js 22 y npm. Desde la raíz del repositorio:

```bash
npm ci --prefix tests --ignore-scripts --no-audit --no-fund
npm test --prefix tests
```

Las pruebas usan PostgreSQL en WebAssembly mediante PGlite, en memoria, sin
credenciales ni conexiones a la base de producción. Se comprueban tanto el
esquema nuevo como la migración reaplicada sobre permisos de tabla y columna
anteriores. El contexto de Supabase Auth se simula con usuarios y claims JWT.

Se verifican envíos y actualizaciones válidas, protección de columnas,
privacidad de predicciones ajenas abiertas, cierre de plazo, rechazo de
escalada a administrador y puntuación autorizada e idempotente. También se
prueban mensajes ante errores de red, calendario vacío y borradores inválidos.

Las pruebas no cubren el transporte HTTP de PostgREST, el envío de correos,
las sesiones reales de Supabase Auth, Realtime, la adaptación móvil ni la
precisión estadística del modelo. GitHub Actions ejecuta las mismas
comprobaciones con cada push y pull request.

## Aplicar el primer bloque

1. Revisar e integrar la rama de correcciones. El workflow de Firebase publica
   automáticamente al actualizar `main`; comprobar su resultado en Actions.
2. Aplicar `sql/migrations/20261017_proteger_quinielas.sql` desde el SQL Editor
   del proyecto correcto de Supabase, o mediante su plugin conectado.
   La migración es transaccional y no borra quinielas existentes.
3. Comprobar en el sitio publicado con cuentas de prueba que guardar y actualizar
   funciona, que el ranking carga y que los permisos se rechazan como se espera.

El orden importa: el JavaScript anterior enviaba `enviada_en` desde el navegador;
los nuevos permisos reservan esa fecha al servidor. Publicar primero el
JavaScript evita que ese campo cause un rechazo tras aplicar la migración.

## Pruebas con agentes que representan visitantes

Los agentes deben recibir una tarea y un perfil, y registrar acciones y
resultados observados. Sus observaciones ayudan a encontrar fricciones; una
simulación no equivale a una investigación con personas reales.

| Perfil | Tarea | Resultado que debe comprobar |
|---|---|---|
| Visitante nuevo | Entender el juego, completar y ordenar el top 10 | Las instrucciones permiten completar la selección y entender cómo guardarla |
| Usuario registrado | Guardar, recargar y modificar una quiniela abierta | Recupera los datos y confirma la actualización |
| Usuario que llega tarde | Intentar guardar tras el cierre en un entorno de prueba | El servidor rechaza el envío y la interfaz explica el motivo |
| Usuario con conexión interrumpida | Preparar la selección, perder conexión y reintentar | No aparece un falso aviso de calendario vacío ni se pierde el borrador |
| Usuario de teclado o lector de pantalla | Reordenar sin arrastrar | Cada control identifica al piloto y permite seguir trabajando |

Las pruebas que escriban datos deben usar cuentas identificadas para pruebas
y, preferentemente, una base separada. Hasta conectar Supabase, solo están
verificados los permisos en la base temporal, no en producción.
