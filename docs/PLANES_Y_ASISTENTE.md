# Planes manuales y asistente de F1 Predictor

Este bloque añade planes de acceso al laboratorio y amplía el asistente
existente, sin incorporar un modelo generativo ni costes de API.

## Funciones y precios

| Plan | Precio mensual | Escenarios guardados | Comparación | CSV |
|---|---:|---:|---:|---|
| Básico | Gratis | 0 | No | No |
| VIP | 9.900 COP | 10 | Hasta 2 | No |
| Experto | 24.900 COP | 50 | Hasta 5 | Sí |

Todos conservan las predicciones, la parrilla interactiva, el histórico,
la quiniela y el asistente. No se otorgan puntos extra por pagar.
Nico y Martín tienen acceso equivalente a Experto por su rol de administrador.

## Solicitudes y activación

El botón Mejorar plan abre la sección Planes. Un usuario registrado puede
solicitar VIP o Experto; la solicitud queda dentro de la aplicación. No se
envían correos ni mensajes externos y no se procesa ningún cobro.

Nico o Martín ve las solicitudes pendientes y puede seleccionar una de ellas
o escribir el nombre exacto de una cuenta. Asignar VIP o Experto habilita un
mes calendario desde ese momento. Reasignar inicia de nuevo el mes; no acumula
meses pendientes. Asignar Básico elimina el acceso de pago. No hay renovación
automática. Los administradores deben acordar y comprobar el pago por separado.

El usuario puede pulsar Actualizar mi plan; el acceso también se actualiza
al volver a la pestaña. El servidor comprueba el plan en cada operación
protegida, incluso si el navegador conserva un estado anterior.

## Administradores y seguridad

La migración identifica las cuentas previamente verificadas `Nico_f1` y
`martin_1112`, exige que existan ambas y conserva sus UUID en una lista
privada. Cambiar el nombre del perfil después no cambia esa identidad.
Solo esas cuentas pueden tener administración efectiva. Los usuarios no pueden
editar la lista privada, las suscripciones ni el catálogo desde la API.
Comprar o recibir un plan no concede administración.

RLS limita solicitudes y escenarios a su propietario. Las funciones de
asignación, comparación y exportación comprueban permisos en PostgreSQL.
Un trigger serializa los guardados por cuenta y comprueba el cupo. Al vencer
una mejora, la cuenta vuelve a Básico y se bloquean nuevos guardados,
comparaciones y exportaciones. Se conserva la lectura y eliminación de los
escenarios propios existentes.

Los escenarios contienen la parrilla y una copia de los resultados calculados
en el navegador. Son notas de experimentación personales, no resultados
oficiales ni predicciones certificadas por el servidor. No alteran quinielas.
Compararlos conserva las cifras guardadas; cargarlos vuelve a calcular con
los datos actuales. El CSV protege frente a fórmulas incluidas en nombres.

## Asistente

Las respuestas siguen siendo deterministas y usan los JSON de la página y
explicaciones de sus funciones. Incluyen interpretación, límites y fecha de
los datos cuando corresponde. Se añaden temas de cuentas, quiniela, planes,
escenarios y lectura de mercados. Las preguntas no admitidas se redirigen al
contenido de F1 Predictor; no se consulta información externa ni se revelan
claves. No se promete conocimiento general de F1 fuera del conjunto cargado.

El motor de respuestas de la interfaz se mantiene en el navegador para aplicar
el mismo alcance tanto al publicar en Firebase como al servirla localmente.
Los endpoints Flask existentes siguen disponibles para desarrollo, pero el
chat de esta interfaz utiliza el motor limitado a la página.

## Archivos principales

- `web/js/planes.js`: tarjetas, solicitudes, laboratorio y controles de admin.
- `web/js/asistente-pagina.js`: respuestas sobre el producto y explicaciones.
- `supabase/migrations/20261017144151_planes_y_escenarios.sql`: tablas,
  lista de administradores, RLS, cupos y operaciones protegidas.
- `tests/plans.test.mjs`: permisos, precios, cupos, privacidad y caducidad.
- `tests/plans-ui.test.mjs`: controles reales del HTML en un DOM de prueba.
- `tests/assistant.test.mjs`: alcance de respuestas, datos y exportación segura.

## Activación y verificación

Ejecutar `npm ci --prefix tests --ignore-scripts --no-audit --no-fund` y
`npm test --prefix tests`. Las pruebas usan PostgreSQL temporal y un DOM
simulado; no escriben cuentas ni escenarios en producción.

La migración requiere el esquema existente y las dos cuentas verificadas.
Aplicarla una vez mediante Supabase antes de publicar la interfaz nueva.
Después comprobar el catálogo, el acceso de ambos administradores y las
operaciones con una cuenta Básico y una VIP/Experto. La asignación manual
de planes en producción no se realiza como efecto secundario del despliegue.

Las comprobaciones visuales en un navegador real y la prueba de extremo a
extremo de los planes quedan para después de publicar esta rama.
