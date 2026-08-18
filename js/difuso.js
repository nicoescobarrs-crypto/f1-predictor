/* ============================================================
   Coincidencia difusa de cadenas — port del subconjunto de
   rapidfuzz que usa el asistente en Python.

   Es lo que permite escribir "verstapen" o "montmelo" y que
   el asistente entienda igual.

   Se carga como script clásico, antes de app.js.
   ============================================================ */

/** Longitud de la subsecuencia común más larga. Base de todo lo demás. */
function _lcs(a, b) {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return 0;

  // Solo hace falta la fila anterior, así que usamos dos arrays en vez de
  // la matriz completa: memoria O(min(n,m)) en lugar de O(n*m).
  let previa = new Uint16Array(m + 1);
  let actual = new Uint16Array(m + 1);

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      actual[j] = a[i - 1] === b[j - 1]
        ? previa[j - 1] + 1
        : Math.max(previa[j], actual[j - 1]);
    }
    const tmp = previa;
    previa = actual;
    actual = tmp;
    actual.fill(0);
  }
  return previa[m];
}

/**
 * Similitud 0–100 entre dos cadenas, equivalente a rapidfuzz.fuzz.ratio:
 * 100 * 2*LCS / (len(a) + len(b)).
 *
 *   ratio("verstapen", "verstappen") = 94.7  -> misma palabra con errata
 *   ratio("alonso",    "albon")      = 72.7  -> pilotos distintos
 *
 * El corte de 86 que usa el asistente cae justo entre esos dos casos.
 */
function ratio(a, b) {
  const total = a.length + b.length;
  if (total === 0) return 100;
  return (200 * _lcs(a, b)) / total;
}

/**
 * Mejor similitud entre `aguja` y cualquier fragmento de `pajar`,
 * equivalente a rapidfuzz.fuzz.partial_ratio.
 *
 * Sirve para detectar si un alias aparece DENTRO de una frase entera.
 */
function partialRatio(aguja, pajar) {
  if (!aguja.length || !pajar.length) return 0;
  if (aguja.length > pajar.length) return partialRatio(pajar, aguja);

  const ancho = aguja.length;
  let mejor = 0;

  // Ventana deslizante con algo de holgura, porque una errata puede alargar
  // o acortar la palabra respecto al alias.
  for (let i = 0; i <= pajar.length - ancho; i++) {
    for (const extra of [0, 1, 2]) {
      const r = ratio(aguja, pajar.slice(i, i + ancho + extra));
      if (r > mejor) mejor = r;
      if (mejor === 100) return 100;
    }
  }
  return mejor;
}

/** Quita tildes, pasa a minúsculas y limpia la puntuación. */
function normalizarTexto(texto) {
  return String(texto ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")   // marcas diacriticas (tildes, dieresis)
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
