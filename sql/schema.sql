-- ============================================================================
-- F1 Predictor — esquema de la base de datos (PostgreSQL / Supabase)
--
-- Pegar entero en Supabase → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- Tres ideas que conviene entender antes de leer el SQL:
--
--   1. La seguridad vive AQUI, no en el JavaScript. La web publicada lleva la
--      clave anon a la vista de cualquiera, asi que las politicas RLS son la
--      unica frontera real. Todo lo que no este permitido abajo, no se puede
--      hacer por mucho que alguien manipule el navegador.
--
--   2. Una quiniela no se puede enviar ni cambiar despues de que cierre el
--      plazo. Eso se comprueba en la politica de RLS con la hora del servidor,
--      no con la del cliente, que es trivial de falsear.
--
--   3. Nadie ve la quiniela de otro hasta que cierra el plazo. Sin esto,
--      copiar la del lider seria la estrategia dominante.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PERFILES
-- Supabase guarda el correo y la contrasena en auth.users, que es suyo y no se
-- toca. Todo lo publico (nick, avatar, rol) va aqui.
-- ---------------------------------------------------------------------------
create table if not exists public.perfiles (
  id          uuid primary key references auth.users on delete cascade,
  usuario     text unique not null check (usuario ~ '^[a-zA-Z0-9_]{3,20}$'),
  nombre      text check (char_length(nombre) <= 60),
  avatar      text check (char_length(avatar) <= 8),
  equipo_fav  text check (char_length(equipo_fav) <= 40),
  rol         text not null default 'usuario' check (rol in ('usuario', 'admin')),
  creado_en   timestamptz not null default now()
);

comment on table public.perfiles is
  'Datos publicos del usuario. El correo NUNCA se expone aqui: vive en auth.users.';

-- Al registrarse, Supabase crea la fila en auth.users. Este trigger crea la de
-- perfiles en la misma transaccion, para que no exista un usuario sin perfil.
create or replace function public.crear_perfil()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  nick text;
begin
  nick := coalesce(
    new.raw_user_meta_data->>'usuario',
    -- Si no mando nick, se fabrica uno del correo y se limpia lo que no valga.
    regexp_replace(split_part(new.email, '@', 1), '[^a-zA-Z0-9_]', '', 'g')
  );

  if char_length(nick) < 3 then
    nick := 'piloto' || substr(new.id::text, 1, 6);
  end if;

  -- Colision de nicks: se le pega un sufijo en vez de reventar el registro.
  if exists (select 1 from public.perfiles where usuario = nick) then
    nick := nick || substr(md5(new.id::text), 1, 4);
  end if;

  insert into public.perfiles (id, usuario, nombre, avatar)
  values (
    new.id,
    left(nick, 20),
    new.raw_user_meta_data->>'nombre',
    coalesce(new.raw_user_meta_data->>'avatar', '🏎️')
  );
  return new;
end;
$$;

drop trigger if exists al_crear_usuario on auth.users;
create trigger al_crear_usuario
  after insert on auth.users
  for each row execute function public.crear_perfil();


-- ---------------------------------------------------------------------------
-- GRANDES PREMIOS
-- Espejo del calendario que ya genera el pipeline (web/data/index.json). Hace
-- falta en la base de datos porque el plazo de cierre tiene que comprobarse
-- contra la hora del servidor.
-- ---------------------------------------------------------------------------
create table if not exists public.grandes_premios (
  slug        text primary key,
  evento      text not null,
  lugar       text,
  pais        text,
  ronda       int,
  temporada   int not null,
  fecha       date,
  cierra_en   timestamptz not null,   -- normalmente la hora de la clasificacion
  disputado   boolean not null default false
);

comment on column public.grandes_premios.cierra_en is
  'Momento a partir del cual ya no se admiten quinielas. Se compara con now() en RLS.';


