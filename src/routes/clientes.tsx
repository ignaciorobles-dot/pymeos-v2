import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Alerta,
  BotonPrimario,
  BotonSecundario,
  Modal,
  inputCls,
  inputStyle,
} from "@/components/ui-bits/Modal";
import { CamposFiscales, type DatosFiscales } from "@/components/clientes/CamposFiscales";
import { useSesion, useSucursalOperativa, type Sucursal } from "@/lib/sesion";
import { supa } from "@/lib/supabase";
import { formatARS } from "@/lib/format";
import { labelCondicion, limpiarDocumento, requiereCuit, validarFiscal } from "@/lib/fiscal";
import { Chip } from "@/components/ui-bits/Chip";
import {
  Ban,
  Loader2,
  Pencil,
  Search,
  SlidersHorizontal,
  UserPlus,
  Wallet,
} from "lucide-react";

export const Route = createFileRoute("/clientes")({
  head: () => ({
    meta: [
      { title: "Clientes — PymeOS" },
      { name: "description", content: "Cuenta corriente: quién debe y qué se cobró." },
    ],
  }),
  // El buscador del encabezado deja acá lo que se escribió arriba: llegar a la
  // lista completa para volver a tipear lo mismo sería hacer el trabajo dos veces.
  validateSearch: (s: Record<string, unknown>): { q?: string } => ({
    q: typeof s.q === "string" ? s.q : undefined,
  }),
  component: Clientes,
});

type Cliente = {
  id: string;
  nombre: string;
  telefono: string | null;
  documento: string | null;
  email: string | null;
  direccion: string | null;
  notas: string | null;
  /** Positivo = nos debe. Negativo = tiene saldo a favor. */
  saldo: number;
  condicion_iva: string;
  tipo_documento: string;
};

type MedioPago = { id: string; nombre: string; es_cuenta_corriente: boolean; orden: number };

type Movimiento = {
  id: string;
  tipo: "venta" | "pago" | "ajuste" | "anulacion";
  monto: number;
  nota: string | null;
  created_at: string;
  venta_id: string | null;
  ventas: { numero: number; estado: string } | null;
  usuarios: { nombre: string } | null;
  medios_pago: { nombre: string } | null;
  sucursales: { alias: string } | null;
};

const SELECT_MOVIMIENTOS =
  "id, tipo, monto, nota, created_at, venta_id, " +
  "ventas ( numero, estado ), usuarios ( nombre ), medios_pago ( nombre ), sucursales ( alias )";

const ETIQUETA: Record<Movimiento["tipo"], string> = {
  venta: "Fiado",
  pago: "Pago",
  ajuste: "Ajuste",
  anulacion: "Venta anulada",
};

