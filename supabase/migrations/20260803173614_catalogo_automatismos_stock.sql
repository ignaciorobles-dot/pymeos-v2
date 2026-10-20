-- Al crear una variante, existe en las dos sucursales con cantidad 0.
-- Sin esto el producto "no aparece" en la otra sucursal y parece un error del sistema.
create or replace function public.crear_stock_en_todas_las_sucursales()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.stock (variante_id, sucursal_id, cantidad)
  select new.id, s.id, 0
  from public.sucursales s
  where s.activa
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists variante_nueva_crea_stock on public.variantes;
create trigger variante_nueva_crea_stock
  after insert on public.variantes
  for each row execute function public.crear_stock_en_todas_las_sucursales();

-- Una sucursal nueva arranca con todo el catalogo en 0, no vacia.
create or replace function public.crear_stock_para_sucursal_nueva()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.activa then
    insert into public.stock (variante_id, sucursal_id, cantidad)
    select v.id, new.id, 0
    from public.variantes v
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists sucursal_nueva_crea_stock on public.sucursales;
create trigger sucursal_nueva_crea_stock
  after insert on public.sucursales
  for each row execute function public.crear_stock_para_sucursal_nueva();

-- El stock nunca se edita a mano: se registra un movimiento y el stock se acomoda solo.
-- Este es el unico camino por el que cambia una cantidad.
create or replace function public.aplicar_movimiento_a_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.stock (variante_id, sucursal_id, cantidad, actualizado_at)
  values (new.variante_id, new.sucursal_id, new.cantidad, now())
  on conflict (variante_id, sucursal_id) do update
    set cantidad = public.stock.cantidad + excluded.cantidad,
        actualizado_at = now();
  return new;
end;
$$;

drop trigger if exists movimiento_aplica_stock on public.movimientos_stock;
create trigger movimiento_aplica_stock
  after insert on public.movimientos_stock
  for each row execute function public.aplicar_movimiento_a_stock();

-- Un movimiento es historia: no se edita ni se borra. Un error se corrige con
-- otro movimiento de tipo ajuste, que queda a la vista.
create or replace function public.movimientos_son_inmutables()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Los movimientos de stock no se modifican ni se borran. Para corregir, registra un ajuste.';
end;
$$;

drop trigger if exists movimientos_inmutables on public.movimientos_stock;
create trigger movimientos_inmutables
  before update or delete on public.movimientos_stock
  for each row execute function public.movimientos_son_inmutables();
