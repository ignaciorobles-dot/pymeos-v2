-- Borrar un producto que se cargo mal.
--
-- El sistema no borra nada, y esta bien que sea asi: un producto que se vendio
-- alguna vez tiene que seguir existiendo, porque las ventas viejas lo apuntan y
-- tienen que poder leerse. Para eso esta `activo = false`, que lo saca del
-- mostrador sin romper el pasado.
--
-- Pero hay un caso que descatalogar no resuelve: el producto que se cargo mal
-- hace cinco minutos y nunca se uso. Ese no es historia, es basura, y dejarlo
-- descatalogado para siempre ensucia el catalogo y confunde al que busca.
--
-- Entonces: se puede borrar de verdad, pero solo si nunca se toco. La funcion
-- lo verifica ella misma en vez de confiar en que la pantalla pregunte, porque
-- la pantalla se puede saltear y las claves de la base son publicas.
--
-- Si el producto se uso, no se borra y se avisa por que. El error dice que hay
-- que descatalogarlo, asi el que lo lee sabe que hacer y no vuelve a intentar.

/**
 * Si el producto tiene alguna huella en el sistema.
 *
 * Alcanza con encontrar una sola: por eso son `exists` y no un conteo. Un
 * producto vendido una vez es tan indeleble como uno vendido mil veces.
 */
create or replace function public.producto_en_uso(p_producto_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from public.venta_lineas vl
      join public.variantes v on v.id = vl.variante_id
     where v.producto_id = p_producto_id
  ) or exists (
    select 1
      from public.compra_lineas cl
      join public.variantes v on v.id = cl.variante_id
     where v.producto_id = p_producto_id
  ) or exists (
    -- Los movimientos de stock cuentan aunque no haya venta: si alguien ya
    -- conto mercaderia contra este producto, hubo mercaderia de verdad.
    select 1
      from public.movimientos_stock ms
      join public.variantes v on v.id = ms.variante_id
     where v.producto_id = p_producto_id
  );
$fn$;

comment on function public.producto_en_uso(uuid) is
  'true si el producto ya se vendio, compro o conto. Un producto en uso no se borra, se descataloga.';

revoke execute on function public.producto_en_uso(uuid) from public, anon;
grant execute on function public.producto_en_uso(uuid) to authenticated;


/**
 * Borra un producto que nunca se uso, con todo lo suyo.
 *
 * El orden importa y no es arbitrario: primero las filas de stock, que son
 * automaticas y existen para toda variante aunque esten en cero, despues las
 * variantes, y al final el producto. Al reves, las claves foraneas lo frenan.
 */
create or replace function public.borrar_producto(p_producto_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_nombre text;
begin
  if not public.tiene_rol(array['dueno']) then
    raise exception 'Solo un dueno puede borrar un producto del catalogo.';
  end if;

  select nombre into v_nombre from public.productos where id = p_producto_id;
  if v_nombre is null then
    raise exception 'Ese producto no existe.';
  end if;

  if public.producto_en_uso(p_producto_id) then
    raise exception 'A "%" ya se le registro alguna venta, compra o movimiento de stock, asi que no se puede borrar sin romper esos registros. Descatalogalo: sale del mostrador y el historial queda intacto.', v_nombre;
  end if;

  delete from public.stock
   where variante_id in (select id from public.variantes where producto_id = p_producto_id);

  delete from public.variantes where producto_id = p_producto_id;
  delete from public.productos  where id = p_producto_id;
end;
$fn$;

comment on function public.borrar_producto(uuid) is
  'Borra un producto que nunca se uso. Si se uso, no lo borra y explica que hay que descatalogarlo.';

revoke execute on function public.borrar_producto(uuid) from public, anon;
grant execute on function public.borrar_producto(uuid) to authenticated;
