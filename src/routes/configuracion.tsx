import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Loader2, MapPin, Pencil, Plus, TriangleAlert } from "lucide-react";
import { PageHeader } from "@/components/layout/AppShell";
import { Chip } from "@/components/ui-bits/Chip";
import {
  Alerta,
  BotonPrimario,
  BotonSecundario,
  Modal,
  inputCls,
  inputStyle,
} from "@/components/ui-bits/Modal";
import { CONDICIONES_EMISOR, labelCondicion } from "@/lib/fiscal";
import { useSesion } from "@/lib/sesion";
import { supa } from "@/lib/supabase";

export const Route = createFileRoute("/configuracion")({
  head: () => ({
    meta: [
      { title: "Configuración — PymeOS" },
      {
        name: "description",
        content: "Sucursales, datos fiscales, categorías, talles, colores y medios de pago.",
      },
    ],
  }),
  component: Configuracion,
});

/**
 * Todo lo que se configura una vez y después el sistema usa mil veces: qué
 * sucursales hay y con qué datos facturan, con qué categorías se ordena el
 * catálogo, qué talles y colores existen, y con qué medios de pago se cobra.
 *
 * Escribe solamente el dueño. No porque la pantalla esconda los botones, sino
 * porque las políticas de estas tablas piden `tiene_rol(array['dueno'])`: si un
 * vendedor probara desde la consola del navegador, la base lo rechaza igual.
 *
 * Nada se borra. Lo que ya no se usa se desactiva, porque hay ventas, productos
 * y gastos viejos que siguen apuntando a esa fila y tienen que poder leerse.
 */

const TABS = [
  "Sucursales",
  "Categorías",
  "Talles y colores",
  "Medios de pago",
  "Gastos",
  "Negocio",
  "Facturación",
  "Usuarios",
] as const;

type Tab = (typeof TABS)[number];

type Sucursal = {
  id: string;
  nombre: string;
  alias: string;
  direccion: string;
  lat: number | null;
  lng: number | null;
  cuit: string | null;
  condicion_iva: string | null;
  punto_venta: number | null;
  activa: boolean;
};

type Escala = { id: string; nombre: string; orden: number };
type Talle = { id: string; escala_id: string; valor: string; orden: number; activo: boolean };
type Categoria = {
  id: string;
  nombre: string;
  escala_talle_id: string | null;
  orden: number;
  activa: boolean;
};
type Medio = {
  id: string;
  nombre: string;
  recargo_porcentaje: number;
  cuotas: number;
  es_cuenta_corriente: boolean;
  afecta_caja: boolean;
  activo: boolean;
  orden: number;
};

/** Colores y categorías de gasto son la misma forma: un nombre, un orden y si está en uso. */
type Simple = { id: string; nombre: string; orden: number; activo: boolean };

/**
 * Traduce el error de Postgres a algo que se pueda leer. El 23505 es el único
 * que aparece seguido acá: los nombres y los puntos de venta son únicos.
 */
function mensajeError(error: { message: string; code?: string }, queEs: string): string {
  if (error.code === "23505") {
    if (error.message.includes("punto_venta")) {
      return "Ese punto de venta ya está usado por otra sucursal. En ARCA cada punto de venta es de un solo local.";
    }
    if (error.message.includes("alias")) {
      return "Ese alias ya está en uso. El alias es el nombre corto que aparece en los tickets.";
    }
    return `Ya existe ${queEs} con ese nombre.`;
  }
  return error.message;
}

