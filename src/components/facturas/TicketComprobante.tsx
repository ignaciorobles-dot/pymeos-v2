import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { urlDelQr, type ParaQr } from "@/lib/comprobante-qr";
import { formatARS } from "@/lib/format";
import { labelCondicion } from "@/lib/fiscal";

/**
 * El comprobante como se imprime y se le da al cliente.
 *
 * Se dibuja siempre pero no se ve: vive en un portal colgado del `body` y la
 * hoja de estilos lo muestra solo al imprimir. Asi el boton "Imprimir" no tiene
 * que abrir ventanas nuevas (que los navegadores bloquean) ni pelear con el
 * diseño del panel.
 *
 * Dos cosas que no son de diseño sino de la ley:
 *
 *   El QR es obligatorio (RG 4892). Sin el, el comprobante impreso esta
 *   incompleto. Va como imagen porque un QR dibujado con letras no lo lee
 *   ningun telefono.
 *
 *   El IVA se discrimina en la A y no en la B ni en la C. En la B el IVA esta
 *   adentro del precio y mostrarlo aparte induce a error: el que compra podria
 *   creer que puede computarlo, y no puede.
 */

const NOMBRE_TIPO: Record<string, string> = {
  A: "FACTURA A",
  B: "FACTURA B",
  C: "FACTURA C",
  NCA: "NOTA DE CRÉDITO A",
  NCB: "NOTA DE CRÉDITO B",
  NCC: "NOTA DE CRÉDITO C",
};

/** El codigo que ARCA pide que figure junto a la letra. */
const CODIGO_ARCA: Record<string, string> = {
  A: "01",
  B: "06",
  C: "11",
  NCA: "03",
  NCB: "08",
  NCC: "13",
};

export type ComprobanteImprimible = ParaQr & {
  emisor_nombre: string;
  emisor_condicion_iva: string;
  emisor_direccion: string | null;
  receptor_nombre: string;
  receptor_condicion_iva: string;
  neto: number;
  iva: number;
  cae_vencimiento: string | null;
};

export type LineaImprimible = {
  id: string;
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
};

const fechaCorta = (iso: string) => {
  const [a, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
};

const cuitLindo = (cuit: string) => {
  const n = cuit.replace(/\D/g, "");
  return n.length === 11 ? `${n.slice(0, 2)}-${n.slice(2, 10)}-${n.slice(10)}` : cuit;
};

export function TicketComprobante({
  comprobante,
  lineas,
}: {
  comprobante: ComprobanteImprimible;
  lineas: LineaImprimible[];
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [montado, setMontado] = useState(false);

  // El portal necesita `document`, que del lado del servidor no existe.
  useEffect(() => setMontado(true), []);

  useEffect(() => {
    const url = urlDelQr(comprobante);
    if (!url) {
      setQr(null);
      return;
    }
    let vivo = true;
    // Margen chico y contraste alto: esto se imprime en papel termico, que
    // desvanece rapido y perdona poco.
    QRCode.toDataURL(url, { margin: 1, width: 220, errorCorrectionLevel: "M" })
      .then((d) => vivo && setQr(d))
      .catch(() => vivo && setQr(null));
    return () => {
      vivo = false;
    };
  }, [comprobante]);

  if (!montado) return null;

  const letra = comprobante.tipo.replace("NC", "");
  const discrimina = letra === "A";
  const numero =
    comprobante.numero === null
      ? "— sin número —"
      : `${String(comprobante.punto_venta).padStart(5, "0")}-${String(comprobante.numero).padStart(8, "0")}`;

  return createPortal(
    <div id="ticket-imprimible">
      <div className="tk-encabezado">
        <div className="tk-emisor">{comprobante.emisor_nombre}</div>
        {comprobante.emisor_direccion && <div>{comprobante.emisor_direccion}</div>}
        <div>CUIT {cuitLindo(comprobante.emisor_cuit)}</div>
        <div>{labelCondicion(comprobante.emisor_condicion_iva)}</div>
      </div>

      {!comprobante.cae ? (
        <div className="tk-tipo">
          <div className="tk-titulo">
            TICKET INTERNO
            <br />
            NO VÁLIDO COMO FACTURA
          </div>
        </div>
      ) : (
        <div className="tk-tipo">
          <div className="tk-letra">{letra}</div>
          <div>
            <div className="tk-titulo">{NOMBRE_TIPO[comprobante.tipo] ?? comprobante.tipo}</div>
            <div className="tk-cod">Cód. {CODIGO_ARCA[comprobante.tipo] ?? "—"}</div>
          </div>
        </div>
      )}

      <div className="tk-linea" />

      <div>
        <div>
          <b>N° {numero}</b>
        </div>
        <div>Fecha: {fechaCorta(comprobante.fecha)}</div>
      </div>

      <div className="tk-linea" />

      <div>
        <div>{comprobante.receptor_nombre}</div>
        {comprobante.receptor_documento && (
          <div>
            {comprobante.receptor_tipo_documento} {comprobante.receptor_documento}
          </div>
        )}
        <div>{labelCondicion(comprobante.receptor_condicion_iva)}</div>
      </div>

      <div className="tk-linea" />

      <table className="tk-items">
        <tbody>
          {lineas.map((l) => (
            <tr key={l.id}>
              <td>
                {l.descripcion}
                <div className="tk-detalle">
                  {l.cantidad} x {formatARS(l.precio_unitario)}
                </div>
              </td>
              <td className="tk-derecha">{formatARS(l.subtotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="tk-linea" />

      {/* El IVA se discrimina solo en la A. En la B y la C va adentro del
          precio, y sacarlo afuera haria creer que se puede computar. */}
      {discrimina && (
        <>
          <div className="tk-fila">
            <span>Neto gravado</span>
            <span>{formatARS(comprobante.neto)}</span>
          </div>
          <div className="tk-fila">
            <span>IVA</span>
            <span>{formatARS(comprobante.iva)}</span>
          </div>
        </>
      )}
      <div className="tk-fila tk-total">
        <span>TOTAL</span>
        <span>{formatARS(comprobante.total)}</span>
      </div>

      <div className="tk-linea" />

      {comprobante.cae ? (
        <div className="tk-pie">
          <div>CAE {comprobante.cae}</div>
          {comprobante.cae_vencimiento && <div>Vto. {fechaCorta(comprobante.cae_vencimiento)}</div>}
          {qr ? (
            <img className="tk-qr" src={qr} alt="Código QR de verificación de ARCA" />
          ) : (
            <div className="tk-aviso">No se pudo armar el QR de verificación.</div>
          )}
        </div>
      ) : (
        // Imprimir un comprobante sin CAE es imprimir un papel que no vale.
        // Que lo diga, para que nadie se lo entregue a un cliente pensando que
        // es una factura.
        <div className="tk-aviso">
          SIN CAE — este comprobante todavía no fue autorizado por ARCA y no tiene validez fiscal.
        </div>
      )}
    </div>,
    document.body,
  );
}
