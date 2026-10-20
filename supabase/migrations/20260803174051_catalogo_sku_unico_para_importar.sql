-- El catalogo no se va a cargar a mano: sale de una exportacion de PROGES.
-- `sku` guarda el codigo interno que traiga ese archivo. Unico para que volver a
-- importar el mismo archivo actualice en vez de duplicar, y para que un export
-- con codigos repetidos falle de entrada en lugar de ensuciar la base en silencio.
create unique index if not exists variantes_sku_unico
  on public.variantes (sku)
  where sku is not null;

comment on column public.variantes.sku is
  'Codigo interno. Es donde entra el codigo de PROGES al importar: permite reimportar sin duplicar.';
