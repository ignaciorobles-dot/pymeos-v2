import { useEffect, useState } from "react";
import {
  Alerta,
  BotonPrimario,
  BotonSecundario,
  Modal,
  inputCls,
  inputStyle,
} from "@/components/ui-bits/Modal";
import { supa } from "@/lib/supabase";

/**
 * Editar un producto del catálogo.
 *
 * El precio y el costo se editan tranquilos: la venta congela los suyos al
 * cobrar (`venta_lineas.precio_unitario` y `costo_unitario`), así que corregir
 * el precio de hoy no toca la ganancia de ninguna venta vieja.
 *
 * Borrar y descatalogar no son lo mismo, y la diferencia es la que decidió el
 * sistema desde el principio:
 *
 *   Descatalogar saca el producto del mostrador y deja el historial en pie. Es
 *   lo que corresponde para un producto que se dejó de vender.
 *
 *   Borrar lo hace desaparecer, y solo se puede si nunca se usó. Es para el que
 *   se cargó mal hace cinco minutos: eso no es historia, es basura, y dejarlo
 *   descatalogado para siempre ensucia el catálogo.
 *
 * Quién puede borrar y quién no lo decide `borrar_producto` en la base, no esta
 * pantalla. Acá solo se pregunta antes para mostrar el botón correcto en vez de
 * ofrecerlo y fallar después.
 */

type Variante = {
  id: string;
  talle: string | null;
  color: string | null;
  precio: number;
  costo: number | null;
};

type Producto = {
  id: string;
  nombre: string;
  marca: string | null;
  activo: boolean;
  variantes: Variante[];
};

