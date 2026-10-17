import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Planes manuales, administradores y escenarios privados',async t=>{
  const db=new PGlite();
  const ids=[1,2,3,4].map(i=>`00000000-0000-0000-0000-00000000000${i}`);
  const result=JSON.stringify([{driver_id:'a',nombre:'A',posicion:1},{driver_id:'b',nombre:'B',posicion:2}]);
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid; $$;
      create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),''); $$;
      grant usage on schema auth,public to anon,authenticated,service_role;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
      create publication supabase_realtime;`);
    await db.exec(await readFile(new URL('../sql/schema.sql',import.meta.url),'utf8'));
    for(const [i,usuario] of ['Nico_f1','martin_1112','visitante','otro'].entries())
      await db.query('insert into auth.users values($1,$2,$3)',[ids[i],`p${i}@example.test`,JSON.stringify({usuario})]);
    await db.query("update public.perfiles set rol='admin' where id=any($1)",[ids.slice(0,2)]);
    await db.exec(await readFile(new URL('../supabase/migrations/20261017144151_planes_y_escenarios.sql',import.meta.url),'utf8'));
    async function as(index,sql,params=[]) {
      await db.exec('set role authenticated');
      try {
        await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[ids[index]]);
        return await db.query(sql,params);
      } finally{await db.exec('reset role');}
    }
    const plan=async i=>(await as(i,'select public.mi_plan() as plan')).rows[0].plan;
    const assign=(i,user,code)=>as(i,'select public.asignar_plan($1,$2)',[user,code]);
    const save=async(i,name)=> (await as(i,"insert into public.escenarios(nombre,evento_slug,parrilla,resultado) values($1,'gp',$2,$3) returning id",[name,'{a,b}',result])).rows[0].id;
    const blocked=promise=>assert.rejects(promise,e=>e.code==='42501');
    let first,second,other;
    await t.test('catálogo tiene los precios acordados',async()=>{
      const rows=(await db.query('select codigo,precio_cop from public.planes order by precio_cop')).rows;
      assert.deepEqual(rows.map(p=>p.precio_cop),[0,9900,24900]);
    });
    await t.test('Básico es el plan predeterminado y no permite guardar',async()=>{
      assert.equal((await plan(2)).codigo,'basico'); await blocked(save(2,'bloqueado'));
    });
    await t.test('solo las dos cuentas verificadas son administradores',async()=>{
      assert.equal((await plan(0)).es_admin,true);assert.equal((await plan(1)).es_admin,true);
      assert.equal((await plan(2)).es_admin,false);
      assert.equal((await plan(0)).codigo,'experto');
      await blocked(db.query("update public.perfiles set rol='admin' where id=$1",[ids[2]]));
    });
    await t.test('usuario no puede asignarse un plan ni editar la suscripción',async()=>{
      await blocked(assign(2,'visitante','experto'));
      await blocked(as(2,"insert into public.suscripciones(usuario_id,plan,vence_en,asignado_por) values($1,'experto',now()+interval '1 year',$1)",[ids[2]]));
    });
    await t.test('solicitud propia admite upsert y no admite suplantar a otro',async()=>{
      await as(2,"insert into public.solicitudes_plan(usuario_id,plan) values($1,'vip') on conflict(usuario_id) do update set usuario_id=excluded.usuario_id,plan=excluded.plan",[ids[2]]);
      await blocked(as(2,"insert into public.solicitudes_plan(usuario_id,plan) values($1,'vip')",[ids[3]]));
    });
    await t.test('Nico asigna VIP por un mes sin convertir al usuario en admin',async()=>{
      await assign(0,'visitante','vip'); const p=await plan(2);
      assert.equal(p.codigo,'vip');assert.equal(p.es_admin,false);assert.equal(p.max_escenarios,10);
      const s=(await db.query('select vence_en>now() as activa from public.suscripciones where usuario_id=$1',[ids[2]])).rows[0];assert.equal(s.activa,true);
      assert.equal((await as(2,'select * from public.solicitudes_plan')).rows.length,0);
    });
    await t.test('VIP guarda y compara dos escenarios, pero no exporta',async()=>{
      first=await save(2,'uno');second=await save(2,'dos');
      const data=(await as(2,'select public.comparar_escenarios($1) as datos',[[first,second]])).rows[0].datos;
      assert.equal(data.length,2);await blocked(as(2,'select public.exportar_escenarios($1)',[[first]]));
    });
    await t.test('cupo VIP se comprueba en el servidor',async()=>{
      for(let i=2;i<10;i++)await save(2,'variante '+i);
      await blocked(save(2,'once'));
    });
    await t.test('Martín puede asignar Experto y habilitar exportación',async()=>{
      await assign(1,'visitante','experto');await assign(1,'otro','experto');
      const datos=(await as(2,'select public.exportar_escenarios($1) as datos',[[first]])).rows[0].datos;
      assert.equal(datos.length,1);other=await save(3,'privado');
    });
    await t.test('un usuario no puede leer, borrar, comparar ni exportar escenarios ajenos',async()=>{
      assert.equal((await as(3,'select * from public.escenarios where id=$1',[first])).rows.length,0);
      assert.equal((await as(3,'delete from public.escenarios where id=$1 returning *',[first])).rows.length,0);
      await blocked(as(2,'select public.comparar_escenarios($1)',[[first,other]]));
      await blocked(as(2,'select public.exportar_escenarios($1)',[[other]]));
    });
    await t.test('Experto permite cinco comparaciones y rechaza seis',async()=>{
      const own=(await as(2,'select id from public.escenarios order by nombre limit 6')).rows.map(x=>x.id);
      assert.equal((await as(2,'select public.comparar_escenarios($1) as datos',[own.slice(0,5)])).rows[0].datos.length,5);
      await blocked(as(2,'select public.comparar_escenarios($1)',[own]));
    });
    await t.test('al vencer vuelve a Básico y bloquea guardar, comparar y exportar',async()=>{
      await db.query("update public.suscripciones set vence_en=now()-interval '1 second' where usuario_id=$1",[ids[2]]);
      assert.equal((await plan(2)).codigo,'basico');await blocked(save(2,'vencido'));
      await blocked(as(2,'select public.comparar_escenarios($1)',[[first,second]]));
      await blocked(as(2,'select public.exportar_escenarios($1)',[[first]]));
      assert.equal((await as(2,'select count(*)::int as n from public.escenarios')).rows[0].n,10);
    });
    await t.test('datos inválidos y API anónima quedan bloqueados',async()=>{
      await assert.rejects(assign(0,'visitante','superadmin'),/Plan no válido/);
      await db.exec('set role anon');
      try{await assert.rejects(db.query('select public.mi_plan()'),e=>e.code==='42501');}finally{await db.exec('reset role');}
      assert.equal((await db.query("select has_schema_privilege('authenticated','f1_private','USAGE') as acceso")).rows[0].acceso,false);
    });
  }finally{await db.close();}
});
