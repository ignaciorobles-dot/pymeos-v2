-- Arranque razonable para un local de calzado. Todo editable desde la pantalla:
-- los porcentajes de tarjeta cambian solos varias veces al ano.
insert into public.medios_pago (nombre, recargo_porcentaje, es_cuenta_corriente, afecta_caja, orden) values
  ('Efectivo',        0,  false, true,  10),
  ('Débito',          0,  false, false, 20),
  ('Crédito',         10, false, false, 30),
  ('Transferencia',   0,  false, false, 40),
  ('Mercado Pago',    0,  false, false, 50),
  ('Cuenta corriente',0,  true,  false, 60)
on conflict (nombre) do nothing;
