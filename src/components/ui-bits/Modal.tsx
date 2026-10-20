import { Loader2, X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Piezas de diálogo compartidas. Nacieron en `empleados.tsx`; se sacaron acá
 * cuando la segunda pantalla las necesitó, para que un cambio de estilo no
 * tenga que hacerse dos veces y quedar distinto en cada lugar.
 */

export const inputCls = "mt-1 h-9 w-full rounded-md border px-2.5 text-[13px] outline-none";
export const inputStyle = { borderColor: "var(--border)" } as const;

export function Modal({
  titulo,
  ancho = "max-w-md",
  onCerrar,
  children,
}: {
  titulo: string;
  ancho?: string;
  onCerrar: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4"
      style={{ background: "rgba(16, 24, 40, 0.45)" }}
      onClick={onCerrar}
    >
      <div
        className={`card-surface w-full ${ancho} p-5`}
        style={{ background: "var(--surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">{titulo}</h2>
          <button onClick={onCerrar} aria-label="Cerrar">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function BotonPrimario({
  enviando,
  disabled,
  children,
}: {
  enviando: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={enviando || disabled}
      className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
      style={{ background: "var(--primary)" }}
    >
      {enviando && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

export function BotonSecundario({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border px-3 py-1.5 text-[13px]"
      style={inputStyle}
    >
      {children}
    </button>
  );
}

export function Alerta({
  tono,
  children,
}: {
  tono: "danger" | "warning" | "info";
  children: ReactNode;
}) {
  const estilos = {
    danger: { background: "var(--danger-bg)", color: "var(--danger)" },
    warning: { background: "var(--warning-bg)", color: "var(--warning)" },
    info: { background: "#fdf3ef", color: "var(--primary)" },
  } as const;

  return (
    <div className="rounded-md px-3 py-2 text-[12px]" style={estilos[tono]}>
      {children}
    </div>
  );
}
