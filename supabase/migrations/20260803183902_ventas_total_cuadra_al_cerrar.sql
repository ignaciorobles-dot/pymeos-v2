-- La venta se arma en pasos dentro de una transaccion: nace en cero, se le suman
-- las lineas y recien al final se sabe el total. Un CHECK corre en cada paso y
-- frena la venta a mitad de camino; ademas Postgres no permite diferirlo.
-- Un trigger de restriccion diferido controla lo mismo, pero al cerrar la
-- operacion. Sigue siendo obligatorio: si no cuadra, no se guarda nada.
alter table public.ventas drop constraint ventas_total_cuadra;

create or replace function public.ventas_total_coherente()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.total <> new.subtotal - new.descuento + new.recargo then
    raise exception 'La venta no cuadra: subtotal % - descuento % + recargo % no da el total %',
      new.subtotal, new.descuento, new.recargo, new.total;
  end if;
  return null;
end;
$$;

create constraint trigger ventas_total_cuadra
after insert or update on public.ventas
deferrable initially deferred
for each row execute function public.ventas_total_coherente();
