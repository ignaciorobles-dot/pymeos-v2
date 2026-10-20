import type { ReactNode } from "react";

type Tone = "success" | "danger" | "warning" | "violet" | "neutral";

const styles: Record<Tone, { bg: string; fg: string; dot: string }> = {
  success: { bg: "#e3f6ee", fg: "#12915e", dot: "#12915e" },
  danger: { bg: "#fdecea", fg: "#d92d20", dot: "#d92d20" },
  warning: { bg: "#fef3e2", fg: "#b45309", dot: "#b45309" },
  violet: { bg: "#f1eafd", fg: "#6d3fc4", dot: "#6d3fc4" },
  neutral: { bg: "#eef1f6", fg: "#475467", dot: "#98a2b3" },
};

export function Chip({ tone = "neutral", dot = true, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  const s = styles[tone];
  return (
    <span className="chip" style={{ background: s.bg, color: s.fg }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: 999, background: s.dot }} />}
      {children}
    </span>
  );
}

export function statusTone(status: string): Tone {
  const s = status.toLowerCase();
  if (["entregado", "pagada", "emitida", "activo", "cerrado", "positivo"].includes(s)) return "success";
  if (["rechazada", "cancelado", "inactivo"].includes(s)) return "danger";
  if (["pendiente", "preparando", "pendiente de cae", "parcial", "bajo"].some((k) => s.includes(k))) return "warning";
  if (["en camino", "respondido"].includes(s)) return "violet";
  if (s === "abierto") return "warning";
  return "neutral";
}
