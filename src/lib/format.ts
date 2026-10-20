export function formatARS(n: number): string {
  const fixed = Math.round(n).toLocaleString("es-AR");
  return `$ ${fixed}`;
}

export function formatNum(n: number): string {
  return n.toLocaleString("es-AR");
}