-- ---------------------------------------------------------------------------
-- QUINIELAS
-- La prediccion de un usuario para un GP. Una por usuario y carrera.
-- ---------------------------------------------------------------------------
create table if not exists public.quinielas (
  id           bigint generated always as identity primary key,
  usuario_id   uuid not null references public.perfiles(id) on delete cascade,
  evento_slug  text not null references public.grandes_premios(slug) on delete cascade,

  -- driver_id en orden: top10[1] es quien el usuario cree que gana.
  top10        text[] not null check (array_length(top10, 1) = 10),
  abandonos    int check (abandonos between 0 and 20),

  enviada_en   timestamptz not null default now(),

  -- Se rellenan al puntuar. Nulos = todavia no se ha corrido la carrera.
  puntos       int,
  detalle      jsonb,
  puntuada_en  timestamptz,

  unique (usuario_id, evento_slug)
);

create index if not exists quinielas_evento_idx  on public.quinielas (evento_slug);
create index if not exists quinielas_usuario_idx on public.quinielas (usuario_id);

-- Sin driver_id repetidos: si no, alguien pone al favorito diez veces.
create or replace function public.top10_sin_repetidos(t text[])
returns boolean language sql immutable as $$
  select count(distinct x) = 10 from unnest(t) as x;
$$;

alter table public.quinielas drop constraint if exists quinielas_top10_unicos;
alter table public.quinielas add constraint quinielas_top10_unicos
  check (public.top10_sin_repetidos(top10));


