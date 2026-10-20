-- El saldo del cliente lo lleva la base, igual que el stock.
create or replace function public.aplicar_movimiento_cuenta()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.clientes
     set saldo = saldo + new.monto
   where id = new.cliente_id;
  return new;
end;
$$;

create trigger movimientos_cuenta_aplica
after insert on public.movimientos_cuenta
for each row execute function public.aplicar_movimiento_cuenta();

-- Libro mayor: se escribe una vez y no se toca mas.
create or replace function public.movimientos_cuenta_inmutables()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Los movimientos de cuenta corriente no se editan ni se borran. Corregi con un movimiento de tipo ajuste.';
end;
$$;

create trigger movimientos_cuenta_sin_update
before update or delete on public.movimientos_cuenta
for each row execute function public.movimientos_cuenta_inmutables();
