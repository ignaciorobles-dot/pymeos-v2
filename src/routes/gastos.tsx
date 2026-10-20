import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Ban, ListPlus, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Alerta,
  BotonPrimario,
  BotonSecundario,
  Modal,
  inputCls,
  inputStyle,
} from "@/components/ui-bits/Modal";
import { Agregar, Fila, type Ejecutar } from "@/components/ui-bits/ListaEditable";
import { Chip } from "@/components/ui-bits/Chip";
import { useSesion, useSucursalOperativa, type Sucursal } from "@/lib/sesion";
import { supa } from "@/lib/supabase";
import { formatARS } from "@/lib/format";

export const Route = createFileRoute("/gastos")({
  head: () => ({
    meta: [
      { title: "Gastos — PymeOS" },
      {
        name: "description",
        content: "Registro de gastos operativos por sucursal, con o sin salida de caja.",
      },
    ],
  }),
  component: Gastos,
});

type Categoria = { id: string; nombre: string; orden: number; activa: boolean };

type Gasto = {
  id: string;
  fecha: string;
  detalle: string;
  monto: number;
  paga_caja: boolean;
  anulado: boolean;
  motivo_anulacion: string | null;
  categoria: { nombre: string } | null;
  sucursal: { nombre: string } | null;
};

/**
 * El período que se está mirando, como lo escribe un `<input type="month">`.
 * Se calcula del reloj del navegador una sola vez y fuera del render: si se
 * calcula mientras se dibuja, el servidor y el navegador pueden caer en días
 * distintos y React se queja de que el HTML no coincide.
 */
function mesActual(): string {
  const hoy = new Date();
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
}

function hoyISO(): string {
  const hoy = new Date();
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(
    hoy.getDate(),
  ).padStart(2, "0")}`;
}

/** Primer y último día del mes, como los espera la base. */
function rangoDelMes(mes: string): { desde: string; hasta: string } {
  const [a, m] = mes.split("-").map(Number);
  const ultimo = new Date(a, m, 0).getDate();
  return { desde: `${mes}-01`, hasta: `${mes}-${String(ultimo).padStart(2, "0")}` };
}

function nombreDelMes(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  const texto = new Date(a, m - 1, 1).toLocaleDateString("es-AR", {
    month: "long",
    year: "numeric",
  });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function fechaCorta(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a.slice(2)}`;
}

