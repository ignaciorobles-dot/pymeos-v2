-- P8 - Tablero: el detalle de lo que se esta por acabar.
--
-- resumen_tablero devuelve cuantas variantes estan en el limite, pero un numero
-- solo no sirve para reponer: hay que saber que modelo, que talle y en que
-- sucursal. Esta funcion es esa lista.
--
-- Va aparte de resumen_tablero a proposito: el resumen devuelve una fila y se
-- pide siempre, esta devuelve varias y solo la usa la tarjeta de alertas.
--
-- Con sucursal null una misma variante puede aparecer dos veces, una por
-- sucursal. Esta bien que asi sea: que falte el 43 en Norte y sobre en
-- Centro es exactamente lo que hay que ver para mandar el par de un local al
-- otro en vez de comprarlo.

create or replace function public.detalle_stock_bajo(
  p_sucursal_id uuid default null,
  p_minimo      integer default 3,
  p_limite      integer default 6
)
returns table (
  variante_id uuid,
  producto    text,
  marca       text,
  talle       text,
  color       text,
  cantidad    integer,
  sucursal    text
)
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_limite integer := least(greatest(coalesce(p_limite, 6), 1), 100);
begin
  if not public.tiene_rol(array['dueno','contador']) then
    raise exception 'El tablero es de los duenos.';
  end if;

  return query
  select vt.id, p.nombre, p.marca, vt.talle, vt.color, st.cantidad, s.alias
    from public.stock st
    join public.variantes vt on vt.id = st.variante_id
    join public.productos p on p.id = vt.producto_id
    join public.sucursales s on s.id = st.sucursal_id
   where vt.activa and p.activo
     and (p_sucursal_id is null or st.sucursal_id = p_sucursal_id)
     and st.cantidad <= coalesce(p_minimo, 3)
   -- Primero lo que menos queda: si hay que mirar seis renglones, que sean los
   -- seis que se van a agotar antes.
   order by st.cantidad asc, p.nombre asc, vt.talle asc
   limit v_limite;
end;
$$;

comment on function public.detalle_stock_bajo(uuid, integer, integer) is
  'Variantes con poco stock, con modelo, talle y sucursal, para la tarjeta de alertas del tablero.';

revoke execute on function public.detalle_stock_bajo(uuid, integer, integer) from public, anon;
grant execute on function public.detalle_stock_bajo(uuid, integer, integer) to authenticated;
