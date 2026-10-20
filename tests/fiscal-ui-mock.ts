export const filas = Array.from({ length: 100 }, (_, i) => ({
  venta_id: `v${i}`,
  numero: i + 1,
  fecha: "2026-09-29",
  total: 121,
  cliente: `Cliente ficticio ${i + 1}`,
  comprobante_id: `c${i}`,
  estado: "pendiente",
  revision: i < 75 ? "listo" : "pendiente",
  total_filas: 100,
}));
export const enviados: string[] = [];
export const esLinkDeContrasena = false;
export const esLinkDeInvitacion = false;
export const supaVerificar = {};
export const supa = {
  auth: { getSession: async () => ({ data: { session: { access_token: "FICTICIO" } } }) },
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "ventas_pendientes_fiscales") return { data: filas, error: null };
    if (name === "vista_revision_fiscal") {
      const f = filas.find((f) => f.comprobante_id === args.p_id)!;
      return {
        data: {
          huella: "h",
          comprobante: {
            id: f.comprobante_id,
            sucursal_id: "s1",
            tipo: "B",
            fecha: f.fecha,
            receptor_nombre: f.cliente,
            receptor_condicion_iva: "consumidor_final",
            total: 121,
            neto: 100,
            iva: 21,
          },
          lineas: [{ id: "l", descripcion: "Producto ficticio", cantidad: 1, subtotal: 121 }],
        },
        error: null,
      };
    }
    if (name === "revisar_comprobante") {
      filas.find((f) => f.comprobante_id === args.p_id)!.revision = args.p_listo
        ? "listo"
        : "observado";
      return { data: null, error: null };
    }
    throw Error(`RPC no simulada: ${name}`);
  },
};
window.fetch = async (url, init) => {
  if (String(url) !== "http://127.0.0.1:5193/simulated/functions/v1/facturar")
    throw Error("Red externa bloqueada en test");
  const b = JSON.parse(String(init?.body));
  enviados.push(b.comprobante_id);
  filas.find((f) => f.comprobante_id === b.comprobante_id)!.revision = "enviado";
  return new Response(
    JSON.stringify({ comprobante_id: b.comprobante_id, estado: "pendiente", cae: null }),
    { status: 202 },
  );
};
(window as unknown as { fiscalTest: unknown }).fiscalTest = { filas, enviados };
