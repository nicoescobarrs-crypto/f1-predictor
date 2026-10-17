-- Aplicar una vez en Supabase SQL Editor a una base que ya tiene schema.sql.
-- No borra ni modifica quinielas existentes. Todo se aplica en una transaccion.
begin;

create or replace function public.puntuar_evento(slug text)
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  res public.resultados_gp%rowtype;
  n int := 0;
begin
  -- SECURITY DEFINER se salta RLS: la autorizacion debe comprobarse aqui.
  if not coalesce(public.es_admin() or auth.role() = 'service_role', false) then
    raise exception 'Solo un admin puede puntuar carreras' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.grandes_premios g
    where g.slug = puntuar_evento.slug and g.cierra_en <= now()
  ) then
    raise exception 'La quiniela aun esta abierta o el GP no existe';
  end if;

  select * into res from public.resultados_gp where evento_slug = slug;
  if not found then
    raise exception 'No hay resultado cargado para %', slug;
  end if;

  update public.quinielas q
     set (puntos, detalle, puntuada_en) = (
       select c.puntos, c.detalle, now()
       from public.calcular_puntos(q.top10, res.top10, q.abandonos, res.abandonos) c
     )
   where q.evento_slug = slug;

  get diagnostics n = row_count;

  update public.grandes_premios set disputado = true where grandes_premios.slug = puntuar_evento.slug;
  return n;
end;
$$;

drop policy if exists quinielas_editar on public.quinielas;
create policy quinielas_editar on public.quinielas
  for update using (
    auth.uid() = usuario_id
    and exists (
      select 1 from public.grandes_premios g
       where g.slug = evento_slug and g.cierra_en > now()
    )
  )
  with check (
    auth.uid() = usuario_id
    and exists (
      select 1 from public.grandes_premios g
       where g.slug = evento_slug and g.cierra_en > now()
    )
  );

revoke insert, update on public.quinielas from public, anon, authenticated;
revoke insert (id, usuario_id, evento_slug, top10, abandonos, enviada_en, puntos, detalle, puntuada_en),
       update (id, usuario_id, evento_slug, top10, abandonos, enviada_en, puntos, detalle, puntuada_en)
  on public.quinielas from public, anon, authenticated;
grant insert (usuario_id, evento_slug, top10, abandonos),
      update (usuario_id, evento_slug, top10, abandonos)
  on public.quinielas to authenticated;

-- Fecha del ultimo envio tomada del servidor, tambien al editar por upsert.
create or replace function public.fechar_quiniela()
returns trigger language plpgsql set search_path = public as $$
begin
  new.enviada_en := now();
  return new;
end;
$$;
drop trigger if exists fecha_envio_quiniela on public.quinielas;
create trigger fecha_envio_quiniela
  before insert or update of usuario_id, evento_slug, top10, abandonos
  on public.quinielas for each row execute function public.fechar_quiniela();

revoke all on function public.puntuar_evento(text) from public, anon;
grant execute on function public.puntuar_evento(text) to authenticated, service_role;

commit;
