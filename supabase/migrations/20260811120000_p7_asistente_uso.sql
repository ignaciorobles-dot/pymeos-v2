-- P7 (1 de N) - El contador de uso del asistente.
--
-- Todo lo que le pedimos al asistente cuesta plata en la cuenta de Anthropic, y
-- a diferencia del resto del sistema ese costo no lo pone el negocio: lo pone
-- cada mensaje que alguien escribe. Sin un techo, un empleado aburrido o una
-- pantalla que quedo abierta reintentando pueden gastar en una tarde lo que no
-- estaba presupuestado, y nos enteramos por la factura.
--
-- Por que el tope se cuenta y se cobra ACA y no en el navegador:
--
--   El navegador no es un lugar donde poner un limite. Cualquiera que abra las
--   herramientas del desarrollador puede cambiar un numero en memoria. El unico
--   contador que sirve es el que esta del otro lado, y ademas tiene que ser el
--   mismo aunque la persona entre desde la computadora del local, el celular y
--   la casa: por eso cuenta por usuario y por dia, no por dispositivo ni por
--   sesion.
--
-- Guardamos tambien los tokens, que son la unidad real en la que se factura.
-- La cuenta de mensajes sirve para frenar; los tokens sirven para saber cuanto
-- salio, que es una pregunta distinta y se hace despues, mirando el mes.

create table if not exists public.asistente_uso (
  usuario_id      uuid    not null references public.usuarios(user_id) on delete cascade,
  dia             date    not null default current_date,
  mensajes        integer not null default 0,
  tokens_entrada  bigint  not null default 0,
  tokens_salida   bigint  not null default 0,
  primary key (usuario_id, dia),

  constraint asistente_uso_mensajes_no_negativos check (mensajes >= 0),
  constraint asistente_uso_tokens_no_negativos check (tokens_entrada >= 0 and tokens_salida >= 0)
);

comment on table public.asistente_uso is
  'Cuanto uso el asistente cada persona cada dia. El tope se cobra aca, no en el navegador.';
comment on column public.asistente_uso.mensajes is
  'Mensajes enviados al modelo. Es lo que frena el tope.';
comment on column public.asistente_uso.tokens_entrada is
  'Unidad real de facturacion. No frena nada: sirve para saber cuanto salio el mes.';

create index if not exists asistente_uso_por_dia on public.asistente_uso (dia desc);

-- Suma uno y contesta cuantos quedan. Si el tope ya se alcanzo, corta con un
-- error: la excepcion deshace el incremento, asi que el contador se queda
-- clavado en el tope y no sigue creciendo con cada reintento.
--
-- El insert con `on conflict` es a proposito una sola sentencia. Si fuera un
-- select y despues un update, dos pestanas abiertas al mismo tiempo podrian
-- leer el mismo numero y gastar dos mensajes cobrando uno.
create or replace function public.consumir_credito_asistente(
  p_usuario_id uuid,
  p_tope       integer
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_usados integer;
begin
  if p_tope is null or p_tope <= 0 then
    raise exception 'El tope diario del asistente tiene que ser un numero mayor a cero.';
  end if;

  insert into public.asistente_uso as u (usuario_id, dia, mensajes)
  values (p_usuario_id, current_date, 1)
  on conflict (usuario_id, dia) do update
    set mensajes = u.mensajes + 1
  returning u.mensajes into v_usados;

  if v_usados > p_tope then
    raise exception 'Llegaste al tope de % mensajes por dia del asistente. Se vuelve a habilitar manana.', p_tope
      using errcode = 'check_violation';
  end if;

  return p_tope - v_usados;
end;
$$;

-- Los tokens se saben recien cuando el modelo contesto, asi que se anotan
-- aparte. Si esto falla no se le niega la respuesta a nadie: el tope ya se
-- cobro arriba, y perder un dato de costo es mucho menos grave que romperle la
-- conversacion a alguien que esta atendiendo un cliente.
create or replace function public.anotar_tokens_asistente(
  p_usuario_id uuid,
  p_entrada    bigint,
  p_salida     bigint
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  insert into public.asistente_uso as u (usuario_id, dia, tokens_entrada, tokens_salida)
  values (p_usuario_id, current_date, greatest(coalesce(p_entrada, 0), 0), greatest(coalesce(p_salida, 0), 0))
  on conflict (usuario_id, dia) do update
    set tokens_entrada = u.tokens_entrada + greatest(coalesce(p_entrada, 0), 0),
        tokens_salida  = u.tokens_salida  + greatest(coalesce(p_salida, 0), 0);
end;
$$;

alter table public.asistente_uso enable row level security;

-- Cada uno ve lo suyo, para que la pantalla pueda decir "te quedan 12". El
-- dueno ve todo, porque el que paga la cuenta es el que tiene que poder
-- preguntarse por que este mes salio el doble.
drop policy if exists asistente_uso_select_propio on public.asistente_uso;
create policy asistente_uso_select_propio on public.asistente_uso
  for select to authenticated
  using (usuario_id = auth.uid() or public.tiene_rol(array['dueno']));

-- Nadie escribe esta tabla desde el navegador. Un contador de consumo que se
-- puede editar desde el cliente no es un contador, es una sugerencia.
grant select on public.asistente_uso to authenticated;

revoke execute on function public.consumir_credito_asistente(uuid, integer) from public, anon, authenticated;
revoke execute on function public.anotar_tokens_asistente(uuid, bigint, bigint) from public, anon, authenticated;

-- Solo la Edge Function, que corre del lado del servidor con la clave secreta,
-- puede cobrar un credito. Si esto lo pudiera llamar `authenticated`, el tope
-- se podria saltear llamando a la funcion con un tope inventado.
grant execute on function public.consumir_credito_asistente(uuid, integer) to service_role;
grant execute on function public.anotar_tokens_asistente(uuid, bigint, bigint) to service_role;
