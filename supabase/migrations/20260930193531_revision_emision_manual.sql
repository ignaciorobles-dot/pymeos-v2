-- Revisión humana y reserva exclusiva antes de cualquier llamada externa.
-- No emite comprobantes ni altera ventas, caja, stock o CAE existentes.
alter table public.comprobantes
  add column revision_estado text not null default 'pendiente' check (revision_estado in ('pendiente','listo','observado')),
  add column revision_huella text,
  add column revisado_por uuid references auth.users(id),
  add column revisado_at timestamptz,
  add column revision_nota text,
  add column envio_solicitado_por uuid references auth.users(id),
  add column envio_solicitado_at timestamptz;

create table public.fiscal_auditoria (
  id bigint generated always as identity primary key,
  comprobante_id uuid not null references public.comprobantes(id),
  actor_id uuid references auth.users(id),
  evento text not null,
  detalle jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index fiscal_auditoria_comprobante_idx on public.fiscal_auditoria(comprobante_id,created_at);
alter table public.fiscal_auditoria enable row level security;
create policy fiscal_auditoria_lectura on public.fiscal_auditoria for select to authenticated
  using (public.mi_rol() in ('dueno','contador'));
grant select on public.fiscal_auditoria to authenticated;

create function public.huella_fiscal(p_id uuid) returns text
language sql stable set search_path = public as $$
  select md5((jsonb_build_object('cabecera',
    to_jsonb(c) - array['estado','numero','cae','cae_vencimiento','qr_url','observacion','emitido_at',
      'job_id','intento','idempotency_key','revision_estado','revision_huella','revisado_por',
      'revisado_at','revision_nota','envio_solicitado_por','envio_solicitado_at'],
    'lineas',coalesce((select jsonb_agg(to_jsonb(l) order by l.orden,l.id)
      from public.comprobante_lineas l where l.comprobante_id=c.id),'[]'::jsonb)))::text)
  from public.comprobantes c where c.id=p_id;
$$;
revoke all on function public.huella_fiscal(uuid) from public,anon;
grant execute on function public.huella_fiscal(uuid) to authenticated,service_role;

create function public.vista_revision_fiscal(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(public.mi_rol(),'') not in ('dueno','contador') then raise exception 'Solo dueño o contador puede revisar'; end if;
  return (select jsonb_build_object('comprobante',to_jsonb(c),'huella',public.huella_fiscal(c.id),
    'lineas',coalesce((select jsonb_agg(to_jsonb(l) order by l.orden,l.id) from public.comprobante_lineas l where l.comprobante_id=c.id),'[]'::jsonb))
    from public.comprobantes c where c.id=p_id);
end; $$;
revoke all on function public.vista_revision_fiscal(uuid) from public,anon;
grant execute on function public.vista_revision_fiscal(uuid) to authenticated;

create function public.revisar_comprobante(p_id uuid,p_sucursal_id uuid,p_huella text,p_listo boolean,p_nota text default '') returns void
language plpgsql security definer set search_path = public as $$
declare c public.comprobantes; n numeric; i numeric; t numeric; cuantos integer;
begin
  if coalesce(public.mi_rol(),'') not in ('dueno','contador') then raise exception 'Solo dueño o contador puede revisar'; end if;
  select * into c from public.comprobantes where id=p_id for update;
  if not found or p_sucursal_id is null or c.sucursal_id<>p_sucursal_id then raise exception 'Sucursal incorrecta'; end if;
  if c.estado not in ('pendiente','rechazado') or c.job_id is not null or c.idempotency_key is not null or c.cae is not null then
    raise exception 'Ya enviado: conciliar el resultado antes de modificar'; end if;
  if p_huella is null or p_huella is distinct from public.huella_fiscal(p_id) then raise exception 'Los datos cambiaron. Volvé a revisar'; end if;
  if p_listo then
    select count(*),sum(neto),sum(iva),sum(subtotal) into cuantos,n,i,t from public.comprobante_lineas where comprobante_id=p_id;
    if cuantos=0 or n<>c.neto or i<>c.iva or t<>c.total or c.neto+c.iva<>c.total or c.total<=0 then raise exception 'Los totales o renglones no coinciden'; end if;
    if c.venta_id is not null and c.tipo in ('A','B','C') and not exists
      (select 1 from public.ventas v where v.id=c.venta_id and v.estado='completada' and v.total=c.total and v.sucursal_id=c.sucursal_id)
      then raise exception 'La venta cambió o fue anulada'; end if;
  end if;
  update public.comprobantes set revision_estado=case when p_listo then 'listo' else 'observado' end,
    revision_huella=case when p_listo then p_huella else null end,revisado_por=auth.uid(),revisado_at=now(),revision_nota=p_nota where id=p_id;
  insert into public.fiscal_auditoria(comprobante_id,actor_id,evento,detalle)
    values(p_id,auth.uid(),case when p_listo then 'revisado' else 'observado' end,jsonb_build_object('huella',p_huella,'nota',p_nota));
end; $$;
revoke all on function public.revisar_comprobante(uuid,uuid,text,boolean,text) from public,anon;
grant execute on function public.revisar_comprobante(uuid,uuid,text,boolean,text) to authenticated;

create function public.reservar_envio_fiscal(p_id uuid,p_actor uuid,p_sucursal_id uuid,p_huella text) returns text
language plpgsql security definer set search_path = public as $$
declare c public.comprobantes; clave text;
begin
  if not public.es_servicio() then raise exception 'Solo servicio'; end if;
  if not exists(select 1 from public.usuarios where user_id=p_actor and activo and rol in ('dueno','contador')) then raise exception 'Responsable no autorizado'; end if;
  select * into c from public.comprobantes where id=p_id for update;
  if not found or p_sucursal_id is null or c.sucursal_id<>p_sucursal_id then raise exception 'Sucursal incorrecta'; end if;
  if c.idempotency_key is not null or c.job_id is not null or c.cae is not null then raise exception 'Ya solicitado. Consultá o conciliá; no se vuelve a emitir'; end if;
  if c.estado not in ('pendiente','rechazado') or c.revision_estado<>'listo' or p_huella is null
    or c.revision_huella is distinct from p_huella or p_huella is distinct from public.huella_fiscal(p_id)
    then raise exception 'Falta revisar la versión actual del comprobante'; end if;
  if c.venta_id is not null and c.tipo in ('A','B','C') then
    -- Mismo orden que las operaciones de venta: bloquear la venta y verificar su estado.
    perform 1 from public.ventas where id=c.venta_id and estado='completada' and total=c.total and sucursal_id=c.sucursal_id for update;
    if not found then raise exception 'La venta cambió o fue anulada'; end if;
    if exists(select 1 from public.comprobantes x where x.venta_id=c.venta_id and x.id<>c.id and x.tipo in ('A','B','C')
      and (x.cae is not null or x.job_id is not null or x.idempotency_key is not null)) then raise exception 'Esta venta tiene otro envío. Conciliar primero'; end if;
  end if;
  clave := 'comp:'||p_id::text||':manual';
  update public.comprobantes set idempotency_key=clave,intento=intento+1,estado='pendiente',
    envio_solicitado_por=p_actor,envio_solicitado_at=now() where id=p_id;
  insert into public.fiscal_auditoria(comprobante_id,actor_id,evento,detalle)
    values(p_id,p_actor,'envio_autorizado',jsonb_build_object('huella',p_huella,'clave',clave));
  return clave;
end; $$;
revoke all on function public.reservar_envio_fiscal(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.reservar_envio_fiscal(uuid,uuid,uuid,text) to service_role;

-- Cabecera y líneas quedan congeladas desde la reserva, incluso si se pierde la respuesta.
create function public.proteger_borrador_enviado() returns trigger language plpgsql set search_path=public as $$
begin
  if new.cae is distinct from old.cae and not public.es_servicio() and coalesce(public.mi_rol(),'') not in ('dueno','contador') then
    raise exception 'Solo responsable fiscal o servicio puede registrar un CAE'; end if;
  if old.idempotency_key is not null or old.job_id is not null or old.cae is not null then
    if (to_jsonb(new) - array['estado','numero','cae','cae_vencimiento','qr_url','observacion','emitido_at','job_id'])
      is distinct from (to_jsonb(old) - array['estado','numero','cae','cae_vencimiento','qr_url','observacion','emitido_at','job_id']) then
      raise exception 'Comprobante enviado: datos congelados, requiere conciliación o nota de crédito'; end if;
  end if;
  return new;
end; $$;
create trigger proteger_borrador_enviado before update on public.comprobantes for each row execute function public.proteger_borrador_enviado();
create function public.proteger_lineas_enviadas() returns trigger language plpgsql set search_path=public as $$
declare p uuid; c public.comprobantes;
begin
  p:=case when tg_op='DELETE' then old.comprobante_id else new.comprobante_id end;
  if tg_op='UPDATE' and old.comprobante_id<>new.comprobante_id then raise exception 'No se trasladan renglones'; end if;
  select * into c from public.comprobantes where id=p for update;
  if c.idempotency_key is not null or c.job_id is not null or c.cae is not null then raise exception 'Comprobante enviado: renglones congelados'; end if;
  if tg_op='DELETE' then return old; end if; return new;
end; $$;
create trigger proteger_lineas_enviadas before insert or update or delete on public.comprobante_lineas for each row execute function public.proteger_lineas_enviadas();
revoke all on function public.proteger_borrador_enviado(),public.proteger_lineas_enviadas() from public,anon,authenticated;

-- Todas las ventas no emitidas, incluidas las que aún no tienen borrador. Sin ocultarlas.
create function public.ventas_pendientes_fiscales(p_sucursal_id uuid,p_desde date,p_hasta date,p_offset integer default 0)
returns table(venta_id uuid,numero bigint,fecha date,total numeric,cliente text,comprobante_id uuid,estado text,revision text,total_filas bigint)
language sql stable security invoker set search_path=public as $$
  select v.id,v.numero::bigint,(v.created_at at time zone 'America/Argentina/Cordoba')::date,v.total,
    coalesce(cl.nombre,'Consumidor final'),c.id,coalesce(c.estado,'sin_borrador'),
    case when c.job_id is not null then 'enviado' when c.idempotency_key is not null then 'por_conciliar' else coalesce(c.revision_estado,'pendiente') end,count(*) over()
  from public.ventas v left join public.clientes cl on cl.id=v.cliente_id
  left join lateral (select x.* from public.comprobantes x where x.venta_id=v.id and x.tipo in ('A','B','C')
    order by (x.cae is not null) desc,x.created_at desc,x.id limit 1) c on true
  where v.estado='completada' and (p_sucursal_id is null or v.sucursal_id=p_sucursal_id)
    and v.created_at >= (p_desde::timestamp at time zone 'America/Argentina/Cordoba')
    and v.created_at < ((p_hasta+1)::timestamp at time zone 'America/Argentina/Cordoba')
    and c.cae is null
  order by v.created_at desc,v.id limit 100 offset greatest(p_offset,0);
$$;
revoke all on function public.ventas_pendientes_fiscales(uuid,date,date,integer) from public,anon;
grant execute on function public.ventas_pendientes_fiscales(uuid,date,date,integer) to authenticated;

create function public.proteger_venta_en_emision() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if (new.estado,new.total,new.cliente_id) is distinct from (old.estado,old.total,old.cliente_id)
    and exists(select 1 from public.comprobantes where venta_id=old.id and tipo in ('A','B','C')
      and envio_solicitado_at is not null and estado<>'anulado') then
    raise exception 'Venta enviada: conciliar la emisión o emitir su nota de crédito antes de corregirla'; end if;
  return new;
end; $$;
create trigger proteger_venta_en_emision before update on public.ventas for each row execute function public.proteger_venta_en_emision();
revoke all on function public.proteger_venta_en_emision() from public,anon,authenticated;
