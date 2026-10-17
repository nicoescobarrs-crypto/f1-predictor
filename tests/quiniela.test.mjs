import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../web/js/quiniela.js', import.meta.url), 'utf8');
function page(response, draft = null) {
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '' });
    return elements.get(id);
  }};
  const window = {};
  const db = { from: () => ({ select: () => ({
    eq: () => ({ order: async () => { if (response instanceof Error) throw response; return response; } }),
    order: () => ({ limit: async () => { if (response instanceof Error) throw response; return response; } }),
    then: (resolve) => Promise.resolve({ data: [] }).then(resolve),
  }) }) };
  const ctx = {
    window, document, console: { warn() {} },
    CONFIG: { hayCuenta: () => true, vivo: { jolpica: 'https://example.test' } },
    estado: { indice: { temporadas: [2026] } },
    Cuenta: { sb: db, esAdmin: () => false },
    localStorage: { getItem: () => draft },
    fetch: async () => ({ json: async () => ({ MRData: { RaceTable: { Races: [{
      season: '2026', raceName: 'GP de prueba', round: '1', date: '2026-12-01',
      Qualifying: { date: '2026-11-30', time: '16:00:00Z' },
    }] } } }) }),
  };
  // Exponer funciones privadas solo dentro de este entorno de pruebas.
  vm.runInNewContext(source.replace('window.Quiniela = Quiniela;',
    'window.test = { cargarCalendario, pintarAvisoGeneral, pintarRanking, leerBorrador }; window.Quiniela = Quiniela;'), ctx);
  return { ...window, elements, document };
}

test('fallo de red usa calendario público sin afirmar que faltan datos', async () => {
  for (const response of [{ error: { message: 'TypeError: Failed to fetch' } }, new Error('sin red')]) {
    const p = page(response);
    await p.test.cargarCalendario();
    assert.equal(p.Quiniela.estadoCalendario, 'error');
    assert.equal(p.Quiniela.calendarioBD, false);
    assert.equal(p.Quiniela.gps.length, 1);
    p.test.pintarAvisoGeneral();
    const html = p.elements.get('q-aviso').innerHTML;
    assert.match(html, /No se pudo conectar/);
    assert.match(html, /Reintentar conexión/);
    assert.doesNotMatch(html, /admin|sincronice|aún no está/);
  }
});
test('consulta vacía distingue falta de calendario de fallo de red', async () => {
  const p = page({ data: [], error: null });
  await p.test.cargarCalendario();
  assert.equal(p.Quiniela.estadoCalendario, 'vacio');
  p.test.pintarAvisoGeneral();
  assert.match(p.elements.get('q-aviso').innerHTML, /sincronice/);
});
test('calendario disponible habilita el estado de base de datos', async () => {
  const p = page({ data: [{ slug: 'gp-real' }], error: null });
  await p.test.cargarCalendario();
  assert.equal(p.Quiniela.calendarioBD, true);
  assert.equal(p.Quiniela.gps[0].slug, 'gp-real');
  p.test.pintarAvisoGeneral();
  assert.equal(p.elements.get('q-aviso').innerHTML, '');
});
test('ranking maneja respuestas de error y excepciones sin mostrarlas al visitante', async () => {
  for (const response of [{ error: { message: 'TypeError: Failed to fetch' } }, new Error('sin red')]) {
    const p = page(response);
    await p.test.pintarRanking();
    const html = p.elements.get('q-ranking').innerHTML;
    assert.match(html, /Reintentar/);
    assert.doesNotMatch(html, /TypeError|Failed to fetch|sin red/);
  }
});
test('borradores inválidos no rompen la quiniela ni introducen duplicados', () => {
  const drivers = Array.from({length: 10}, (_, i) => `p${i}`);
  for (const value of ['{', '{}', 'null', JSON.stringify(['p0']), JSON.stringify(Array(10).fill('p0')), JSON.stringify([...drivers.slice(1), 'desconocido'])]) {
    const p = page({}, value);
    p.Quiniela.pilotos = drivers.map((driver_id) => ({ driver_id }));
    assert.equal(p.test.leerBorrador('gp'), null);
  }
  const p = page({}, JSON.stringify(drivers));
  p.Quiniela.pilotos = drivers.map((driver_id) => ({ driver_id }));
  assert.equal(JSON.stringify(p.test.leerBorrador('gp')), JSON.stringify(drivers));
});
