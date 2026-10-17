-- Requiere schema.sql y las cuentas verificadas de Nico y Martin.
begin;
create schema if not exists f1_private;
revoke all on schema f1_private from public, anon, authenticated;

create table f1_private.f1_administradores (
  usuario_id uuid primary key references public.perfiles(id) on delete cascade
);
alter table f1_private.f1_administradores enable row level security;
revoke all on f1_private.f1_administradores from public, anon, authenticated;
insert into f1_private.f1_administradores(usuario_id)
  select id from public.perfiles where usuario in ('Nico_f1','martin_1112') and rol='admin';
do $$ begin
  if (select count(*) from f1_private.f1_administradores) <> 2 then
    raise exception 'Faltan las dos cuentas de administrador verificadas';
  end if;
end $$;

create or replace function public.es_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from f1_private.f1_administradores a
    join public.perfiles p on p.id=a.usuario_id
    where a.usuario_id=(select auth.uid()) and p.rol='admin');
$$;

create or replace function public.proteger_rol()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.rol='admin') is distinct from
     exists(select 1 from f1_private.f1_administradores a where a.usuario_id=new.id) then
    raise exception 'Solo las dos cuentas autorizadas pueden ser administradores' using errcode='42501';
  end if;
  return new;
end $$;

create table public.planes (
  codigo text primary key, nombre text not null, precio_cop int not null check(precio_cop>=0),
  max_escenarios int not null, max_comparacion int not null, exportar boolean not null
);
insert into public.planes values
  ('basico','Básico',0,0,0,false),('vip','VIP',9900,10,2,false),('experto','Experto',24900,50,5,true);
alter table public.planes enable row level security;
revoke all on public.planes from public,anon,authenticated;
grant select on public.planes to anon,authenticated;
create policy planes_lectura on public.planes for select using(true);

create table public.suscripciones (
  usuario_id uuid primary key references public.perfiles(id) on delete cascade,
  plan text not null references public.planes(codigo),
  vence_en timestamptz,
  asignado_por uuid not null references public.perfiles(id),
  actualizado_en timestamptz not null default now(),
  check ((plan='basico' and vence_en is null) or (plan<>'basico' and vence_en is not null))
);
alter table public.suscripciones enable row level security;
revoke all on public.suscripciones from public,anon,authenticated;
grant select on public.suscripciones to authenticated;
create policy suscripcion_lectura on public.suscripciones for select to authenticated
  using(usuario_id=(select auth.uid()) or (select public.es_admin()));

create table public.solicitudes_plan (
  usuario_id uuid primary key references public.perfiles(id) on delete cascade,
  plan text not null references public.planes(codigo) check(plan in ('vip','experto')),
  creada_en timestamptz not null default now()
);
alter table public.solicitudes_plan enable row level security;
revoke all on public.solicitudes_plan from public,anon,authenticated;
grant select,delete on public.solicitudes_plan to authenticated;
grant insert(usuario_id,plan),update(usuario_id,plan) on public.solicitudes_plan to authenticated;
create policy solicitud_lectura on public.solicitudes_plan for select to authenticated
  using(usuario_id=(select auth.uid()) or (select public.es_admin()));
create policy solicitud_insertar on public.solicitudes_plan for insert to authenticated
  with check(usuario_id=(select auth.uid()));
create policy solicitud_actualizar on public.solicitudes_plan for update to authenticated
  using(usuario_id=(select auth.uid())) with check(usuario_id=(select auth.uid()));
create policy solicitud_borrar on public.solicitudes_plan for delete to authenticated
  using(usuario_id=(select auth.uid()) or (select public.es_admin()));