function aNumero(texto: string): number {
  const n = Number(texto.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function fecha(iso: string) {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** El color dice de qué lado está la plata sin tener que leer el signo. */
function colorSaldo(saldo: number) {
  if (saldo > 0) return "var(--danger)";
  if (saldo < 0) return "var(--success)";
  return "var(--muted-foreground)";
}

function Clientes() {
  const { usuario, sucursalEquipo } = useSesion();
  const sucursalOperativa = useSucursalOperativa();
  const esDueno = usuario?.rol === "dueno";

  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [medios, setMedios] = useState<MedioPago[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState(Route.useSearch().q ?? "");
  const [seleccionadoId, setSeleccionadoId] = useState<string | null>(null);

  const [movimientos, setMovimientos] = useState<Movimiento[]>([]);
  const [cargandoMov, setCargandoMov] = useState(false);

  const [dialogo, setDialogo] = useState<null | "nuevo" | "editar" | "cobrar" | "ajustar">(null);
  const [anulando, setAnulando] = useState<Movimiento | null>(null);

  const cargar = useCallback(async () => {
    const [cl, mp] = await Promise.all([
      supa
        .from("clientes")
        .select(
          "id, nombre, telefono, documento, email, direccion, notas, saldo, condicion_iva, tipo_documento",
        )
        .eq("activo", true)
        .order("nombre"),
      supa
        .from("medios_pago")
        .select("id, nombre, es_cuenta_corriente, orden")
        .eq("activo", true)
        .order("orden"),
    ]);
    const error = cl.error ?? mp.error;
    if (error) setErrorCarga(error.message);
    else {
      setErrorCarga(null);
      setClientes((cl.data ?? []) as Cliente[]);
      setMedios((mp.data ?? []) as MedioPago[]);
    }
    setCargando(false);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const cargarMovimientos = useCallback(async (clienteId: string) => {
    setCargandoMov(true);
    const { data } = await supa
      .from("movimientos_cuenta")
      .select(SELECT_MOVIMIENTOS)
      .eq("cliente_id", clienteId)
      .order("created_at", { ascending: false })
      .limit(100);
    setMovimientos((data ?? []) as unknown as Movimiento[]);
    setCargandoMov(false);
  }, []);

  useEffect(() => {
    if (!seleccionadoId) {
      setMovimientos([]);
      return;
    }
    void cargarMovimientos(seleccionadoId);
  }, [seleccionadoId, cargarMovimientos]);

  const seleccionado = clientes.find((c) => c.id === seleccionadoId) ?? null;

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return clientes;
    return clientes.filter(
      (c) =>
        c.nombre.toLowerCase().includes(q) ||
        (c.telefono ?? "").includes(q) ||
        (c.documento ?? "").includes(q) ||
        (c.email ?? "").toLowerCase().includes(q),
    );
  }, [clientes, busqueda]);

  const deben = clientes.filter((c) => c.saldo > 0);
  const totalFiado = deben.reduce((s, c) => s + c.saldo, 0);
  const aFavor = clientes.reduce((s, c) => s + (c.saldo < 0 ? -c.saldo : 0), 0);

  /** Después de tocar plata: el saldo lo recalcula la base, no el navegador. */
  const refrescar = async () => {
    await cargar();
    if (seleccionadoId) await cargarMovimientos(seleccionadoId);
  };

  return (
    <>
      <PageHeader
        title="Clientes"
        subtitle="Quién debe, qué se cobró y por qué. Cada movimiento queda con nombre y fecha."
        actions={
          <button
            type="button"
            onClick={() => setDialogo("nuevo")}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white"
            style={{ background: "var(--primary)" }}
          >
            <UserPlus size={14} />
            Nuevo cliente
          </button>
        }
      />

      {errorCarga && (
        <div className="mb-3">
          <Alerta tono="danger">No se pudo leer la cuenta corriente: {errorCarga}</Alerta>
        </div>
      )}

      <div className="mb-3 grid grid-cols-3 gap-3">
        <Tarjeta titulo="Se debe" valor={formatARS(totalFiado)} color="var(--danger)" />
        <Tarjeta
          titulo="Clientes con deuda"
          valor={String(deben.length)}
          color="var(--foreground)"
        />
        <Tarjeta titulo="Saldo a favor" valor={formatARS(aFavor)} color="var(--success)" />
      </div>

      <div className="grid grid-cols-[1fr_420px] gap-3">
        <div className="card-surface overflow-hidden" style={{ background: "var(--surface)" }}>
          <div className="border-b p-3" style={{ borderColor: "var(--border)" }}>
            <div className="relative">
              <Search
                size={14}
                className="absolute top-1/2 left-2.5 -translate-y-1/2"
                style={{ color: "var(--muted-foreground)" }}
              />
              <input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar por nombre, teléfono, documento o mail"
                className="h-9 w-full rounded-md border pr-2.5 pl-8 text-[13px] outline-none"
                style={inputStyle}
              />
            </div>
          </div>

          {cargando ? (
            <div className="flex items-center gap-2 p-6 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
              <Loader2 size={14} className="animate-spin" />
              Cargando clientes…
            </div>
          ) : visibles.length === 0 ? (
            <p className="p-6 text-center text-[13px]" style={{ color: "var(--muted-foreground)" }}>
              {clientes.length === 0
                ? "Todavía no hay ningún cliente cargado. Se crean acá o al fiar una venta."
                : "Ningún cliente coincide con esa búsqueda."}
            </p>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: "#f9fafc", color: "var(--muted-foreground)" }}>
                  <th className="px-3 py-2 text-left font-medium">Cliente</th>
                  <th className="px-3 py-2 text-left font-medium">Contacto</th>
                  <th className="px-3 py-2 text-left font-medium">Documento</th>
                  <th className="px-3 py-2 text-left font-medium">Condición</th>
                  <th className="px-3 py-2 text-right font-medium">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setSeleccionadoId(c.id)}
                    className="cursor-pointer border-t"
                    style={{
                      borderColor: "var(--border)",
                      background: c.id === seleccionadoId ? "#fdf3ef" : undefined,
                    }}
                  >
                    <td className="px-3 py-2 font-medium">{c.nombre}</td>
                    <td className="px-3 py-2" style={{ color: "var(--muted-foreground)" }}>
                      {c.telefono ?? c.email ?? "—"}
                    </td>
                    <td className="tabular px-3 py-2" style={{ color: "var(--muted-foreground)" }}>
                      {c.documento ? `${c.tipo_documento} ${c.documento}` : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {/* Si le corresponde factura A y no tiene CUIT, el comprobante se
                          traba recién al momento de emitirlo: mejor verlo desde la lista. */}
                      {requiereCuit(c.condicion_iva) && !c.documento ? (
                        <Chip tone="warning">Falta CUIT</Chip>
                      ) : (
                        <span style={{ color: "var(--muted-foreground)" }}>
                          {labelCondicion(c.condicion_iva)}
                        </span>
                      )}
                    </td>
                    <td
                      className="tabular px-3 py-2 text-right font-semibold"
                      style={{ color: colorSaldo(c.saldo) }}
                    >
                      {c.saldo === 0 ? "—" : formatARS(Math.abs(c.saldo))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card-surface p-4" style={{ background: "var(--surface)" }}>
          {!seleccionado ? (
            <p className="py-10 text-center text-[13px]" style={{ color: "var(--muted-foreground)" }}>
              Elegí un cliente para ver su cuenta.
            </p>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-[15px] font-semibold">{seleccionado.nombre}</h2>
                <button
                  type="button"
                  onClick={() => setDialogo("editar")}
                  className="flex shrink-0 items-center gap-1 text-[12px] font-medium"
                  style={{ color: "var(--primary)" }}
                >
                  <Pencil size={13} />
                  Editar
                </button>
              </div>
              <p className="mt-0.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                {[
                  seleccionado.telefono,
                  seleccionado.email,
                  // El tipo va pegado al número: "12345678" solo no dice si es
                  // un DNI o un CUIT al que hay que facturarle A.
                  seleccionado.documento
                    ? `${seleccionado.tipo_documento} ${seleccionado.documento}`
                    : null,
                  labelCondicion(seleccionado.condicion_iva),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {seleccionado.direccion && (
                <p className="mt-0.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                  {seleccionado.direccion}
                </p>
              )}
              {requiereCuit(seleccionado.condicion_iva) && !seleccionado.documento && (
                <div className="mt-2">
                  <Alerta tono="warning">
                    Está cargado como {labelCondicion(seleccionado.condicion_iva)} pero no tiene
                    CUIT. Sin CUIT no se le puede emitir una factura A: conviene pedírselo antes de
                    la próxima venta.
                  </Alerta>
                </div>
              )}
              {seleccionado.notas && (
                <p
                  className="mt-2 rounded-md px-2.5 py-2 text-[12px]"
                  style={{ background: "#f9fafc", color: "var(--muted-foreground)" }}
                >
                  {seleccionado.notas}
                </p>
              )}

              <div
                className="mt-3 rounded-md p-3"
                style={{ background: "#f9fafc" }}
              >
                <p className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                  {seleccionado.saldo > 0
                    ? "Debe"
                    : seleccionado.saldo < 0
                      ? "Tiene a favor"
                      : "Está al día"}
                </p>
                <p
                  className="tabular text-[24px] font-semibold"
                  style={{ color: colorSaldo(seleccionado.saldo) }}
                >
                  {formatARS(Math.abs(seleccionado.saldo))}
                </p>
              </div>

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setDialogo("cobrar")}
                  disabled={!sucursalOperativa || seleccionado.saldo <= 0}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md py-2 text-[13px] font-medium text-white disabled:opacity-40"
                  style={{ background: "var(--primary)" }}
                >
                  <Wallet size={14} />
                  Cobrar
                </button>
                {esDueno && (
                  <button
                    type="button"
                    onClick={() => setDialogo("ajustar")}
                    disabled={!sucursalOperativa}
                    className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-[13px] disabled:opacity-40"
                    style={inputStyle}
                  >
                    <SlidersHorizontal size={14} />
                    Ajustar
                  </button>
                )}
              </div>

              {!sucursalOperativa && (
                <div className="mt-2">
                  <Alerta tono="warning">
                    Este equipo no tiene una sucursal activa, o estás mirando las dos juntas. Se
                    puede ver la cuenta, pero no cobrar: un cobro siempre entra en la caja de una
                    sucursal.
                  </Alerta>
                </div>
              )}

              <h3 className="mt-4 mb-2 text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
                Movimientos
              </h3>

              {cargandoMov ? (
                <div className="flex items-center gap-2 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                  <Loader2 size={14} className="animate-spin" />
                  Cargando…
                </div>
              ) : movimientos.length === 0 ? (
                <p className="text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                  Todavía no hay movimientos en esta cuenta.
                </p>
              ) : (
                <div className="max-h-[340px] space-y-1.5 overflow-y-auto pr-1">
                  {movimientos.map((m) => (
                    <FilaMovimiento
                      key={m.id}
                      m={m}
                      puedeAnular={esDueno}
                      onAnular={() => setAnulando(m)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {(dialogo === "nuevo" || (dialogo === "editar" && seleccionado)) && (
        <DialogoCliente
          cliente={dialogo === "editar" ? seleccionado : null}
          condicionEmisor={sucursalEquipo?.condicion_iva ?? null}
          onCerrar={() => setDialogo(null)}
          onGuardado={async (id) => {
            setDialogo(null);
            await cargar();
            setSeleccionadoId(id);
          }}
        />
      )}

      {dialogo === "cobrar" && seleccionado && sucursalOperativa && (
        <DialogoCobro
          cliente={seleccionado}
          sucursal={sucursalOperativa}
          medios={medios.filter((m) => !m.es_cuenta_corriente)}
          onCerrar={() => setDialogo(null)}
          onListo={async () => {
            setDialogo(null);
            await refrescar();
          }}
        />
      )}

      {dialogo === "ajustar" && seleccionado && sucursalOperativa && (
        <DialogoAjuste
          cliente={seleccionado}
          sucursal={sucursalOperativa}
          onCerrar={() => setDialogo(null)}
          onListo={async () => {
            setDialogo(null);
            await refrescar();
          }}
        />
      )}

      {anulando && anulando.venta_id && (
        <DialogoAnulacion
          numero={anulando.ventas?.numero ?? 0}
          ventaId={anulando.venta_id}
          onCerrar={() => setAnulando(null)}
          onListo={async () => {
            setAnulando(null);
            await refrescar();
          }}
        />
      )}
    </>
  );
}

function Tarjeta({ titulo, valor, color }: { titulo: string; valor: string; color: string }) {
  return (
    <div className="card-surface p-3" style={{ background: "var(--surface)" }}>
      <p className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
        {titulo}
      </p>
      <p className="tabular text-[20px] font-semibold" style={{ color }}>
        {valor}
      </p>
    </div>
  );
}

function FilaMovimiento({
  m,
  puedeAnular,
  onAnular,
}: {
  m: Movimiento;
  puedeAnular: boolean;
  onAnular: () => void;
}) {
  const anulada = m.ventas?.estado === "anulada";
  const detalle = [
    m.ventas ? `Ticket #${m.ventas.numero}` : null,
    m.medios_pago?.nombre ?? null,
    m.sucursales?.alias ?? null,
    m.usuarios?.nombre ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="rounded-md p-2" style={{ background: "#f9fafc" }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-medium">
            {ETIQUETA[m.tipo]}
            {anulada && m.tipo === "venta" && (
              <span className="ml-1.5 text-[11px] font-normal" style={{ color: "var(--muted-foreground)" }}>
                (anulada)
              </span>
            )}
          </p>
          <p className="truncate text-[11px]" style={{ color: "var(--muted-foreground)" }}>
            {fecha(m.created_at)}
            {detalle && ` · ${detalle}`}
          </p>
          {m.nota && <p className="mt-0.5 text-[11px]">{m.nota}</p>}
        </div>
        <div className="shrink-0 text-right">
          <p className="tabular text-[13px] font-semibold" style={{ color: colorSaldo(m.monto) }}>
            {m.monto > 0 ? "+" : "−"}
            {formatARS(Math.abs(m.monto))}
          </p>
          {puedeAnular && m.tipo === "venta" && !anulada && (
            <button
              type="button"
              onClick={onAnular}
              className="mt-1 flex items-center gap-1 text-[11px]"
              style={{ color: "var(--danger)" }}
            >
              <Ban size={11} />
              Anular
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function DialogoCliente({
  cliente,
  condicionEmisor,
  onCerrar,
  onGuardado,
}: {
  /** Null es alta. Con un cliente adentro, el mismo formulario edita. */
  cliente: Cliente | null;
  condicionEmisor: string | null;
  onCerrar: () => void;
  onGuardado: (id: string) => void | Promise<void>;
}) {
  const [nombre, setNombre] = useState(cliente?.nombre ?? "");
  const [telefono, setTelefono] = useState(cliente?.telefono ?? "");
  const [email, setEmail] = useState(cliente?.email ?? "");
  const [direccion, setDireccion] = useState(cliente?.direccion ?? "");
  const [notas, setNotas] = useState(cliente?.notas ?? "");
  const [fiscal, setFiscal] = useState<DatosFiscales>({
    condicion_iva: cliente?.condicion_iva ?? "consumidor_final",
    tipo_documento: cliente?.tipo_documento ?? "DNI",
    documento: cliente?.documento ?? "",
  });
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nombre.trim()) {
      setError("El cliente necesita un nombre.");
      return;
    }
    const mal = validarFiscal(fiscal);
    if (mal) {
      setError(mal);
      return;
    }
    setGuardando(true);
    setError(null);
    const documento = limpiarDocumento(fiscal.documento, fiscal.tipo_documento);
    // El saldo no viaja en este formulario ni cuando se edita: la plata se mueve
    // por cobros y ajustes, que dejan rastro. Acá solo se corrigen los datos.
    const campos = {
      nombre: nombre.trim(),
      documento: documento || null,
      telefono: telefono.trim() || null,
      email: email.trim() || null,
      direccion: direccion.trim() || null,
      notas: notas.trim() || null,
      condicion_iva: fiscal.condicion_iva,
      tipo_documento: fiscal.tipo_documento,
    };
    const { data, error: err } = cliente
      ? await supa.from("clientes").update(campos).eq("id", cliente.id).select("id").single()
      : await supa.from("clientes").insert(campos).select("id").single();
    if (err) {
      setError(err.message);
      setGuardando(false);
      return;
    }
    await onGuardado(data.id as string);
  };

  return (
    <Modal titulo={cliente ? "Editar cliente" : "Nuevo cliente"} onCerrar={onCerrar}>
      <form onSubmit={(e) => void guardar(e)}>
        <label className="block text-[12px]">
          Nombre
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className={inputCls}
            style={inputStyle}
            autoFocus
          />
        </label>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block text-[12px]">
            Teléfono
            <input
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              className={inputCls}
              style={inputStyle}
            />
          </label>
          <label className="block text-[12px]">
            Mail
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
              style={inputStyle}
              placeholder="Para mandarle el comprobante"
            />
          </label>
        </div>
        <label className="mt-3 block text-[12px]">
          Dirección
          <input
            value={direccion}
            onChange={(e) => setDireccion(e.target.value)}
            className={inputCls}
            style={inputStyle}
          />
        </label>

        <div className="mt-3">
          <CamposFiscales datos={fiscal} onCambio={setFiscal} condicionEmisor={condicionEmisor} />
        </div>

        <label className="mt-3 block text-[12px]">
          Notas
          <textarea
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
            rows={2}
            className={inputCls}
            style={inputStyle}
            placeholder="Lo que haga falta recordar de este cliente"
          />
        </label>

        {!cliente && (
          <div className="mt-3">
            <Alerta tono="info">
              El saldo no se carga a mano: arranca en cero y se mueve solo con lo que se fía y lo
              que se cobra.
            </Alerta>
          </div>
        )}

        {error && (
          <div className="mt-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={guardando}>
            {cliente ? "Guardar cambios" : "Guardar cliente"}
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

function DialogoCobro({
  cliente,
  sucursal,
  medios,
  onCerrar,
  onListo,
}: {
  cliente: Cliente;
  sucursal: Sucursal;
  medios: MedioPago[];
  onCerrar: () => void;
  onListo: () => void | Promise<void>;
}) {
  const [monto, setMonto] = useState(String(cliente.saldo));
  const [medioId, setMedioId] = useState(medios[0]?.id ?? "");
  const [nota, setNota] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const montoNum = aNumero(monto);
  const restante = Math.round((cliente.saldo - montoNum) * 100) / 100;

  const cobrar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (montoNum <= 0) {
      setError("El pago tiene que ser mayor a cero.");
      return;
    }
    setEnviando(true);
    setError(null);
    const { error: err } = await supa.rpc("registrar_pago_cuenta", {
      p_cliente_id: cliente.id,
      p_sucursal_id: sucursal.id,
      p_monto: montoNum,
      p_medio_pago_id: medioId || null,
      p_nota: nota.trim() || null,
    });
    if (err) {
      setError(err.message);
      setEnviando(false);
      return;
    }
    await onListo();
  };

  return (
    <Modal titulo={`Cobrar a ${cliente.nombre}`} onCerrar={onCerrar}>
      <form onSubmit={(e) => void cobrar(e)}>
        <p className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
          Debe {formatARS(cliente.saldo)}. El cobro entra en {sucursal.alias}.
        </p>

        <label className="mt-3 block text-[12px]">
          Cuánto paga
          <input
            value={monto}
            onChange={(e) => setMonto(e.target.value)}
            inputMode="decimal"
            className={inputCls}
            style={inputStyle}
            autoFocus
          />
        </label>

        {medios.length > 0 && (
          <label className="mt-3 block text-[12px]">
            Con qué paga
            <select
              value={medioId}
              onChange={(e) => setMedioId(e.target.value)}
              className={inputCls}
              style={inputStyle}
            >
              {medios.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nombre}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="mt-3 block text-[12px]">
          Nota (opcional)
          <input
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            className={inputCls}
            style={inputStyle}
          />
        </label>

        <div className="mt-3">
          {restante > 0 ? (
            <Alerta tono="info">Le quedan debiendo {formatARS(restante)}.</Alerta>
          ) : restante === 0 ? (
            <Alerta tono="info">Con esto queda al día.</Alerta>
          ) : (
            <Alerta tono="warning">
              Está pagando {formatARS(-restante)} de más. Va a quedar con saldo a favor, que se
              descuenta de lo próximo que se lleve.
            </Alerta>
          )}
        </div>

        {error && (
          <div className="mt-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando}>Registrar el pago</BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Ajustar no es cobrar: no entra plata. Sirve para corregir un error de carga
 * o perdonar una diferencia, y la base exige explicar por qué. Solo el dueño.
 */
function DialogoAjuste({
  cliente,
  sucursal,
  onCerrar,
  onListo,
}: {
  cliente: Cliente;
  sucursal: Sucursal;
  onCerrar: () => void;
  onListo: () => void | Promise<void>;
}) {
  const [sentido, setSentido] = useState<"suma" | "resta">("resta");
  const [monto, setMonto] = useState("");
  const [nota, setNota] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const montoNum = Math.abs(aNumero(monto));
  const firmado = sentido === "suma" ? montoNum : -montoNum;

  const ajustar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (montoNum <= 0) {
      setError("Un ajuste de 0 no corrige nada.");
      return;
    }
    if (!nota.trim()) {
      setError("Hay que explicar el ajuste: sin motivo no se puede discutir con el cliente.");
      return;
    }
    setEnviando(true);
    setError(null);
    const { error: err } = await supa.rpc("ajustar_cuenta", {
      p_cliente_id: cliente.id,
      p_sucursal_id: sucursal.id,
      p_monto: firmado,
      p_nota: nota.trim(),
    });
    if (err) {
      setError(err.message);
      setEnviando(false);
      return;
    }
    await onListo();
  };

  return (
    <Modal titulo={`Ajustar la cuenta de ${cliente.nombre}`} onCerrar={onCerrar}>
      <form onSubmit={(e) => void ajustar(e)}>
        <Alerta tono="warning">
          Un ajuste no mueve plata: corrige el número. Si el cliente pagó, cobrá en vez de
          ajustar. El movimiento queda para siempre con tu nombre.
        </Alerta>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {(["resta", "suma"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSentido(s)}
              className="rounded-md border py-2 text-[13px]"
              style={
                sentido === s
                  ? { borderColor: "var(--primary)", background: "#fdf3ef", color: "var(--primary)" }
                  : inputStyle
              }
            >
              {s === "resta" ? "Bajar la deuda" : "Subir la deuda"}
            </button>
          ))}
        </div>

        <label className="mt-3 block text-[12px]">
          Monto
          <input
            value={monto}
            onChange={(e) => setMonto(e.target.value)}
            inputMode="decimal"
            className={inputCls}
            style={inputStyle}
            autoFocus
          />
        </label>

        <label className="mt-3 block text-[12px]">
          Por qué
          <input
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            placeholder="Ej: se cargó dos veces el mismo fiado"
            className={inputCls}
            style={inputStyle}
          />
        </label>

        {montoNum > 0 && (
          <p className="mt-2 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Queda debiendo{" "}
            <span className="font-semibold" style={{ color: colorSaldo(cliente.saldo + firmado) }}>
              {formatARS(Math.abs(cliente.saldo + firmado))}
            </span>
            {cliente.saldo + firmado < 0 && " a favor"}.
          </p>
        )}

        {error && (
          <div className="mt-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando}>Guardar el ajuste</BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Anular no borra: devuelve el stock, cancela la deuda con un movimiento
 * contrario y deja la venta marcada. Solo el dueño, y siempre con motivo.
 */
function DialogoAnulacion({
  numero,
  ventaId,
  onCerrar,
  onListo,
}: {
  numero: number;
  ventaId: string;
  onCerrar: () => void;
  onListo: () => void | Promise<void>;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const anular = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!motivo.trim()) {
      setError("Hay que decir por qué se anula. Una anulación sin motivo no se puede auditar.");
      return;
    }
    setEnviando(true);
    setError(null);
    const { error: err } = await supa.rpc("anular_venta", {
      p_venta_id: ventaId,
      p_motivo: motivo.trim(),
    });
    if (err) {
      setError(err.message);
      setEnviando(false);
      return;
    }
    await onListo();
  };

  return (
    <Modal titulo={`Anular el ticket #${numero}`} onCerrar={onCerrar}>
      <form onSubmit={(e) => void anular(e)}>
        <Alerta tono="danger">
          La mercadería vuelve al stock de la sucursal donde se vendió y se borra la deuda que
          generó. La venta queda a la vista, marcada como anulada: no desaparece de los números.
        </Alerta>

        <label className="mt-3 block text-[12px]">
          Motivo
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Ej: se cargó el producto equivocado"
            className={inputCls}
            style={inputStyle}
            autoFocus
          />
        </label>

        {error && (
          <div className="mt-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <BotonSecundario onClick={onCerrar}>Volver</BotonSecundario>
          <BotonPrimario enviando={enviando}>Anular la venta</BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}