function aNumero(texto: string): number {
  const n = Number(texto.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function Gastos() {
  const { usuario, sucursalEquipo, verTodas } = useSesion();
  const sucursalOperativa = useSucursalOperativa();
  const esDueno = usuario?.rol === "dueno";

  const [mes, setMes] = useState(mesActual);
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [gastos, setGastos] = useState<Gasto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  const [busqueda, setBusqueda] = useState("");
  const [filtroCategoria, setFiltroCategoria] = useState("");
  const [editandoListas, setEditandoListas] = useState(false);
  const [anulando, setAnulando] = useState<Gasto | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setErrorCarga(null);
    const { desde, hasta } = rangoDelMes(mes);

    // Cuando el equipo está parado en una sucursal se muestran los gastos de
    // esa sucursal. En "ver las dos" se muestran los de las dos, y ahí la
    // pantalla es de mirar: registrar sigue necesitando estar parado en una.
    let consulta = supa
      .from("gastos")
      .select(
        "id, fecha, detalle, monto, paga_caja, anulado, motivo_anulacion, categoria:categorias_gasto(nombre), sucursal:sucursales(nombre)",
      )
      .gte("fecha", desde)
      .lte("fecha", hasta)
      .order("fecha", { ascending: false });

    if (sucursalOperativa) consulta = consulta.eq("sucursal_id", sucursalOperativa.id);

    const [cats, filas] = await Promise.all([
      supa.from("categorias_gasto").select("id, nombre, orden, activa").order("orden"),
      consulta,
    ]);

    const fallo = cats.error ?? filas.error;
    if (fallo) setErrorCarga(fallo.message);
    else {
      setCategorias((cats.data ?? []) as Categoria[]);
      setGastos((filas.data ?? []) as unknown as Gasto[]);
    }
    setCargando(false);
  }, [mes, sucursalOperativa]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const visibles = useMemo(() => {
    const texto = busqueda.trim().toLowerCase();
    return gastos.filter((g) => {
      if (filtroCategoria && g.categoria?.nombre !== filtroCategoria) return false;
      if (!texto) return true;
      return (
        g.detalle.toLowerCase().includes(texto) ||
        (g.categoria?.nombre ?? "").toLowerCase().includes(texto)
      );
    });
  }, [gastos, busqueda, filtroCategoria]);

  // Lo anulado se sigue viendo —queda el rastro— pero no suma al total: esa
  // plata volvió.
  const total = useMemo(
    () => visibles.reduce((s, g) => (g.anulado ? s : s + Number(g.monto)), 0),
    [visibles],
  );

  const alcance = sucursalOperativa
    ? sucursalOperativa.nombre
    : verTodas
      ? "Las dos sucursales"
      : "Sin sucursal activa";

  return (
    <>
      <PageHeader
        title="Gastos"
        subtitle={`${nombreDelMes(mes)} · ${alcance} · Total ${formatARS(total)}`}
        actions={
          esDueno ? (
            <button
              onClick={() => setEditandoListas(true)}
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px]"
              style={inputStyle}
            >
              <ListPlus size={13} /> Categorías
            </button>
          ) : null
        }
      />

      {errorCarga && (
        <div className="mb-3">
          <Alerta tono="danger">{errorCarga}</Alerta>
        </div>
      )}

      {!sucursalEquipo && (
        <div className="mb-3">
          <Alerta tono="warning">
            Este equipo todavía no tiene una sucursal activa. Un gasto se anota en el local donde
            se hizo, y el local lo dice la computadora: elegilo en Configuración.
          </Alerta>
        </div>
      )}

      <div className="grid grid-cols-[1fr_360px] gap-3">
        <div className="card-surface overflow-hidden">
          <div
            className="flex items-center gap-2 px-4 py-3"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar gasto…"
              className="h-8 flex-1 rounded-md border px-3 text-[13px] outline-none"
              style={inputStyle}
            />
            <select
              value={filtroCategoria}
              onChange={(e) => setFiltroCategoria(e.target.value)}
              className="h-8 rounded-md border px-2 text-[13px]"
              style={inputStyle}
            >
              <option value="">Todas las categorías</option>
              {categorias.map((c) => (
                <option key={c.id} value={c.nombre}>
                  {c.nombre}
                </option>
              ))}
            </select>
            <input
              type="month"
              value={mes}
              onChange={(e) => setMes(e.target.value || mesActual())}
              className="h-8 rounded-md border px-2 text-[13px]"
              style={inputStyle}
            />
          </div>

          {cargando ? (
            <div
              className="flex items-center gap-2 px-4 py-6 text-[13px]"
              style={{ color: "var(--muted-foreground)" }}
            >
              <Loader2 size={14} className="animate-spin" /> Buscando los gastos del período…
            </div>
          ) : visibles.length === 0 ? (
            <div className="px-4 py-6 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
              No hay gastos cargados en {nombreDelMes(mes)}.
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead style={{ background: "#f9fafc" }}>
                <tr style={{ color: "var(--muted-foreground)" }}>
                  <th className="px-4 py-2 text-left font-medium">Categoría</th>
                  <th className="px-4 py-2 text-left font-medium">Detalle</th>
                  <th className="px-4 py-2 text-left font-medium">Sucursal</th>
                  <th className="px-4 py-2 text-left font-medium">Fecha</th>
                  <th className="px-4 py-2 text-right font-medium">Monto</th>
                  {esDueno && <th className="px-4 py-2" />}
                </tr>
              </thead>
              <tbody>
                {visibles.map((g) => (
                  <tr
                    key={g.id}
                    style={{ borderTop: "1px solid var(--border)", opacity: g.anulado ? 0.5 : 1 }}
                  >
                    <td className="px-4 py-2">
                      <Chip tone="neutral">{g.categoria?.nombre ?? "—"}</Chip>
                    </td>
                    <td className="px-4 py-2">
                      {g.detalle}
                      <span className="ml-2 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                        {g.anulado
                          ? `anulado · ${g.motivo_anulacion ?? ""}`
                          : g.paga_caja
                            ? "pagado de la caja"
                            : "pagado por afuera"}
                      </span>
                    </td>
                    <td className="px-4 py-2">{g.sucursal?.nombre ?? "—"}</td>
                    <td className="px-4 py-2 tabular" style={{ color: "var(--muted-foreground)" }}>
                      {fechaCorta(g.fecha)}
                    </td>
                    <td
                      className="px-4 py-2 text-right tabular font-medium"
                      style={g.anulado ? { textDecoration: "line-through" } : undefined}
                    >
                      {formatARS(Number(g.monto))}
                    </td>
                    {esDueno && (
                      <td className="px-4 py-2 text-right">
                        {!g.anulado && (
                          <button
                            onClick={() => setAnulando(g)}
                            className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]"
                            style={inputStyle}
                          >
                            <Ban size={11} /> Anular
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                <tr style={{ borderTop: "1px solid var(--border)", background: "#f9fafc" }}>
                  <td colSpan={esDueno ? 5 : 4} className="px-4 py-2 text-right font-medium">
                    Total del período
                  </td>
                  <td className="px-4 py-2 text-right tabular font-bold">{formatARS(total)}</td>
                  {esDueno && <td />}
                </tr>
              </tbody>
            </table>
          )}
        </div>

        <PanelRegistrar
          sucursal={sucursalOperativa}
          categorias={categorias.filter((c) => c.activa)}
          esDueno={esDueno}
          onGuardado={cargar}
        />
      </div>

      {editandoListas && (
        <DialogoCategorias
          categorias={categorias}
          onCambio={cargar}
          onCerrar={() => setEditandoListas(false)}
        />
      )}

      {anulando && (
        <DialogoAnular
          gasto={anulando}
          onCerrar={() => setAnulando(null)}
          onListo={async () => {
            setAnulando(null);
            await cargar();
          }}
        />
      )}
    </>
  );
}

/**
 * El alta. No tiene selector de sucursal a propósito: el gasto se anota en la
 * sucursal en la que está trabajando el equipo. Manda el equipo, no la persona.
 */
function PanelRegistrar({
  sucursal,
  categorias,
  esDueno,
  onGuardado,
}: {
  sucursal: Sucursal | null;
  categorias: Categoria[];
  esDueno: boolean;
  onGuardado: () => Promise<void>;
}) {
  const [categoriaId, setCategoriaId] = useState("");
  const [detalle, setDetalle] = useState("");
  const [monto, setMonto] = useState("");
  const [fecha, setFecha] = useState(hoyISO);
  const [pagaCaja, setPagaCaja] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState(false);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (!sucursal) return;
    setEnviando(true);
    setError(null);
    setListo(false);

    const { error: err } = await supa.rpc("registrar_gasto", {
      p_sucursal_id: sucursal.id,
      p_categoria_id: categoriaId,
      p_detalle: detalle,
      p_monto: aNumero(monto),
      p_fecha: fecha,
      p_paga_caja: pagaCaja,
    });
    setEnviando(false);

    if (err) {
      setError(err.message);
      return;
    }
    setDetalle("");
    setMonto("");
    setPagaCaja(false);
    setListo(true);
    await onGuardado();
  }

  if (!sucursal) {
    return (
      <aside className="card-surface p-4">
        <div className="text-[14px] font-semibold">Registrar gasto</div>
        <div className="mt-3">
          <Alerta tono="warning">
            Para anotar un gasto hay que estar parado en una sucursal. Si estás mirando las dos
            juntas, salí de ese modo: mirar todo junto sí, operar sobre «las dos» no existe.
          </Alerta>
        </div>
      </aside>
    );
  }

  return (
    <aside className="card-surface p-4">
      <div className="text-[14px] font-semibold">Registrar gasto</div>
      <div className="mt-0.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
        Se anota en {sucursal.nombre}, que es donde está trabajando este equipo.
      </div>

      <form onSubmit={(e) => void guardar(e)} className="mt-3 space-y-3 text-[13px]">
        <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
          Categoría
          <select
            value={categoriaId}
            onChange={(e) => setCategoriaId(e.target.value)}
            required
            className={inputCls}
            style={inputStyle}
          >
            <option value="">Elegí una</option>
            {categorias.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
          Detalle
          <input
            value={detalle}
            onChange={(e) => setDetalle(e.target.value)}
            placeholder="Factura de luz de julio"
            required
            className={inputCls}
            style={inputStyle}
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label
            className="block text-[12px] font-medium"
            style={{ color: "var(--muted-foreground)" }}
          >
            Monto
            <input
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              inputMode="decimal"
              placeholder="0"
              required
              className={`${inputCls} tabular`}
              style={inputStyle}
            />
          </label>
          <label
            className="block text-[12px] font-medium"
            style={{ color: "var(--muted-foreground)" }}
          >
            Fecha
            <input
              type="date"
              value={fecha}
              max={hoyISO()}
              onChange={(e) => setFecha(e.target.value)}
              required
              className={inputCls}
              style={inputStyle}
            />
          </label>
        </div>

        {/* El gasto que se paga del cajón tiene que salir de la caja de verdad,
            si no el arqueo de la noche no cierra y nadie sabe por qué. */}
        {esDueno ? (
          <label className="flex items-start gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={pagaCaja}
              onChange={(e) => {
                setPagaCaja(e.target.checked);
                if (e.target.checked) setFecha(hoyISO());
              }}
              className="mt-0.5"
            />
            <span>
              Lo pagué de la caja
              <span className="block" style={{ color: "var(--muted-foreground)" }}>
                Sale del cajón de hoy y queda como movimiento de caja. Sin tildar, se entiende
                pagado por afuera (banco, transferencia, débito).
              </span>
            </span>
          </label>
        ) : (
          <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Queda anotado como pagado por afuera. Sacar plata del cajón lo firma un dueño.
          </div>
        )}

        {error && <Alerta tono="danger">{error}</Alerta>}
        {listo && <Alerta tono="info">Gasto guardado.</Alerta>}

        <BotonPrimario enviando={enviando} disabled={!categoriaId}>
          Guardar gasto
        </BotonPrimario>
      </form>
    </aside>
  );
}

/** El ABM de categorías de gasto. Mismo criterio que las listas del catálogo. */
function DialogoCategorias({
  categorias,
  onCambio,
  onCerrar,
}: {
  categorias: Categoria[];
  onCambio: () => Promise<void>;
  onCerrar: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const ejecutar: Ejecutar = useCallback(
    async (accion) => {
      setOcupado(true);
      setError(null);
      const { error: err } = await accion();
      setOcupado(false);

      if (!err) {
        await onCambio();
        return true;
      }
      if (err.message.includes("duplicate key") || err.message.includes("unico")) {
        setError("Esa categoría ya está en la lista.");
      } else {
        setError(err.message);
      }
      return false;
    },
    [onCambio],
  );

  return (
    <Modal titulo="Categorías de gasto" ancho="max-w-lg" onCerrar={onCerrar}>
      <p className="mb-3 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
        Se eligen de esta lista y no se escriben a mano, para que no convivan «Luz» y «Energía
        eléctrica» y el total por categoría siga queriendo decir algo. Una categoría que se deja de
        usar se desactiva: los gastos viejos la conservan.
      </p>

      {error && (
        <div className="mb-3">
          <Alerta tono="danger">{error}</Alerta>
        </div>
      )}

      <Agregar
        placeholder="Nombre de la categoría"
        ocupado={ocupado}
        onAgregar={(nombre) =>
          ejecutar(() =>
            supa
              .from("categorias_gasto")
              .insert({ nombre, orden: categorias.length * 10 + 10 }),
          )
        }
      />

      <div className="mt-3 max-h-80 overflow-y-auto">
        {categorias.map((c) => (
          <Fila
            key={c.id}
            nombre={c.nombre}
            activo={c.activa}
            ocupado={ocupado}
            onRenombrar={(nuevo) =>
              ejecutar(() => supa.from("categorias_gasto").update({ nombre: nuevo }).eq("id", c.id))
            }
            onAlternar={() =>
              void ejecutar(() =>
                supa.from("categorias_gasto").update({ activa: !c.activa }).eq("id", c.id),
              )
            }
          />
        ))}
        {categorias.length === 0 && (
          <p className="py-4 text-center text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            Todavía no hay ninguna categoría.
          </p>
        )}
      </div>

      <div className="flex justify-end pt-4">
        <BotonSecundario onClick={onCerrar}>Listo</BotonSecundario>
      </div>
    </Modal>
  );
}

/** Anular no borra: deja el gasto tachado, con el motivo, y devuelve la plata. */
function DialogoAnular({
  gasto,
  onCerrar,
  onListo,
}: {
  gasto: Gasto;
  onCerrar: () => void;
  onListo: () => Promise<void>;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function anular(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    const { error: err } = await supa.rpc("anular_gasto", {
      p_gasto_id: gasto.id,
      p_motivo: motivo,
    });
    if (err) {
      setError(err.message);
      setEnviando(false);
      return;
    }
    await onListo();
  }

  return (
    <Modal titulo="Anular gasto" onCerrar={onCerrar}>
      <form onSubmit={(e) => void anular(e)}>
        <Alerta tono="warning">
          {gasto.detalle} · {formatARS(Number(gasto.monto))}
          {gasto.paga_caja
            ? ". Como se había pagado de la caja, la plata vuelve al cajón con un movimiento nuevo, y para eso la caja tiene que estar abierta."
            : ". No se había pagado de la caja, así que no se mueve plata."}
        </Alerta>
        <label className="mt-3 block text-[12px]">
          Por qué se anula
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Se cargó dos veces"
            className={inputCls}
            style={inputStyle}
            autoFocus
            required
          />
        </label>
        {error && (
          <div className="mt-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando} disabled={!motivo.trim()}>
            Anular
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}
