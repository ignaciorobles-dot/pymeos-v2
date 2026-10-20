-- Las siete tablas de configuracion son las que arman el vocabulario del
-- sistema: sucursales, categorias, rubros de gasto, medios de pago, escalas,
-- talles y colores. Todo lo demas las referencia. Una venta apunta a un medio
-- de pago, un producto a una categoria, una variante a un talle y a un color.
--
-- Hasta ahora authenticated tenia delete sobre las siete. Eso contradice la
-- regla de que nada se borra: lo que deja de usarse se desactiva. Un delete no
-- solo rompe la foreign key, tambien deja el historial sin poder leerse, porque
-- una venta vieja tiene que poder decir con que se cobro aunque ese medio ya no
-- se use.
--
-- El delete se saca; el update y el insert quedan como estaban, gobernados por
-- las politicas que piden rol dueno.

revoke delete on public.sucursales       from authenticated;
revoke delete on public.categorias       from authenticated;
revoke delete on public.categorias_gasto from authenticated;
revoke delete on public.medios_pago      from authenticated;
revoke delete on public.escalas_talle    from authenticated;
revoke delete on public.talles           from authenticated;
revoke delete on public.colores          from authenticated;