-- ---------------------------------------------------------------------------
-- RESULTADOS OFICIALES
-- El top10 real de cada carrera, que es contra lo que se puntua. Lo escribe un
-- admin, o el workflow de GitHub con la clave de servicio.
-- ---------------------------------------------------------------------------
create table if not exists public.resultados_gp (
  evento_slug  text primary key references public.grandes_premios(slug) on delete cascade,
  top10        text[] not null check (array_length(top10, 1) = 10),
  abandonos    int not null default 0,
  -- El top10 que predijo el modelo, para poder puntuarlo con la misma vara.
  top10_modelo text[],
  cargado_en   timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- CUOTAS DE CASAS DE APUESTAS
-- Polymarket se lee en vivo desde el navegador y no se guarda. Aqui van las
-- casas que no tienen API abierta (BetPlay), cargadas a mano por un admin.
-- ---------------------------------------------------------------------------
create table if not exists public.cuotas (
  id           bigint generated always as identity primary key,
  casa         text not null,              -- 'BetPlay', 'Bet365'...
  mercado      text not null,              -- 'campeon_pilotos', 'ganador_gp'
  evento_slug  text references public.grandes_premios(slug) on delete cascade,
  seleccion    text not null,              -- nombre del piloto o del equipo
  cuota        numeric(8,2) not null check (cuota > 1),
  actualizado  timestamptz not null default now(),
  cargado_por  uuid references public.perfiles(id) on delete set null
);

-- Una unica cuota por casa/mercado/seleccion. Va como indice y no como
-- constraint porque lleva una expresion: en un UNIQUE de tabla, evento_slug
-- nulo (los mercados de temporada) no chocaria consigo mismo y se colarian
-- duplicados justo en el caso mas comun.
create unique index if not exists cuotas_unicas_idx
  on public.cuotas (casa, mercado, coalesce(evento_slug, ''), seleccion);

comment on column public.cuotas.cuota is
  'Cuota decimal europea. La probabilidad implicita es 1/cuota, y la suma de '
  '1/cuota de todas las selecciones pasa de 1: ese exceso es el margen de la casa.';


-- ============================================================================
-- PUNTUACION
--
-- El reparto premia acertar el orden, no solo los nombres:
--
--   posicion exacta ............. 15 pts
--   piloto en el top10, movido ... 5 pts, menos 1 por posicion de error
--   acertar el ganador .......... +25 pts
--   podio entero en orden ....... +30 pts
--   abandonos exactos ........... +10 pts
--
-- Un pleno perfecto son 215 puntos.
-- ============================================================================
create or replace function public.calcular_puntos(pronostico text[], real_ text[], aband_pron int, aband_real int)
returns table (puntos int, detalle jsonb)
language plpgsql immutable
as $$
declare
  i int;
  pos_real int;
  exactos int := 0;
  movidos int := 0;
  total int := 0;
  bonus int := 0;
begin
  for i in 1..10 loop
    pos_real := array_position(real_, pronostico[i]);

    if pos_real = i then
      exactos := exactos + 1;
      total := total + 15;
    elsif pos_real is not null then
      movidos := movidos + 1;
      -- 5 puntos por estar, menos la distancia. Nunca resta.
      total := total + greatest(0, 5 - abs(pos_real - i));
    end if;
  end loop;

  if pronostico[1] = real_[1] then
    bonus := bonus + 25;
  end if;

  if pronostico[1] = real_[1] and pronostico[2] = real_[2] and pronostico[3] = real_[3] then
    bonus := bonus + 30;
  end if;

  if aband_pron is not null and aband_pron = aband_real then
    bonus := bonus + 10;
  end if;

  puntos := total + bonus;
  detalle := jsonb_build_object(
    'exactos', exactos,
    'movidos', movidos,
    'base', total,
    'bonus', bonus,
    'ganador', pronostico[1] = real_[1]
  );
  return next;
end;
$$;


-- Puntua todas las quinielas de un GP. Idempotente: se puede repetir.
create or replace function public.puntuar_evento(slug text)
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  res public.resultados_gp%rowtype;
  n int := 0;
begin
  select * into res from public.resultados_gp where evento_slug = slug;
  if not found then
    raise exception 'No hay resultado cargado para %', slug;
  end if;

  update public.quinielas q
     set puntos = c.puntos,
         detalle = c.detalle,
         puntuada_en = now()
    from lateral public.calcular_puntos(q.top10, res.top10, q.abandonos, res.abandonos) c
   where q.evento_slug = slug;

  get diagnostics n = row_count;

  update public.grandes_premios set disputado = true where grandes_premios.slug = puntuar_evento.slug;
  return n;
end;
$$;

comment on function public.puntuar_evento is
  'Puntua un GP entero. security definer porque escribe en quinielas ajenas, '
  'que es justo lo que RLS impide al usuario normal.';


-- Cuantas quinielas hay para un GP. RLS impide ver las ajenas antes del
-- cierre, pero el numero no revela nada y anima a jugar ("37 ya enviadas").
-- security definer para poder contar lo que el usuario no puede leer.
create or replace function public.contar_quinielas(slug text)
returns int
language sql stable
security definer set search_path = public
as $$
  select count(*)::int from public.quinielas where evento_slug = slug;
$$;


-- ---------------------------------------------------------------------------
-- CLASIFICACION GENERAL
-- Vista, no tabla: siempre coherente, imposible que se desincronice.
-- security_invoker para que respete las politicas de quien la consulta.
--
-- Parece que RLS deberia romper el ranking, porque un usuario no ve las
-- quinielas ajenas de un GP todavia abierto. No lo rompe, y el motivo es que
-- solo cuenta las que tienen puntos, y una quiniela solo se puntua despues de
-- la carrera, cuando el GP ya cerro y por tanto es visible para todos.
-- ---------------------------------------------------------------------------
create or replace view public.tabla_general
with (security_invoker = true)
as
select
  p.id,
  p.usuario,
  p.avatar,
  p.equipo_fav,
  coalesce(sum(q.puntos), 0)::int          as puntos,
  count(q.puntos)::int                     as jugadas,
  coalesce(max(q.puntos), 0)::int          as mejor,
  round(coalesce(avg(q.puntos), 0), 1)     as media,
  count(*) filter (where (q.detalle->>'ganador')::boolean)::int as ganadores
from public.perfiles p
left join public.quinielas q on q.usuario_id = p.id and q.puntos is not null
group by p.id, p.usuario, p.avatar, p.equipo_fav;


-- ============================================================================
-- ROW LEVEL SECURITY
-- Sin esto, la clave anon de la web publicada permitiria leer y escribir todo.
-- ============================================================================
alter table public.perfiles        enable row level security;
alter table public.quinielas       enable row level security;
alter table public.grandes_premios enable row level security;
alter table public.resultados_gp   enable row level security;
alter table public.cuotas          enable row level security;

create or replace function public.es_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where id = auth.uid() and rol = 'admin');
$$;

-- --- perfiles ---
drop policy if exists perfiles_lectura on public.perfiles;
create policy perfiles_lectura on public.perfiles
  for select using (true);   -- el nick y el avatar son publicos: hay ranking

