import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../web/js/auth.js', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setTimeout(resolve, 10));
const session = id => ({ user: { id } });

async function client(load = async id => ({ data: { id, usuario: id, rol: 'usuario' } })) {
  let callback, locked = false;
  const notices = [], reads = [], writes = [];
  const sb = {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange(fn) { callback = fn; },
    },
    from() {
      assert.equal(locked, false, 'Una consulta al cliente dentro del callback de Auth puede bloquearlo');
      return {
        select: () => ({ eq: (_column, id) => ({ maybeSingle: () => { reads.push(id); return load(id); } }) }),
        insert: data => { writes.push(data); return Promise.resolve({ error: { message: 'RLS' } }); },
      };
    },
  };
  const window = { supabase: { createClient: () => sb } };
  vm.runInNewContext(source, {
    window, CONFIG: { hayCuenta: () => true, supabase: { url: 'https://example.test', anon: 'public' } },
    setTimeout, console: { warn() {}, error() {} },
  });
  const account = window.Cuenta;
  account._montarUI = () => {};
  account._pintarCabecera = () => {};
  // Los listeners de la aplicación también usan Supabase al refrescar la quiniela.
  account.listeners.push(() => { sb.from('quinielas'); notices.push(account.perfil); });
  await account.iniciar();
  return {
    account, notices, reads, writes,
    async emit(event, value) {
      locked = true;
      try {
        const result = callback(event, value);
        assert.equal(result, undefined, 'El callback de Auth debe devolver sin esperar consultas');
      } finally { locked = false; }
    },
  };
}

test('login consulta el perfil y avisa a la quiniela fuera del bloqueo de Auth', async () => {
  const p = await client();
  await p.emit('SIGNED_IN', session('piloto_1'));
  await turn();
  assert.deepEqual(p.reads, ['piloto_1']);
  assert.equal(p.account.perfil.usuario, 'piloto_1');
  assert.equal(p.notices.length, 1);
});

test('logout avisa a los listeners fuera del callback de Auth', async () => {
  const p = await client();
  await p.emit('SIGNED_OUT', null);
  await turn();
  assert.equal(p.account.sesion, null);
  assert.equal(p.account.perfil, null);
  assert.equal(p.notices.length, 1);
});

test('un perfil pendiente no reaparece después de cerrar sesión', async () => {
  let finish;
  const p = await client(id => new Promise(resolve => { finish = () => resolve({ data: { id, rol: 'admin' } }); }));
  await p.emit('SIGNED_IN', session('antiguo'));
  await turn();
  assert.equal(typeof finish, 'function');
  await p.emit('SIGNED_OUT', null);
  await turn();
  finish();
  await turn();
  assert.equal(p.account.perfil, null);
  assert.equal(p.account.sesion, null);
  assert.equal(p.notices.length, 1);
});

test('cambiar de cuenta no publica el perfil de la cuenta anterior', async () => {
  let finish;
  const p = await client(id => id === 'antiguo'
    ? new Promise(resolve => { finish = () => resolve({ data: { id, usuario: id } }); })
    : Promise.resolve({ data: { id, usuario: id } }));
  await p.emit('SIGNED_IN', session('antiguo'));
  await turn();
  await p.emit('SIGNED_IN', session('nuevo'));
  await turn();
  finish();
  await turn();
  assert.equal(p.account.perfil.usuario, 'nuevo');
  assert.equal(p.notices.length, 1);
});

test('perfil ausente no se fabrica tras una inserción que RLS rechazaría', async () => {
  const p = await client(async () => ({ data: null, error: null }));
  await p.emit('SIGNED_IN', session('sin_perfil'));
  await turn();
  assert.equal(p.account.perfil, null);
  assert.equal(p.writes.length, 0);
});