create function f1_private.plan_para(uid uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when exists(select 1 from f1_private.f1_administradores a join public.perfiles p on p.id=a.usuario_id
      where a.usuario_id=uid and p.rol='admin') then 'experto'
    else coalesce((select s.plan from public.suscripciones s
      where s.usuario_id=uid and (s.plan='basico' or s.vence_en>now())),'basico') end;
$$;
revoke all on function f1_private.plan_para(uuid) from public,anon,authenticated;

create function public.mi_plan()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare datos jsonb;
begin
  if auth.uid() is null then raise exception 'Inicia sesión' using errcode='42501'; end if;
  select to_jsonb(p) || jsonb_build_object('es_admin',public.es_admin(),
    'vence_en',(select s.vence_en from public.suscripciones s where s.usuario_id=auth.uid()))
    into datos from public.planes p where p.codigo=f1_private.plan_para(auth.uid());
  return datos;
end $$;
revoke all on function public.mi_plan() from public,anon;
grant execute on function public.mi_plan() to authenticated;

create function public.asignar_plan(usuario text, nuevo_plan text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare destino uuid; vencimiento timestamptz;
begin
  if not public.es_admin() then raise exception 'Solo Nico y Martín pueden asignar planes' using errcode='42501'; end if;
  if nuevo_plan not in ('basico','vip','experto') or nuevo_plan is null then raise exception 'Plan no válido'; end if;
  select p.id into destino from public.perfiles p where p.usuario=asignar_plan.usuario;
  if destino is null then raise exception 'No existe ese nombre de usuario'; end if;
  vencimiento := case when nuevo_plan='basico' then null else now()+interval '1 month' end;
  insert into public.suscripciones(usuario_id,plan,vence_en,asignado_por)
    values(destino,nuevo_plan,vencimiento,auth.uid())
    on conflict(usuario_id) do update set plan=excluded.plan,vence_en=excluded.vence_en,
      asignado_por=excluded.asignado_por,actualizado_en=now();
  delete from public.solicitudes_plan where usuario_id=destino;
  return jsonb_build_object('plan',nuevo_plan,'vence_en',vencimiento);
end $$;
revoke all on function public.asignar_plan(text,text) from public,anon;
grant execute on function public.asignar_plan(text,text) to authenticated;

create function public.parrilla_valida(parrilla text[])
returns boolean language sql immutable set search_path = '' as $$
  select cardinality(parrilla) between 2 and 30 and
    (select count(distinct x) from unnest(parrilla) x)=cardinality(parrilla);
$$;
create table public.escenarios (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null default auth.uid() references public.perfiles(id) on delete cascade,
  nombre text not null check(char_length(trim(nombre)) between 1 and 80),
  evento_slug text not null,
  parrilla text[] not null check(public.parrilla_valida(parrilla)),
  resultado jsonb not null check(jsonb_typeof(resultado)='array' and jsonb_array_length(resultado) between 2 and 30 and octet_length(resultado::text)<32768),
  creado_en timestamptz not null default now()
);
create index escenarios_usuario_idx on public.escenarios(usuario_id);
alter table public.escenarios enable row level security;
revoke all on public.escenarios from public,anon,authenticated;
grant select,delete on public.escenarios to authenticated;
grant insert(usuario_id,nombre,evento_slug,parrilla,resultado) on public.escenarios to authenticated;
create policy escenario_lectura on public.escenarios for select to authenticated using(usuario_id=(select auth.uid()));
create policy escenario_insertar on public.escenarios for insert to authenticated with check(usuario_id=(select auth.uid()));
create policy escenario_borrar on public.escenarios for delete to authenticated using(usuario_id=(select auth.uid()));

create function f1_private.limitar_escenarios()
returns trigger language plpgsql security definer set search_path = '' as $$
declare limite int;
begin
  if auth.uid() is null or new.usuario_id is distinct from auth.uid() then
    raise exception 'Solo puedes guardar escenarios propios' using errcode='42501';
  end if;
  -- Serializar por cuenta impide superar el cupo con envíos simultáneos.
  perform id from public.perfiles where id=new.usuario_id for update;
  select p.max_escenarios into limite from public.planes p where p.codigo=f1_private.plan_para(new.usuario_id);
  if (select count(*) from public.escenarios where usuario_id=new.usuario_id)>=limite then
    raise exception 'Tu plan no permite guardar más escenarios' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function f1_private.limitar_escenarios() from public,anon,authenticated;
create trigger cupo_escenarios before insert on public.escenarios
  for each row execute function f1_private.limitar_escenarios();

create function f1_private.leer_escenarios(ids uuid[], exportacion boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare permisos public.planes%rowtype; datos jsonb; n int;
begin
  if auth.uid() is null then raise exception 'Inicia sesión' using errcode='42501'; end if;
  select * into permisos from public.planes where codigo=f1_private.plan_para(auth.uid());
  n:=cardinality(ids);
  if n is null or n<1 or n>50 or n<>(select count(distinct x) from unnest(ids) x) then
    raise exception 'Selección de escenarios no válida';
  end if;
  if (exportacion and not permisos.exportar) or
     (not exportacion and (n<2 or n>permisos.max_comparacion)) then
    raise exception 'Tu plan no permite esta operación' using errcode='42501';
  end if;
  select jsonb_agg(to_jsonb(e) order by array_position(ids,e.id)) into datos
    from public.escenarios e where e.id=any(ids) and e.usuario_id=auth.uid();
  if coalesce(jsonb_array_length(datos),0)<>n then
    raise exception 'Solo puedes usar tus propios escenarios' using errcode='42501';
  end if;
  return datos;
end $$;
revoke all on function f1_private.leer_escenarios(uuid[],boolean) from public,anon,authenticated;
create function public.comparar_escenarios(ids uuid[])
returns jsonb language sql stable security definer set search_path = '' as $$
  select f1_private.leer_escenarios(ids,false);
$$;
create function public.exportar_escenarios(ids uuid[])
returns jsonb language sql stable security definer set search_path = '' as $$
  select f1_private.leer_escenarios(ids,true);
$$;
revoke all on function public.comparar_escenarios(uuid[]),public.exportar_escenarios(uuid[]) from public,anon;
grant execute on function public.comparar_escenarios(uuid[]),public.exportar_escenarios(uuid[]) to authenticated;
commit;