drop policy if exists perfiles_propio on public.perfiles;
create policy perfiles_propio on public.perfiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- El rol NO puede cambiarlo el propio usuario: si no, cualquiera se ascenderia
-- a admin con un update a su propia fila, que la politica de arriba permite.
-- Va en un trigger y no en el with check de la politica porque una politica
-- sobre perfiles que consulte perfiles se llama a si misma y recurre.
create or replace function public.proteger_rol()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() nulo = no hay usuario de la web detras: es el SQL Editor de
  -- Supabase o la clave de servicio. Ahi se deja pasar, porque si no seria
  -- imposible nombrar al primer admin. Un usuario anonimo de la web tampoco
  -- llega hasta aqui: la politica perfiles_propio le impide cualquier update.
  if new.rol is distinct from old.rol
     and auth.uid() is not null
     and not public.es_admin() then
    raise exception 'Solo un admin puede cambiar el rol';
  end if;
  return new;
end;
$$;

drop trigger if exists no_tocar_rol on public.perfiles;
create trigger no_tocar_rol
  before update on public.perfiles
  for each row execute function public.proteger_rol();

-- --- grandes premios y resultados: lectura publica, escritura de admin ---
drop policy if exists gp_lectura on public.grandes_premios;
create policy gp_lectura on public.grandes_premios for select using (true);

drop policy if exists gp_admin on public.grandes_premios;
create policy gp_admin on public.grandes_premios for all
  using (public.es_admin()) with check (public.es_admin());

drop policy if exists res_lectura on public.resultados_gp;
create policy res_lectura on public.resultados_gp for select using (true);

drop policy if exists res_admin on public.resultados_gp;
create policy res_admin on public.resultados_gp for all
  using (public.es_admin()) with check (public.es_admin());

-- --- cuotas: lectura publica, carga de admin ---
drop policy if exists cuotas_lectura on public.cuotas;
create policy cuotas_lectura on public.cuotas for select using (true);

drop policy if exists cuotas_admin on public.cuotas;
create policy cuotas_admin on public.cuotas for all
  using (public.es_admin()) with check (public.es_admin());

-- --- quinielas: la parte importante ---

-- Se ve la propia siempre; la de los demas solo cuando ya cerro el plazo.
drop policy if exists quinielas_lectura on public.quinielas;
create policy quinielas_lectura on public.quinielas
  for select using (
    auth.uid() = usuario_id
    or exists (
      select 1 from public.grandes_premios g
       where g.slug = quinielas.evento_slug and g.cierra_en <= now()
    )
  );

-- Solo la propia, y solo antes del cierre. now() es la hora del servidor:
-- cambiar el reloj del ordenador no sirve de nada.
drop policy if exists quinielas_insertar on public.quinielas;
create policy quinielas_insertar on public.quinielas
  for insert with check (
    auth.uid() = usuario_id
    and exists (
      select 1 from public.grandes_premios g
       where g.slug = evento_slug and g.cierra_en > now()
    )
  );

drop policy if exists quinielas_editar on public.quinielas;
create policy quinielas_editar on public.quinielas
  for update using (
    auth.uid() = usuario_id
    and exists (
      select 1 from public.grandes_premios g
       where g.slug = evento_slug and g.cierra_en > now()
    )
  )
  with check (auth.uid() = usuario_id);

drop policy if exists quinielas_borrar on public.quinielas;
create policy quinielas_borrar on public.quinielas
  for delete using (
    auth.uid() = usuario_id
    and exists (
      select 1 from public.grandes_premios g
       where g.slug = evento_slug and g.cierra_en > now()
    )
  );


-- ============================================================================
-- TIEMPO REAL
-- Sin esto, supabase.channel(...) se suscribe y no llega nunca nada.
-- ============================================================================
-- El do/exception es lo que hace que el script se pueda volver a ejecutar:
-- 'add table' falla si la tabla ya esta en la publicacion.
do $$
begin
  alter publication supabase_realtime add table public.quinielas;
exception
  when duplicate_object then null;
end;
$$;

-- La vista no emite eventos, asi que el ranking se refresca cuando cambia la
-- tabla que hay debajo. Es lo que escucha web/js/quiniela.js.
