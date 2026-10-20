import { useState } from "react";
import { Check, Loader2, Pencil, Plus, X } from "lucide-react";
import { inputStyle } from "@/components/ui-bits/Modal";

/**
 * Las piezas de una lista que edita el dueño: una fila que se renombra en el
 * lugar y se apaga, y el campo de alta de arriba.
 *
 * Nacieron en `catalogo/ListasCatalogo.tsx` (categorías, talles, colores); se
 * sacaron acá cuando las categorías de gasto necesitaron lo mismo. Son todas
 * listas del mismo tipo: cortas, editables por el dueño, y donde nada se borra
 * porque lo viejo sigue nombrado en los movimientos de antes.
 */
export type Ejecutar = (
  accion: () => PromiseLike<{ error: { message: string } | null }>,
) => Promise<boolean>;

/** Una fila de la lista: se renombra en el lugar y se apaga, no se borra. */
export function Fila({
  nombre,
  activo,
  detalle,
  ocupado,
  onRenombrar,
  onAlternar,
}: {
  nombre: string;
  activo: boolean;
  detalle?: string;
  ocupado: boolean;
  onRenombrar: (nuevo: string) => Promise<boolean>;
  onAlternar: () => void;
}) {
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState(nombre);

  async function confirmar() {
    const limpio = texto.trim();
    if (!limpio || limpio === nombre) {
      setEditando(false);
      setTexto(nombre);
      return;
    }
    if (await onRenombrar(limpio)) setEditando(false);
  }

  return (
    <div
      className="flex items-center gap-2 py-1.5"
      style={{ borderTop: "1px solid var(--border)", opacity: activo ? 1 : 0.45 }}
    >
      {editando ? (
        <>
          <input
            autoFocus
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void confirmar();
              }
              if (e.key === "Escape") {
                setEditando(false);
                setTexto(nombre);
              }
            }}
            className="h-8 flex-1 rounded-md border px-2 text-[13px] outline-none"
            style={inputStyle}
          />
          <button type="button" onClick={() => void confirmar()} aria-label="Guardar">
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={() => {
              setEditando(false);
              setTexto(nombre);
            }}
            aria-label="Cancelar"
          >
            <X size={15} />
          </button>
        </>
      ) : (
        <>
          <span className="flex-1 text-[13px]">
            {nombre}
            {detalle && (
              <span className="ml-2 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                {detalle}
              </span>
            )}
          </span>
          <button type="button" onClick={() => setEditando(true)} aria-label="Renombrar">
            <Pencil size={13} />
          </button>
          <button
            type="button"
            disabled={ocupado}
            onClick={onAlternar}
            className="rounded-md border px-2 py-0.5 text-[11px]"
            style={inputStyle}
          >
            {activo ? "Desactivar" : "Activar"}
          </button>
        </>
      )}
    </div>
  );
}

/** El campo de alta que comparten los tres paneles. */
export function Agregar({
  placeholder,
  ocupado,
  onAgregar,
  children,
}: {
  placeholder: string;
  ocupado: boolean;
  onAgregar: (nombre: string) => Promise<boolean>;
  children?: React.ReactNode;
}) {
  const [texto, setTexto] = useState("");

  async function enviar(ev: React.FormEvent) {
    ev.preventDefault();
    const limpio = texto.trim();
    if (!limpio) return;
    if (await onAgregar(limpio)) setTexto("");
  }

  return (
    <form onSubmit={enviar} className="flex items-end gap-2">
      <input
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        placeholder={placeholder}
        className="h-9 flex-1 rounded-md border px-2.5 text-[13px] outline-none"
        style={inputStyle}
      />
      {children}
      <button
        type="submit"
        disabled={ocupado || !texto.trim()}
        className="flex h-9 items-center gap-1 rounded-md px-3 text-[13px] font-medium text-white disabled:opacity-50"
        style={{ background: "var(--primary)" }}
      >
        {ocupado ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Agregar
      </button>
    </form>
  );
}