function Configuracion() {
  const { usuario, recargarUsuario, sucursalEquipoId } = useSesion();
  const esDueno = usuario?.rol === "dueno";

  const [tab, setTab] = useState<Tab>("Sucursales");
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [escalas, setEscalas] = useState<Escala[]>([]);
  const [talles, setTalles] = useState<Talle[]>([]);
  const [colores, setColores] = useState<Simple[]>([]);
  const [medios, setMedios] = useState<Medio[]>([]);
  const [rubrosGasto, setRubrosGasto] = useState<Simple[]>([]);

  const cargar = useCallback(async () => {
    const [s, c, e, t, co, m, g] = await Promise.all([
      supa
        .from("sucursales")
        .select("id, nombre, alias, direccion, lat, lng, cuit, condicion_iva, punto_venta, activa")
        .order("nombre"),
      supa.from("categorias").select("id, nombre, escala_talle_id, orden, activa").order("orden"),
      supa.from("escalas_talle").select("id, nombre, orden").order("orden"),
      supa.from("talles").select("id, escala_id, valor, orden, activo").order("orden"),
      supa.from("colores").select("id, nombre, orden, activo").order("orden"),
      supa
        .from("medios_pago")
        .select("id, nombre, recargo_porcentaje, cuotas, es_cuenta_corriente, afecta_caja, activo, orden")
        .order("orden"),
      supa.from("categorias_gasto").select("id, nombre, orden, activa").order("orden"),
    ]);

    const fallo = s.error ?? c.error ?? e.error ?? t.error ?? co.error ?? m.error ?? g.error;
    if (fallo) {
      setErrorCarga(fallo.message);
    } else {
      setErrorCarga(null);
      setSucursales((s.data ?? []) as Sucursal[]);
      setCategorias((c.data ?? []) as Categoria[]);
      setEscalas((e.data ?? []) as Escala[]);
      setTalles((t.data ?? []) as Talle[]);
      setColores((co.data ?? []) as Simple[]);
      setMedios(
        ((m.data ?? []) as Medio[]).map((x) => ({
          ...x,
          recargo_porcentaje: Number(x.recargo_porcentaje),
        })),
      );
      // `categorias_gasto` usa `activa` y `colores` usa `activo`: se normaliza acá
      // para que la misma tabla en pantalla sirva para las dos.
      setRubrosGasto(
        ((g.data ?? []) as { id: string; nombre: string; orden: number; activa: boolean }[]).map(
          (x) => ({ id: x.id, nombre: x.nombre, orden: x.orden, activo: x.activa }),
        ),
      );
    }
    setCargando(false);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <>
      <PageHeader title="Configuración" subtitle="Lo que se carga una vez y usa todo el sistema" />

      {!esDueno && (
        <div className="mb-4">
          <Alerta tono="info">
            Estás viendo la configuración en modo lectura. Los cambios acá los hace el dueño.
          </Alerta>
        </div>
      )}

      {errorCarga && (
        <div className="mb-4">
          <Alerta tono="danger">No se pudo leer la configuración: {errorCarga}</Alerta>
        </div>
      )}

      <div className="card-surface overflow-hidden">
        <div className="flex flex-wrap gap-1 px-3 pt-3">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="rounded-t-md px-3 py-2 text-[13px] font-medium"
              style={{
                background: tab === t ? "var(--background)" : "transparent",
                color: tab === t ? "var(--primary)" : "var(--foreground)",
                borderBottom: tab === t ? "2px solid var(--primary)" : "2px solid transparent",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="p-5" style={{ borderTop: "1px solid var(--border)" }}>
          {cargando ? (
            <div
              className="flex items-center gap-2 py-8 text-[13px]"
              style={{ color: "var(--muted-foreground)" }}
            >
              <Loader2 size={14} className="animate-spin" />
              Cargando…
            </div>
          ) : (
            <>
              {tab === "Sucursales" && (
                <PanelSucursales
                  sucursales={sucursales}
                  sucursalEquipoId={sucursalEquipoId}
                  puedeEditar={esDueno}
                  recargar={async () => {
                    await cargar();
                    // La sesión guarda su propia copia de las sucursales: si no se
                    // refresca, el encabezado sigue mostrando el nombre viejo.
                    await recargarUsuario();
                  }}
                />
              )}

              {tab === "Categorías" && (
                <PanelCategorias
                  categorias={categorias}
                  escalas={escalas}
                  puedeEditar={esDueno}
                  recargar={cargar}
                />
              )}

              {tab === "Talles y colores" && (
                <PanelTallesColores
                  escalas={escalas}
                  talles={talles}
                  colores={colores}
                  puedeEditar={esDueno}
                  recargar={cargar}
                />
              )}

              {tab === "Medios de pago" && (
                <PanelMedios medios={medios} puedeEditar={esDueno} recargar={cargar} />
              )}

              {tab === "Gastos" && (
                <ListaSimple
                  tabla="categorias_gasto"
                  campoActivo="activa"
                  singular="un rubro"
                  titulo="Rubros de gasto"
                  ayuda="Con esto se agrupan los gastos en el resultado del mes. Un gasto viejo sigue mostrando su rubro aunque lo desactives."
                  filas={rubrosGasto}
                  puedeEditar={esDueno}
                  recargar={cargar}
                />
              )}

              {tab === "Negocio" && <PanelNegocio />}

              {tab === "Facturación" && <PanelFacturacion sucursales={sucursales} />}

              {tab === "Usuarios" && (
                <div className="text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                  La gestión de usuarios se hace en la pantalla{" "}
                  <a href="/empleados" className="font-medium" style={{ color: "var(--primary)" }}>
                    Empleados
                  </a>
                  . Las altas siempre son por invitación al email; nunca se configuran contraseñas
                  desde el sistema.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/* ─────────────────────────── Sucursales ─────────────────────────── */

function PanelSucursales({
  sucursales,
  sucursalEquipoId,
  puedeEditar,
  recargar,
}: {
  sucursales: Sucursal[];
  sucursalEquipoId: string | null;
  puedeEditar: boolean;
  recargar: () => Promise<void>;
}) {
  const [editando, setEditando] = useState<null | Sucursal>(null);
  const [creando, setCreando] = useState(false);

  const sinFacturar = sucursales.filter((s) => s.activa && !puedeFacturar(s));

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-2xl text-[13px]" style={{ color: "var(--muted-foreground)" }}>
          Cada sucursal factura con su propio CUIT y su propio punto de venta. Mientras falte uno de
          los dos, el sistema registra las ventas pero no arma comprobantes.
        </p>
        {puedeEditar && (
          <button
            type="button"
            onClick={() => setCreando(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white"
            style={{ background: "var(--primary)" }}
          >
            <Plus size={14} />
            Nueva sucursal
          </button>
        )}
      </div>

      {sinFacturar.length > 0 && (
        <Alerta tono="warning">
          {sinFacturar.length === 1
            ? `${sinFacturar[0].nombre} todavía no puede facturar: `
            : `${sinFacturar.length} sucursales todavía no pueden facturar: `}
          faltan el CUIT, la condición ante ARCA o el punto de venta.
        </Alerta>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {sucursales.map((s) => (
          <div
            key={s.id}
            className="rounded-md border p-4"
            style={{ borderColor: "var(--border)", background: s.activa ? "transparent" : "#f9fafc" }}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[14px] font-semibold">{s.nombre}</div>
                <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                  Alias {s.alias}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {s.id === sucursalEquipoId && <Chip tone="warning">Activa en este equipo</Chip>}
                {!s.activa && <Chip tone="neutral">Cerrada</Chip>}
                {puedeEditar && (
                  <button
                    type="button"
                    onClick={() => setEditando(s)}
                    className="flex items-center gap-1 text-[12px] font-medium"
                    style={{ color: "var(--primary)" }}
                  >
                    <Pencil size={13} />
                    Editar
                  </button>
                )}
              </div>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              <Dato etiqueta="Dirección" valor={s.direccion} ancho />
              <Dato etiqueta="CUIT" valor={s.cuit ?? "—"} />
              <Dato etiqueta="Condición ante ARCA" valor={labelCondicion(s.condicion_iva)} />
              <Dato etiqueta="Punto de venta" valor={s.punto_venta?.toString() ?? "—"} />
              <Dato
                etiqueta="Ubicación"
                valor={s.lat != null && s.lng != null ? `${s.lat}, ${s.lng}` : "Sin marcar"}
              />
            </dl>

            {s.activa && !puedeFacturar(s) && (
              <p
                className="mt-3 flex items-start gap-1.5 text-[12px]"
                style={{ color: "var(--warning)" }}
              >
                <TriangleAlert size={13} className="mt-px shrink-0" />
                Sin CUIT, condición y punto de venta esta sucursal no puede emitir comprobantes.
              </p>
            )}
          </div>
        ))}
      </div>

      {(creando || editando) && (
        <DialogoSucursal
          sucursal={editando}
          onCerrar={() => {
            setCreando(false);
            setEditando(null);
          }}
          onGuardado={async () => {
            setCreando(false);
            setEditando(null);
            await recargar();
          }}
        />
      )}
    </div>
  );
}

function puedeFacturar(s: Sucursal): boolean {
  return !!s.cuit && !!s.condicion_iva && s.punto_venta != null;
}

function Dato({
  etiqueta,
  valor,
  ancho,
}: {
  etiqueta: string;
  valor: string;
  ancho?: boolean;
}) {
  return (
    <div className={ancho ? "col-span-2" : ""}>
      <dt className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
        {etiqueta}
      </dt>
      <dd className="tabular">{valor}</dd>
    </div>
  );
}

function DialogoSucursal({
  sucursal,
  onCerrar,
  onGuardado,
}: {
  /** Null es alta. Con una sucursal adentro, el mismo formulario edita. */
  sucursal: Sucursal | null;
  onCerrar: () => void;
  onGuardado: () => void | Promise<void>;
}) {
  const [nombre, setNombre] = useState(sucursal?.nombre ?? "");
  const [alias, setAlias] = useState(sucursal?.alias ?? "");
  const [direccion, setDireccion] = useState(sucursal?.direccion ?? "");
  const [lat, setLat] = useState(sucursal?.lat?.toString() ?? "");
  const [lng, setLng] = useState(sucursal?.lng?.toString() ?? "");
  const [cuit, setCuit] = useState(sucursal?.cuit ?? "");
  const [condicion, setCondicion] = useState(sucursal?.condicion_iva ?? "");
  const [puntoVenta, setPuntoVenta] = useState(sucursal?.punto_venta?.toString() ?? "");
  const [activa, setActiva] = useState(sucursal?.activa ?? true);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guardar = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError(null);

    if (!nombre.trim() || !alias.trim() || !direccion.trim()) {
      setError("El nombre, el alias y la dirección son obligatorios.");
      return;
    }

    const cuitLimpio = cuit.replace(/[-\s.]/g, "");
    if (cuitLimpio && !/^\d{11}$/.test(cuitLimpio)) {
      setError("El CUIT son 11 números, sin guiones.");
      return;
    }

    const pv = puntoVenta.trim() ? Number(puntoVenta) : null;
    if (pv != null && (!Number.isInteger(pv) || pv < 1 || pv > 99998)) {
      setError("El punto de venta es un número entero entre 1 y 99998.");
      return;
    }

    const coordenada = (v: string) => (v.trim() ? Number(v) : null);
    const latN = coordenada(lat);
    const lngN = coordenada(lng);
    if ((latN != null && Number.isNaN(latN)) || (lngN != null && Number.isNaN(lngN))) {
      setError("La latitud y la longitud son números, por ejemplo -32.9468 y -60.6393.");
      return;
    }

    setEnviando(true);
    const campos = {
      nombre: nombre.trim(),
      alias: alias.trim(),
      direccion: direccion.trim(),
      lat: latN,
      lng: lngN,
      cuit: cuitLimpio || null,
      condicion_iva: condicion || null,
      punto_venta: pv,
      activa,
    };
    const { error: err } = sucursal
      ? await supa.from("sucursales").update(campos).eq("id", sucursal.id)
      : await supa.from("sucursales").insert(campos);
    setEnviando(false);

    if (err) {
      setError(mensajeError(err, "una sucursal"));
      return;
    }
    await onGuardado();
  };

  return (
    <Modal
      titulo={sucursal ? "Editar sucursal" : "Nueva sucursal"}
      ancho="max-w-lg"
      onCerrar={onCerrar}
    >
      <form onSubmit={guardar} className="space-y-3 text-[13px]">
        {error && <Alerta tono="danger">{error}</Alerta>}

        <div className="grid grid-cols-2 gap-3">
          <Campo etiqueta="Nombre">
            <input
              autoFocus
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              className={inputCls}
              style={inputStyle}
              placeholder="Sucursal Centro"
            />
          </Campo>
          <Campo etiqueta="Alias" ayuda="El nombre corto que sale en los tickets.">
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              className={inputCls}
              style={inputStyle}
              placeholder="Centro"
            />
          </Campo>
        </div>

        <Campo etiqueta="Dirección">
          <input
            value={direccion}
            onChange={(e) => setDireccion(e.target.value)}
            className={inputCls}
            style={inputStyle}
            placeholder="Calle Demo 123, Rosario"
          />
        </Campo>

        <div className="grid grid-cols-2 gap-3">
          <Campo etiqueta="Latitud">
            <input
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              className={inputCls}
              style={inputStyle}
              placeholder="-32.9468"
            />
          </Campo>
          <Campo etiqueta="Longitud">
            <input
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              className={inputCls}
              style={inputStyle}
              placeholder="-60.6393"
            />
          </Campo>
        </div>
        <p
          className="flex items-start gap-1.5 text-[12px]"
          style={{ color: "var(--muted-foreground)" }}
        >
          <MapPin size={13} className="mt-px shrink-0" />
          La ubicación es desde dónde arrancan los repartos. Se saca de Google Maps: botón derecho
          sobre el local y copiar las coordenadas.
        </p>

        <div className="pt-1" style={{ borderTop: "1px solid var(--border)" }} />

        <div className="grid grid-cols-2 gap-3">
          <Campo etiqueta="CUIT">
            <input
              value={cuit}
              onChange={(e) => setCuit(e.target.value)}
              className={inputCls}
              style={inputStyle}
              placeholder="30712345678"
            />
          </Campo>
          <Campo etiqueta="Punto de venta" ayuda="El número que dio ARCA para este local.">
            <input
              value={puntoVenta}
              onChange={(e) => setPuntoVenta(e.target.value)}
              inputMode="numeric"
              className={inputCls}
              style={inputStyle}
              placeholder="1"
            />
          </Campo>
        </div>

        <Campo etiqueta="Condición ante ARCA">
          <select
            value={condicion}
            onChange={(e) => setCondicion(e.target.value)}
            className={inputCls}
            style={inputStyle}
          >
            <option value="">Sin cargar</option>
            {CONDICIONES_EMISOR.map((c) => (
              <option key={c.valor} value={c.valor}>
                {c.label}
              </option>
            ))}
          </select>
        </Campo>

        <Alerta tono="info">
          Con estos tres datos el sistema arma el comprobante que corresponde: A o B si es
          responsable inscripto, C si es monotributista.
        </Alerta>

        {sucursal && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={activa} onChange={(e) => setActiva(e.target.checked)} />
            Sucursal abierta
          </label>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando}>
            {sucursal ? "Guardar cambios" : "Crear sucursal"}
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

function Campo({
  etiqueta,
  ayuda,
  children,
}: {
  etiqueta: string;
  ayuda?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
        {etiqueta}
      </label>
      {children}
      {ayuda && (
        <p className="mt-1 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
          {ayuda}
        </p>
      )}
    </div>
  );
}

/* ─────────────────────────── Categorías ─────────────────────────── */

function PanelCategorias({
  categorias,
  escalas,
  puedeEditar,
  recargar,
}: {
  categorias: Categoria[];
  escalas: Escala[];
  puedeEditar: boolean;
  recargar: () => Promise<void>;
}) {
  const [editando, setEditando] = useState<null | Categoria>(null);
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alternar = async (c: Categoria) => {
    const { error: err } = await supa
      .from("categorias")
      .update({ activa: !c.activa })
      .eq("id", c.id);
    if (err) setError(err.message);
    else await recargar();
  };

  return (
    <div className="space-y-4">
      <Encabezado
        titulo="Categorías del catálogo"
        ayuda="Cada categoría define con qué escala de talles se cargan sus productos. La ropa usa S/M/L y el calzado usa números."
        puedeEditar={puedeEditar}
        onNuevo={() => setCreando(true)}
        textoNuevo="Nueva categoría"
      />

      {error && <Alerta tono="danger">{error}</Alerta>}

      <Tabla columnas={["Categoría", "Escala de talles", "Orden", "Estado", ""]}>
        {categorias.map((c) => (
          <tr key={c.id} style={{ borderTop: "1px solid #eef1f6" }}>
            <td className="px-3 py-2 font-medium">{c.nombre}</td>
            <td className="px-3 py-2" style={{ color: "var(--muted-foreground)" }}>
              {escalas.find((e) => e.id === c.escala_talle_id)?.nombre ?? "Sin talles"}
            </td>
            <td className="tabular px-3 py-2" style={{ color: "var(--muted-foreground)" }}>
              {c.orden}
            </td>
            <td className="px-3 py-2">
              {c.activa ? <Chip tone="success">En uso</Chip> : <Chip tone="neutral">Guardada</Chip>}
            </td>
            <Acciones
              puedeEditar={puedeEditar}
              activo={c.activa}
              onEditar={() => setEditando(c)}
              onAlternar={() => alternar(c)}
            />
          </tr>
        ))}
      </Tabla>

      {(creando || editando) && (
        <DialogoCategoria
          categoria={editando}
          escalas={escalas}
          onCerrar={() => {
            setCreando(false);
            setEditando(null);
          }}
          onGuardado={async () => {
            setCreando(false);
            setEditando(null);
            await recargar();
          }}
        />
      )}
    </div>
  );
}

function DialogoCategoria({
  categoria,
  escalas,
  onCerrar,
  onGuardado,
}: {
  categoria: Categoria | null;
  escalas: Escala[];
  onCerrar: () => void;
  onGuardado: () => void | Promise<void>;
}) {
  const [nombre, setNombre] = useState(categoria?.nombre ?? "");
  const [escala, setEscala] = useState(categoria?.escala_talle_id ?? "");
  const [orden, setOrden] = useState((categoria?.orden ?? 0).toString());
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guardar = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError(null);
    if (!nombre.trim()) {
      setError("Poné un nombre.");
      return;
    }
    setEnviando(true);
    const campos = {
      nombre: nombre.trim(),
      escala_talle_id: escala || null,
      orden: Number(orden) || 0,
    };
    const { error: err } = categoria
      ? await supa.from("categorias").update(campos).eq("id", categoria.id)
      : await supa.from("categorias").insert(campos);
    setEnviando(false);
    if (err) {
      setError(mensajeError(err, "una categoría"));
      return;
    }
    await onGuardado();
  };

  return (
    <Modal titulo={categoria ? "Editar categoría" : "Nueva categoría"} onCerrar={onCerrar}>
      <form onSubmit={guardar} className="space-y-3 text-[13px]">
        {error && <Alerta tono="danger">{error}</Alerta>}
        <Campo etiqueta="Nombre">
          <input
            autoFocus
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className={inputCls}
            style={inputStyle}
            placeholder="Indumentaria"
          />
        </Campo>
        <Campo
          etiqueta="Escala de talles"
          ayuda="Si la dejás sin talles, los productos de esta categoría se cargan con una sola variante."
        >
          <select
            value={escala}
            onChange={(e) => setEscala(e.target.value)}
            className={inputCls}
            style={inputStyle}
          >
            <option value="">Sin talles</option>
            {escalas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nombre}
              </option>
            ))}
          </select>
        </Campo>
        <Campo etiqueta="Orden" ayuda="Los más chicos aparecen primero en las listas.">
          <input
            value={orden}
            onChange={(e) => setOrden(e.target.value)}
            inputMode="numeric"
            className={inputCls}
            style={inputStyle}
          />
        </Campo>
        <div className="flex justify-end gap-2 pt-1">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando}>Guardar</BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

/* ─────────────────────── Talles y colores ─────────────────────── */

function PanelTallesColores({
  escalas,
  talles,
  colores,
  puedeEditar,
  recargar,
}: {
  escalas: Escala[];
  talles: Talle[];
  colores: Simple[];
  puedeEditar: boolean;
  recargar: () => Promise<void>;
}) {
  const [escalaId, setEscalaId] = useState<string | null>(escalas[0]?.id ?? null);
  const [nuevaEscala, setNuevaEscala] = useState(false);
  const [nuevoTalle, setNuevoTalle] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const elegida = escalas.find((e) => e.id === escalaId) ?? escalas[0] ?? null;
  const suyos = elegida ? talles.filter((t) => t.escala_id === elegida.id) : [];

  const alternarTalle = async (t: Talle) => {
    const { error: err } = await supa.from("talles").update({ activo: !t.activo }).eq("id", t.id);
    if (err) setError(err.message);
    else await recargar();
  };

  return (
    <div className="space-y-6">
      <div>
        <Encabezado
          titulo="Escalas de talle"
          ayuda="Una escala es una lista de talles con su orden. El calzado va del 34 al 45, la ropa de XS a XXL: cada categoría usa la suya."
          puedeEditar={puedeEditar}
          onNuevo={() => setNuevaEscala(true)}
          textoNuevo="Nueva escala"
        />

        {error && (
          <div className="mt-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}

        {escalas.length === 0 ? (
          <p className="mt-3 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            Todavía no hay ninguna escala cargada.
          </p>
        ) : (
          <div className="mt-3 grid gap-4 md:grid-cols-[220px_1fr]">
            <div className="rounded-md border" style={{ borderColor: "var(--border)" }}>
              {escalas.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setEscalaId(e.id)}
                  className="block w-full px-3 py-2 text-left text-[13px]"
                  style={{
                    background: e.id === elegida?.id ? "#fdf3ef" : "transparent",
                    color: e.id === elegida?.id ? "var(--primary)" : "var(--foreground)",
                    borderBottom: "1px solid #eef1f6",
                  }}
                >
                  {e.nombre}
                  <span className="ml-1 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                    ({talles.filter((t) => t.escala_id === e.id).length})
                  </span>
                </button>
              ))}
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[13px] font-medium">Talles de {elegida?.nombre}</span>
                {puedeEditar && elegida && (
                  <button
                    type="button"
                    onClick={() => setNuevoTalle(true)}
                    className="flex items-center gap-1 text-[12px] font-medium"
                    style={{ color: "var(--primary)" }}
                  >
                    <Plus size={13} />
                    Agregar talle
                  </button>
                )}
              </div>
              {suyos.length === 0 ? (
                <p className="text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                  Esta escala todavía no tiene talles.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {suyos.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      disabled={!puedeEditar}
                      onClick={() => alternarTalle(t)}
                      title={t.activo ? "Sacar de la lista" : "Volver a usar"}
                      className="rounded-md border px-2.5 py-1 text-[13px] disabled:cursor-default"
                      style={{
                        borderColor: "var(--border)",
                        background: t.activo ? "var(--surface)" : "#f9fafc",
                        color: t.activo ? "var(--foreground)" : "var(--muted-foreground)",
                        textDecoration: t.activo ? "none" : "line-through",
                      }}
                    >
                      {t.valor}
                    </button>
                  ))}
                </div>
              )}
              {puedeEditar && suyos.length > 0 && (
                <p className="mt-2 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                  Tocá un talle para dejar de usarlo. No se borra: los productos que ya lo tienen
                  cargado lo siguen mostrando.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <div style={{ borderTop: "1px solid var(--border)" }} className="pt-6">
        <ListaSimple
          tabla="colores"
          campoActivo="activo"
          singular="un color"
          titulo="Colores"
          ayuda="La lista de colores con la que se cargan las variantes. Conviene tenerla corta: cuantos más colores, más combinaciones para contar en el stock."
          filas={colores}
          puedeEditar={puedeEditar}
          recargar={recargar}
        />
      </div>

      {nuevaEscala && (
        <DialogoNombre
          titulo="Nueva escala de talles"
          etiqueta="Nombre"
          placeholder="Ropa"
          onCerrar={() => setNuevaEscala(false)}
          onGuardar={async (valor, orden) => {
            const { error: err } = await supa
              .from("escalas_talle")
              .insert({ nombre: valor, orden });
            if (err) return mensajeError(err, "una escala");
            setNuevaEscala(false);
            await recargar();
            return null;
          }}
        />
      )}

      {nuevoTalle && elegida && (
        <DialogoNombre
          titulo={`Nuevo talle en ${elegida.nombre}`}
          etiqueta="Talle"
          placeholder="42"
          ordenSugerido={(suyos.at(-1)?.orden ?? 0) + 10}
          onCerrar={() => setNuevoTalle(false)}
          onGuardar={async (valor, orden) => {
            const { error: err } = await supa
              .from("talles")
              .insert({ escala_id: elegida.id, valor, orden });
            if (err) return mensajeError(err, "un talle");
            setNuevoTalle(false);
            await recargar();
            return null;
          }}
        />
      )}
    </div>
  );
}

/* ─────────────────────── Medios de pago ─────────────────────── */

function PanelMedios({
  medios,
  puedeEditar,
  recargar,
}: {
  medios: Medio[];
  puedeEditar: boolean;
  recargar: () => Promise<void>;
}) {
  const [editando, setEditando] = useState<null | Medio>(null);
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alternar = async (m: Medio) => {
    const { error: err } = await supa
      .from("medios_pago")
      .update({ activo: !m.activo })
      .eq("id", m.id);
    if (err) setError(err.message);
    else await recargar();
  };

  return (
    <div className="space-y-4">
      <Encabezado
        titulo="Medios de pago"
        ayuda="El recargo se suma solo al total del ticket cuando se cobra con ese medio. Está acá y no escrito en el código: cuando la terminal cambia el arancel, se cambia el número y listo."
        puedeEditar={puedeEditar}
        onNuevo={() => setCreando(true)}
        textoNuevo="Nuevo medio"
      />

      {error && <Alerta tono="danger">{error}</Alerta>}

      <Tabla columnas={["Medio", "Recargo", "Cómo funciona", "Orden", "Estado", ""]}>
        {medios.map((m) => (
          <tr key={m.id} style={{ borderTop: "1px solid #eef1f6" }}>
            <td className="px-3 py-2 font-medium">{m.nombre}</td>
            <td className="tabular px-3 py-2">
              {m.recargo_porcentaje > 0 ? `${m.recargo_porcentaje}%` : "Sin recargo"}
            </td>
            <td className="px-3 py-2">
              <div className="flex flex-wrap gap-1.5">
                {m.cuotas > 1 && <Chip tone="neutral">{m.cuotas} cuotas</Chip>}
                {m.afecta_caja && <Chip tone="success">Entra a la caja</Chip>}
                {m.es_cuenta_corriente && <Chip tone="violet">Queda fiado</Chip>}
                {!m.afecta_caja && !m.es_cuenta_corriente && (
                  <span className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                    Va al banco
                  </span>
                )}
              </div>
            </td>
            <td className="tabular px-3 py-2" style={{ color: "var(--muted-foreground)" }}>
              {m.orden}
            </td>
            <td className="px-3 py-2">
              {m.activo ? <Chip tone="success">En uso</Chip> : <Chip tone="neutral">Guardado</Chip>}
            </td>
            <Acciones
              puedeEditar={puedeEditar}
              activo={m.activo}
              onEditar={() => setEditando(m)}
              onAlternar={() => alternar(m)}
            />
          </tr>
        ))}
      </Tabla>

      <p className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
        Si un medio entra a la caja o queda fiado no se cambia después: el arqueo y las cuentas
        corrientes viejas se calcularon con esa regla. Para cobrar distinto, creá otro medio.
      </p>

      {(creando || editando) && (
        <DialogoMedio
          medio={editando}
          onCerrar={() => {
            setCreando(false);
            setEditando(null);
          }}
          onGuardado={async () => {
            setCreando(false);
            setEditando(null);
            await recargar();
          }}
        />
      )}
    </div>
  );
}

function DialogoMedio({
  medio,
  onCerrar,
  onGuardado,
}: {
  medio: Medio | null;
  onCerrar: () => void;
  onGuardado: () => void | Promise<void>;
}) {
  const [nombre, setNombre] = useState(medio?.nombre ?? "");
  const [recargo, setRecargo] = useState((medio?.recargo_porcentaje ?? 0).toString());
  const [cuotas, setCuotas] = useState((medio?.cuotas ?? 1).toString());
  const [orden, setOrden] = useState((medio?.orden ?? 100).toString());
  const [afectaCaja, setAfectaCaja] = useState(medio?.afecta_caja ?? false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guardar = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError(null);
    if (!nombre.trim()) {
      setError("Poné un nombre.");
      return;
    }
    const r = Number(recargo.replace(",", "."));
    if (Number.isNaN(r) || r < 0) {
      setError("El recargo es un porcentaje, de cero para arriba.");
      return;
    }
    const c = Number(cuotas);
    if (!Number.isInteger(c) || c < 1) {
      setError("Las cuotas son un número entero, de 1 para arriba. Un pago es 1.");
      return;
    }

    setEnviando(true);
    // `afecta_caja` y `es_cuenta_corriente` solo se definen al crear: cambiarlos
    // después reescribiría el sentido de arqueos y fiados ya cerrados.
    //
    // Las cuotas sí se pueden cambiar: cada pago se llevó las suyas al cobrarse,
    // así que corregir el plan hoy no toca ninguna venta vieja.
    const campos: Record<string, unknown> = {
      nombre: nombre.trim(),
      recargo_porcentaje: r,
      cuotas: c,
      orden: Number(orden) || 100,
    };
    if (!medio) campos.afecta_caja = afectaCaja;
    const { error: err } = medio
      ? await supa.from("medios_pago").update(campos).eq("id", medio.id)
      : await supa.from("medios_pago").insert(campos);
    setEnviando(false);
    if (err) {
      setError(mensajeError(err, "un medio de pago"));
      return;
    }
    await onGuardado();
  };

  return (
    <Modal titulo={medio ? `Editar ${medio.nombre}` : "Nuevo medio de pago"} onCerrar={onCerrar}>
      <form onSubmit={guardar} className="space-y-3 text-[13px]">
        {error && <Alerta tono="danger">{error}</Alerta>}
        <Campo etiqueta="Nombre">
          <input
            autoFocus
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className={inputCls}
            style={inputStyle}
            placeholder="Crédito 3 cuotas"
          />
        </Campo>
        <div className="grid grid-cols-3 gap-3">
          <Campo etiqueta="Recargo %" ayuda="Cero si no recarga nada.">
            <input
              value={recargo}
              onChange={(e) => setRecargo(e.target.value)}
              inputMode="decimal"
              className={inputCls}
              style={inputStyle}
            />
          </Campo>
          <Campo etiqueta="Cuotas" ayuda="Un pago es 1.">
            <input
              value={cuotas}
              onChange={(e) => setCuotas(e.target.value)}
              inputMode="numeric"
              className={inputCls}
              style={inputStyle}
            />
          </Campo>
          <Campo etiqueta="Orden">
            <input
              value={orden}
              onChange={(e) => setOrden(e.target.value)}
              inputMode="numeric"
              className={inputCls}
              style={inputStyle}
            />
          </Campo>
        </div>

        {medio ? (
          <Alerta tono="info">
            {medio.afecta_caja
              ? "Lo cobrado con este medio entra al cajón y se cuenta en el arqueo."
              : medio.es_cuenta_corriente
                ? "Lo cobrado con este medio queda como deuda del cliente."
                : "Lo cobrado con este medio no pasa por el cajón: va al banco."}
          </Alerta>
        ) : (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={afectaCaja}
              onChange={(e) => setAfectaCaja(e.target.checked)}
            />
            <span>
              Entra al cajón
              <span className="block text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                Marcalo solo si es plata en mano. Lo que va a una cuenta bancaria no se cuenta en el
                arqueo.
              </span>
            </span>
          </label>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando}>Guardar</BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

/* ─────────────────────── Listas simples ─────────────────────── */

/**
 * Colores y rubros de gasto son la misma pantalla: un nombre, un orden y un
 * interruptor. Se escribe una vez y se usa dos, con el nombre de la tabla y el
 * de la columna de activo como parámetros.
 */
function ListaSimple({
  tabla,
  campoActivo,
  singular,
  titulo,
  ayuda,
  filas,
  puedeEditar,
  recargar,
}: {
  tabla: string;
  campoActivo: "activo" | "activa";
  singular: string;
  titulo: string;
  ayuda: string;
  filas: Simple[];
  puedeEditar: boolean;
  recargar: () => Promise<void>;
}) {
  const [editando, setEditando] = useState<null | Simple>(null);
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alternar = async (f: Simple) => {
    const { error: err } = await supa
      .from(tabla)
      .update({ [campoActivo]: !f.activo })
      .eq("id", f.id);
    if (err) setError(err.message);
    else await recargar();
  };

  return (
    <div className="space-y-4">
      <Encabezado
        titulo={titulo}
        ayuda={ayuda}
        puedeEditar={puedeEditar}
        onNuevo={() => setCreando(true)}
        textoNuevo="Agregar"
      />

      {error && <Alerta tono="danger">{error}</Alerta>}

      <Tabla columnas={["Nombre", "Orden", "Estado", ""]}>
        {filas.map((f) => (
          <tr key={f.id} style={{ borderTop: "1px solid #eef1f6" }}>
            <td className="px-3 py-2 font-medium">{f.nombre}</td>
            <td className="tabular px-3 py-2" style={{ color: "var(--muted-foreground)" }}>
              {f.orden}
            </td>
            <td className="px-3 py-2">
              {f.activo ? <Chip tone="success">En uso</Chip> : <Chip tone="neutral">Guardado</Chip>}
            </td>
            <Acciones
              puedeEditar={puedeEditar}
              activo={f.activo}
              onEditar={() => setEditando(f)}
              onAlternar={() => alternar(f)}
            />
          </tr>
        ))}
      </Tabla>

      {(creando || editando) && (
        <DialogoNombre
          titulo={editando ? `Editar ${editando.nombre}` : titulo}
          etiqueta="Nombre"
          valorInicial={editando?.nombre}
          ordenSugerido={editando?.orden ?? (filas.at(-1)?.orden ?? 0) + 10}
          onCerrar={() => {
            setCreando(false);
            setEditando(null);
          }}
          onGuardar={async (valor, orden) => {
            const campos = { nombre: valor, orden };
            const { error: err } = editando
              ? await supa.from(tabla).update(campos).eq("id", editando.id)
              : await supa.from(tabla).insert(campos);
            if (err) return mensajeError(err, singular);
            setCreando(false);
            setEditando(null);
            await recargar();
            return null;
          }}
        />
      )}
    </div>
  );
}

/** Diálogo de un solo campo más el orden. Devuelve el error para mostrarlo adentro. */
function DialogoNombre({
  titulo,
  etiqueta,
  placeholder,
  valorInicial,
  ordenSugerido,
  onCerrar,
  onGuardar,
}: {
  titulo: string;
  etiqueta: string;
  placeholder?: string;
  valorInicial?: string;
  ordenSugerido?: number;
  onCerrar: () => void;
  onGuardar: (valor: string, orden: number) => Promise<string | null>;
}) {
  const [valor, setValor] = useState(valorInicial ?? "");
  const [orden, setOrden] = useState((ordenSugerido ?? 10).toString());
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guardar = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError(null);
    if (!valor.trim()) {
      setError("Poné un nombre.");
      return;
    }
    setEnviando(true);
    const err = await onGuardar(valor.trim(), Number(orden) || 0);
    setEnviando(false);
    if (err) setError(err);
  };

  return (
    <Modal titulo={titulo} onCerrar={onCerrar}>
      <form onSubmit={guardar} className="space-y-3 text-[13px]">
        {error && <Alerta tono="danger">{error}</Alerta>}
        <Campo etiqueta={etiqueta}>
          <input
            autoFocus
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            className={inputCls}
            style={inputStyle}
            placeholder={placeholder}
          />
        </Campo>
        <Campo etiqueta="Orden" ayuda="Los más chicos aparecen primero.">
          <input
            value={orden}
            onChange={(e) => setOrden(e.target.value)}
            inputMode="numeric"
            className={inputCls}
            style={inputStyle}
          />
        </Campo>
        <div className="flex justify-end gap-2 pt-1">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando}>Guardar</BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

/* ─────────────────────── Piezas compartidas ─────────────────────── */

function Encabezado({
  titulo,
  ayuda,
  puedeEditar,
  onNuevo,
  textoNuevo,
}: {
  titulo: string;
  ayuda: string;
  puedeEditar: boolean;
  onNuevo: () => void;
  textoNuevo: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-[14px] font-semibold">{titulo}</h3>
        <p className="mt-1 max-w-2xl text-[13px]" style={{ color: "var(--muted-foreground)" }}>
          {ayuda}
        </p>
      </div>
      {puedeEditar && (
        <button
          type="button"
          onClick={onNuevo}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white"
          style={{ background: "var(--primary)" }}
        >
          <Plus size={14} />
          {textoNuevo}
        </button>
      )}
    </div>
  );
}

function Tabla({ columnas, children }: { columnas: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border" style={{ borderColor: "var(--border)" }}>
      <table className="w-full text-[13px]">
        <thead style={{ background: "#f9fafc" }}>
          <tr style={{ color: "var(--muted-foreground)" }}>
            {columnas.map((c, i) => (
              <th key={i} className="px-3 py-2 text-left text-[12px] font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Acciones({
  puedeEditar,
  activo,
  onEditar,
  onAlternar,
}: {
  puedeEditar: boolean;
  activo: boolean;
  onEditar: () => void;
  onAlternar: () => void;
}) {
  if (!puedeEditar) return <td className="px-3 py-2" />;
  return (
    <td className="px-3 py-2">
      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={onEditar}
          className="flex items-center gap-1 text-[12px] font-medium"
          style={{ color: "var(--primary)" }}
        >
          <Pencil size={13} />
          Editar
        </button>
        <button
          type="button"
          onClick={onAlternar}
          className="text-[12px] font-medium"
          style={{ color: "var(--muted-foreground)" }}
        >
          {activo ? "Dejar de usar" : "Volver a usar"}
        </button>
      </div>
    </td>
  );
}

/* ─────────────────────── Negocio (maqueta) ─────────────────────── */

/**
 * Esta pestaña todavía no tiene tabla atrás: los datos son de muestra y se van a
 * cargar de verdad en la reunión con el cliente. Se deja marcada como maqueta
 * para que nadie la lea como si fuera información real.
 */
function PanelNegocio() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[14px] font-semibold">Datos del negocio</h3>
        <Chip tone="warning">Datos de muestra</Chip>
      </div>
      <p className="max-w-2xl text-[13px]" style={{ color: "var(--muted-foreground)" }}>
        Falta cargar el nombre, el rubro y el logo reales. Los de abajo son de ejemplo.
      </p>
      <div className="grid max-w-2xl grid-cols-2 gap-4 text-[13px]">
        <Field label="Nombre del negocio" value="Calzados Demo" />
        <Field label="Rubro" value="Calzado y deportes" />
        <Field label="Sitio web" value="pymeos.ar/demo" />
        <Field label="Teléfono" value="+54 000 000-0000" />
        <div className="col-span-2">
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Logo
          </label>
          <div className="mt-1 flex items-center gap-3">
            <div
              className="grid h-16 w-16 place-items-center rounded-md text-[18px] font-bold text-white"
              style={{ background: "var(--sidebar)" }}
            >
              L
            </div>
            <button className="rounded-md border px-3 py-1.5 text-[13px]" style={inputStyle}>
              Cambiar logo
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * La conexión con ARCA todavía no existe: el sistema arma el comprobante y
 * guarda el CAE que devuelve quien lo emite, pero no lo pide por su cuenta. Lo
 * que se ve acá es de muestra, hasta que se defina con quién se integra.
 */
function PanelFacturacion({ sucursales }: { sucursales: Sucursal[] }) {
  const listas = sucursales.filter((s) => s.activa && puedeFacturar(s)).length;
  const activas = sucursales.filter((s) => s.activa).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[14px] font-semibold">Conexión con ARCA</h3>
        <Chip tone="warning">Datos de muestra</Chip>
      </div>
      <p className="max-w-2xl text-[13px]" style={{ color: "var(--muted-foreground)" }}>
        Hoy el sistema arma el comprobante con sus líneas y su tipo, y guarda el CAE cuando se lo
        cargan. Todavía no lo pide solo: eso se conecta cuando se defina el proveedor. Los datos de
        abajo son de ejemplo.
      </p>

      <Alerta tono="info">
        {listas} de {activas} sucursales activas tienen cargados CUIT, condición y punto de venta.
      </Alerta>

      <div className="grid max-w-2xl grid-cols-2 gap-4 text-[13px]">
        <Field label="Certificado ARCA" value="certificado-demo.crt (activo)" />
        <Field label="Vencimiento" value="12/03/2028" />
        <Field label="Ambiente" value="Producción" />
        <Field label="Numeración automática" value="Sí" />
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
        {label}
      </label>
      <input defaultValue={value} className={inputCls} style={inputStyle} />
    </div>
  );
}
