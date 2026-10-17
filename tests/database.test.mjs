import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const schema = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../sql/migrations/20261017_proteger_quinielas.sql', import.meta.url), 'utf8');
const ids = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003'];
const top10 = '{a,b,c,d,e,f,g,h,i,j}';

// PostgreSQL real en WASM. Solo se simula el contexto JWT y auth.users de Supabase.
// Realtime y el transporte HTTP de PostgREST quedan fuera de estas pruebas.
for (const mode of ['esquema nuevo', 'migración sobre permisos anteriores']) {
  test(mode, async (t) => {
    const db = new PGlite();
    try {
      await db.exec(`
        create role anon; create role authenticated; create role service_role bypassrls;
        create schema auth;
        create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
        create function auth.uid() returns uuid language sql stable as $$
          select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
        $$;
        create function auth.role() returns text language sql stable as $$
          select nullif(current_setting('request.jwt.claim.role', true), '');
        $$;
        grant usage on schema public, auth to anon, authenticated, service_role;
        alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
        alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
        create publication supabase_realtime;
      `);
      await db.exec(schema);
      if (mode.startsWith('migración')) {
        await db.exec(`
          grant all on public.quinielas to anon, authenticated;
          grant update (puntos), insert (puntos) on public.quinielas to authenticated;
          grant execute on function public.puntuar_evento(text) to public;
          drop policy quinielas_editar on public.quinielas;
          create policy quinielas_editar on public.quinielas for update
            using (auth.uid() = usuario_id and exists (select 1 from public.grandes_premios g
              where g.slug = evento_slug and g.cierra_en > now()))
            with check (auth.uid() = usuario_id);
        `);
        await db.exec(migration);
        await db.exec(migration); // Reaplicar debe conservar la protección.
      }
      for (let i = 0; i < ids.length; i++) {
        await db.query('insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3)',
          [ids[i], `user${i}@example.test`, JSON.stringify({ usuario: `piloto${i}` })]);
      }
      await db.query("update public.perfiles set rol = 'admin' where id = $1", [ids[2]]);
      await db.exec(`insert into public.grandes_premios(slug,evento,temporada,cierra_en) values
        ('abierto','Abierto',2026,now()+interval '1 day'),
        ('cerrado','Cerrado',2026,now()-interval '1 day');`);
      await db.query('insert into public.quinielas(usuario_id,evento_slug,top10,abandonos) values ($1,$2,$3,2)', [ids[0], 'cerrado', top10]);
      await db.query('insert into public.resultados_gp(evento_slug,top10,abandonos) values ($1,$2,2)', ['cerrado', top10]);

      async function as(role, user, sql, params = []) {
        await db.exec(`set role ${role}`);
        try {
          await db.query("select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claim.role',$2,false)", [user ?? '', role]);
          return await db.query(sql, params);
        } finally { await db.exec('reset role'); }
      }
      async function denied(role, user, sql, params = []) {
        await assert.rejects(as(role, user, sql, params), (e) => e.code === '42501');
      }

      await t.test('usuario guarda y actualiza su top 10 con upsert', async () => {
        const sql = `insert into public.quinielas(usuario_id,evento_slug,top10,abandonos)
          values ($1,'abierto',$2,2) on conflict(usuario_id,evento_slug) do update
          set usuario_id=excluded.usuario_id,evento_slug=excluded.evento_slug,
          top10=excluded.top10,abandonos=excluded.abandonos returning *`;
        await as('authenticated', ids[0], sql, [ids[0], top10]);
        const result = await as('authenticated', ids[0], sql, [ids[0], '{b,a,c,d,e,f,g,h,i,j}']);
        assert.equal(result.rows[0].top10[0], 'b');
        assert.equal(result.rows[0].puntos, null);
        assert.ok(result.rows[0].enviada_en);
      });
      await t.test('no puede insertar sus propios puntos', () => denied('authenticated', ids[1],
        "insert into public.quinielas(usuario_id,evento_slug,top10,puntos) values ($1,'abierto',$2,9999)", [ids[1], top10]));
      for (const [column, value] of [['puntos','9999'], ['detalle',"'{}'::jsonb"], ['puntuada_en','now()'], ['enviada_en','now()']]) {
        await t.test(`no puede modificar ${column}`, () => denied('authenticated', ids[0],
          `update public.quinielas set ${column}=${value} where evento_slug='abierto'`));
      }
      await t.test('no puede trasladar una predicción a un GP cerrado', () => denied('authenticated', ids[0],
        "update public.quinielas set evento_slug='cerrado' where evento_slug='abierto'"));
      await t.test('no puede enviar por otra persona', () => denied('authenticated', ids[1],
        "insert into public.quinielas(usuario_id,evento_slug,top10) values ($1,'abierto',$2)", [ids[0], top10]));
      await t.test('no puede enviar a un GP cerrado', () => denied('authenticated', ids[1],
        "insert into public.quinielas(usuario_id,evento_slug,top10) values ($1,'cerrado',$2)", [ids[1], top10]));
      await t.test('no ve ni edita la quiniela ajena abierta', async () => {
        assert.equal((await as('authenticated', ids[1], "select * from public.quinielas where evento_slug='abierto'")).rows.length, 0);
        assert.equal((await as('authenticated', ids[1], "update public.quinielas set abandonos=3 where evento_slug='abierto' returning *")).rows.length, 0);
      });
      await t.test('no puede ascenderse a administrador', async () => {
        await assert.rejects(as('authenticated', ids[0], "update public.perfiles set rol='admin' where id=$1", [ids[0]]), /Solo un admin/);
      });
      await t.test('anónimo no escribe ni puntúa', async () => {
        await denied('anon', null, "insert into public.quinielas(usuario_id,evento_slug,top10) values ($1,'abierto',$2)", [ids[1], top10]);
        await denied('anon', null, "select public.puntuar_evento('cerrado')");
      });
      await t.test('usuario normal no ejecuta la puntuación', () => denied('authenticated', ids[0], "select public.puntuar_evento('cerrado')"));
      await t.test('administrador no puntúa un GP abierto', async () => {
        await assert.rejects(as('authenticated', ids[2], "select public.puntuar_evento('abierto')"), /aun esta abierta/);
      });
      await t.test('administrador puntúa y puede repetir sin sumar dos veces', async () => {
        for (let i = 0; i < 2; i++) {
          await as('authenticated', ids[2], "select public.puntuar_evento('cerrado')");
          const q = await db.query("select puntos from public.quinielas where evento_slug='cerrado'");
          assert.equal(q.rows[0].puntos, 215);
        }
      });
      await t.test('service_role puede puntuar para automatizaciones', async () => {
        assert.equal((await as('service_role', null, "select public.puntuar_evento('cerrado') as n")).rows[0].n, 1);
      });
    } finally { await db.close(); }
  });
}
