import { inputCls, inputStyle } from "@/components/ui-bits/Modal";
import {
  CONDICIONES_IVA,
  TIPOS_DOCUMENTO,
  requiereCuit,
  tipoComprobante,
} from "@/lib/fiscal";

export type DatosFiscales = {
  condicion_iva: string;
  tipo_documento: string;
  documento: string;
};

/**
 * Los tres campos que deciden qué comprobante le corresponde a un cliente.
 * Van juntos y en un solo componente porque se cargan juntos y porque el alta
 * rápida del mostrador y la pantalla de clientes tienen que pedir exactamente
 * lo mismo: si el POS pide menos, entra un cliente a medio cargar que después
 * no se puede facturar.
 *
 * `condicionEmisor` es la de la sucursal que vende. Sin ella no se puede saber
 * el tipo de comprobante, y se dice que falta en vez de suponerlo.
 */
export function CamposFiscales({
  datos,
  onCambio,
  condicionEmisor,
}: {
  datos: DatosFiscales;
  onCambio: (d: DatosFiscales) => void;
  condicionEmisor: string | null;
}) {
  const comprobante = tipoComprobante(condicionEmisor, datos.condicion_iva);
  const pideCuit = requiereCuit(datos.condicion_iva);

  const cambiarCondicion = (valor: string) => {
    // Al pasar a una condición que factura, el documento pasa a ser un CUIT.
    // Cambiarlo solo evita el error más común: elegir "responsable inscripto"
    // y dejar el selector en DNI sin darse cuenta.
    const tipo = requiereCuit(valor) ? "CUIT" : datos.tipo_documento;
    onCambio({ ...datos, condicion_iva: valor, tipo_documento: tipo });
  };

  return (
    <div className="space-y-3">
      <label className="block text-[12px]">
        Condición frente al IVA
        <select
          value={datos.condicion_iva}
          onChange={(e) => cambiarCondicion(e.target.value)}
          className={inputCls}
          style={inputStyle}
        >
          {CONDICIONES_IVA.map((c) => (
            <option key={c.valor} value={c.valor}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-[130px_1fr] gap-3">
        <label className="block text-[12px]">
          Documento
          <select
            value={datos.tipo_documento}
            onChange={(e) => onCambio({ ...datos, tipo_documento: e.target.value })}
            className={inputCls}
            style={inputStyle}
          >
            {TIPOS_DOCUMENTO.map((t) => (
              <option key={t.valor} value={t.valor}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[12px]">
          Número{pideCuit && <span style={{ color: "var(--danger)" }}> *</span>}
          <input
            value={datos.documento}
            onChange={(e) => onCambio({ ...datos, documento: e.target.value })}
            inputMode="numeric"
            placeholder={datos.tipo_documento === "CUIT" ? "20123456789" : ""}
            className={inputCls}
            style={inputStyle}
          />
        </label>
      </div>

      <p className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
        {comprobante
          ? `Le corresponde factura ${comprobante}.`
          : "No se puede saber el comprobante: falta cargar la condición ante ARCA de la sucursal, en Configuración."}
      </p>
    </div>
  );
}
