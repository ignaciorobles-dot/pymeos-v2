-- Descarte auditable: nunca elimina ventas, cobros, stock ni documentos fiscales.
create function public.descartar_borrador_fiscal(p_id uuid,p_sucursal_id uuid,p_motivo text)
returns void language plpgsql security definer set search_path=public as $$
declare c public.comprobantes;
begin
  if auth.uid() is null or coalesce(public.mi_rol(),'')<>'dueno' then
    raise exception 'Solo el dueño puede descartar borradores'; end if;
  if p_motivo is null or length(btrim(p_motivo))<3 or length(p_motivo)>1000 then
    raise exception 'Indicá un motivo de entre 3 y 1000 caracteres'; end if;
  select * into c from public.comprobantes where id=p_id for update;
  if not found or p_sucursal_id is null or c.sucursal_id<>p_sucursal_id then
    raise exception 'Sucursal incorrecta'; end if;
  if c.estado not in ('pendiente','rechazado') or c.cae is not null or c.numero is not null
    or c.emitido_at is not null or c.job_id is not null or c.idempotency_key is not null
    or c.envio_solicitado_at is not null or coalesce(c.intento,0)>0 then
    raise exception 'Solo se descartan borradores nunca enviados y sin numeración fiscal'; end if;
  if exists(select 1 from public.comprobantes where comprobante_origen_id=p_id) then
    raise exception 'El comprobante tiene documentos asociados'; end if;
  update public.comprobantes set estado='anulado',motivo='Borrador descartado: '||btrim(p_motivo),
    revision_estado='observado',revision_huella=null where id=p_id;
  insert into public.fiscal_auditoria(comprobante_id,actor_id,evento,detalle)
    values(p_id,auth.uid(),'borrador_descartado',jsonb_build_object('motivo',btrim(p_motivo),'antes',to_jsonb(c)));
end; $$;
revoke all on function public.descartar_borrador_fiscal(uuid,uuid,text) from public,anon;
grant execute on function public.descartar_borrador_fiscal(uuid,uuid,text) to authenticated;

-- Protege también ante una actualización concurrente de una RPC antigua.
create function public.proteger_borrador_descartado() returns trigger
language plpgsql set search_path=public as $$
begin
  if old.estado='anulado' and old.cae is null then
    raise exception 'Borrador descartado: historial inmutable, prepará uno nuevo'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end; $$;
create trigger proteger_borrador_descartado before update or delete on public.comprobantes
  for each row execute function public.proteger_borrador_descartado();
revoke all on function public.proteger_borrador_descartado() from public,anon,authenticated;

-- Descartar el borrador NO oculta la venta pendiente. Puede prepararse uno nuevo.
create or replace function public.ventas_pendientes_fiscales(p_sucursal_id uuid,p_desde date,p_hasta date,p_offset integer default 0)
returns table(venta_id uuid,numero bigint,fecha date,total numeric,cliente text,comprobante_id uuid,estado text,revision text,total_filas bigint)
language sql stable security invoker set search_path=public as $$
  select v.id,v.numero::bigint,(v.created_at at time zone 'America/Argentina/Cordoba')::date,v.total,
    coalesce(cl.nombre,'Consumidor final'),c.id,coalesce(c.estado,'sin_borrador'),
    case when c.job_id is not null then 'enviado' when c.idempotency_key is not null then 'por_conciliar' else coalesce(c.revision_estado,'pendiente') end,count(*) over()
  from public.ventas v left join public.clientes cl on cl.id=v.cliente_id
  left join lateral (select x.* from public.comprobantes x where x.venta_id=v.id and x.tipo in ('A','B','C')
    and not (x.estado='anulado' and x.cae is null)
    order by (x.cae is not null) desc,x.created_at desc,x.id limit 1) c on true
  where v.estado='completada' and (p_sucursal_id is null or v.sucursal_id=p_sucursal_id)
    and v.created_at >= (p_desde::timestamp at time zone 'America/Argentina/Cordoba')
    and v.created_at < ((p_hasta+1)::timestamp at time zone 'America/Argentina/Cordoba')
    and c.cae is null
  order by v.created_at desc,v.id limit 100 offset greatest(p_offset,0);
$$;