export function DialogoEditarProducto({
  producto,
  onCerrar,
  onListo,
}: {
  producto: Producto;
  onCerrar: () => void;
  onListo: (mensaje: string) => void;
}) {
  const [nombre, setNombre] = useState(producto.nombre);
  const [marca, setMarca] = useState(producto.marca ?? "");
  const [activo, setActivo] = useState(producto.activo);
  const [precios, setPrecios] = useState<Record<string, string>>(() =>
    Object.fromEntries(producto.variantes.map((v) => [v.id, String(v.precio)])),
  );
  const [costos, setCostos] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      producto.variantes.map((v) => [v.id, v.costo === null ? "" : String(v.costo)]),
    ),
  );

  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [enUso, setEnUso] = useState<boolean | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [borrando, setBorrando] = useState(false);

  useEffect(() => {
    let vivo = true;
    void supa.rpc("producto_en_uso", { p_producto_id: producto.id }).then(({ data, error: err }) => {
      // Ante la duda, se asume que está en uso: ofrecer borrar de más es peor
      // que ofrecer de menos.
      if (vivo) setEnUso(err ? true : Boolean(data));
    });
    return () => {
      vivo = false;
    };
  }, [producto.id]);

  const aNumero = (texto: string) => Number(String(texto).replace(",", "."));

  async function guardar(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);

    if (!nombre.trim()) {
      setError("El producto necesita un nombre.");
      return;
    }
    for (const v of producto.variantes) {
      const p = aNumero(precios[v.id] ?? "");
      if (!Number.isFinite(p) || p < 0) {
        setError(`El precio del talle ${v.talle ?? "único"} no es un número válido.`);
        return;
      }
    }

    setGuardando(true);

    const { error: errProd } = await supa
      .from("productos")
      .update({ nombre: nombre.trim(), marca: marca.trim() || null, activo })
      .eq("id", producto.id);

    if (errProd) {
      setError(errProd.message);
      setGuardando(false);
      return;
    }

    // Una por una y no en lote: son pocas, y así el error dice cuál falló.
    for (const v of producto.variantes) {
      const costoTexto = String(costos[v.id] ?? "").trim();
      const { error: errVar } = await supa
        .from("variantes")
        .update({
          precio: aNumero(precios[v.id] ?? ""),
          costo: costoTexto === "" ? null : aNumero(costoTexto),
        })
        .eq("id", v.id);

      if (errVar) {
        setError(`No se pudo guardar el talle ${v.talle ?? "único"}: ${errVar.message}`);
        setGuardando(false);
        return;
      }
    }

    setGuardando(false);
    onListo(`"${nombre.trim()}" quedó actualizado.`);
  }

  async function borrar() {
    setBorrando(true);
    setError(null);
    const { error: err } = await supa.rpc("borrar_producto", { p_producto_id: producto.id });
    setBorrando(false);
    if (err) {
      // El mensaje viene de la base y ya explica qué hacer.
      setError(err.message);
      setConfirmando(false);
      return;
    }
    onListo(`"${producto.nombre}" se borró del catálogo.`);
  }

  return (
    <Modal titulo={`Editar ${producto.nombre}`} ancho="max-w-2xl" onCerrar={onCerrar}>
      <form onSubmit={guardar} className="space-y-3 text-[13px]">
        {error && <Alerta tono="danger">{error}</Alerta>}

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            Nombre
            <input
              autoFocus
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              className={inputCls}
              style={inputStyle}
            />
          </label>
          <label className="block">
            Marca
            <input
              value={marca}
              onChange={(e) => setMarca(e.target.value)}
              className={inputCls}
              style={inputStyle}
            />
          </label>
        </div>

        <div className="overflow-hidden rounded-md border" style={{ borderColor: "var(--border)" }}>
          <table className="w-full text-[13px]">
            <thead style={{ background: "#f9fafc" }}>
              <tr style={{ color: "var(--muted-foreground)" }}>
                <th className="px-3 py-2 text-left font-medium">Talle y color</th>
                <th className="px-3 py-2 text-right font-medium">Costo</th>
                <th className="px-3 py-2 text-right font-medium">Precio</th>
              </tr>
            </thead>
            <tbody>
              {producto.variantes.map((v) => (
                <tr key={v.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="px-3 py-1.5">
                    {v.talle ?? "único"} {v.color ?? ""}
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      value={costos[v.id] ?? ""}
                      onChange={(e) => setCostos((c) => ({ ...c, [v.id]: e.target.value }))}
                      inputMode="decimal"
                      placeholder="—"
                      className="h-8 w-full rounded-md border px-2 text-right tabular outline-none"
                      style={inputStyle}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      value={precios[v.id] ?? ""}
                      onChange={(e) => setPrecios((p) => ({ ...p, [v.id]: e.target.value }))}
                      inputMode="decimal"
                      className="h-8 w-full rounded-md border px-2 text-right tabular outline-none"
                      style={inputStyle}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={activo}
            onChange={(e) => setActivo(e.target.checked)}
          />
          <span>
            En venta
            <span className="ml-1" style={{ color: "var(--muted-foreground)" }}>
              — destildado sale del mostrador, y el historial queda intacto
            </span>
          </span>
        </label>

        <div className="flex items-end justify-between gap-3 pt-1">
          {/* Borrar vive lejos de Guardar, sin color de acción y con un paso de
              confirmación: es lo último que alguien quiere apretar sin querer. */}
          <div>
            {enUso === false && !confirmando && (
              <button
                type="button"
                onClick={() => setConfirmando(true)}
                className="rounded-md border px-3 py-1.5 text-[13px]"
                style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
              >
                Borrar del catálogo
              </button>
            )}

            {enUso === false && confirmando && (
              <div className="flex items-center gap-2">
                <span style={{ color: "var(--danger)" }}>¿Seguro? No se puede deshacer.</span>
                <button
                  type="button"
                  onClick={() => void borrar()}
                  disabled={borrando}
                  className="rounded-md px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
                  style={{ background: "var(--danger)" }}
                >
                  {borrando ? "Borrando…" : "Sí, borrar"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmando(false)}
                  style={{ color: "var(--muted-foreground)" }}
                >
                  Cancelar
                </button>
              </div>
            )}

            {enUso === true && (
              <span style={{ color: "var(--muted-foreground)" }}>
                Ya se vendió o se contó: este no se borra, se descataloga.
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
            <BotonPrimario enviando={guardando}>Guardar</BotonPrimario>
          </div>
        </div>
      </form>
    </Modal>
  );
}
