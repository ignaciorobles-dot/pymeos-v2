import { useCallback, useEffect, useState } from "react";
import { supa } from "@/lib/supabase";
import { RUTAS_POR_ROL, useSesion, useSucursalOperativa } from "@/lib/sesion";

/**
 * Los avisos del encabezado.
 *
 * Un aviso es siempre algo que alguien tiene que ir a hacer, no una noticia:
 * la campana no cuenta ventas ni felicita. Si no hay nada pendiente, no hay
 * nada que mostrar, y eso es una buena noticia en si misma.
 *
 * Cada aviso lleva la pantalla donde se resuelve, y solo se muestra si el rol
 * de quien mira tiene acceso a esa pantalla: avisarle a un vendedor de un
 * cheque que no puede tocar es ruido.
 */
export type Aviso = {
  id: string;
  cantidad: number;
  texto: string;
  detalle: string;
  ruta: string;
  tono: "danger" | "warning" | "neutral";
};

type Conteo = { count: number | null; error: { message: string } | null };

function hoyLocal(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Argentina/Cordoba",
  });
}

function sumarDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + dias);
  return d.toLocaleDateString("en-CA");
}

export function useAvisos(): {
  avisos: Aviso[];
  total: number;
  cargando: boolean;
  recargar: () => void;
} {
  const { usuario } = useSesion();
  const sucursalOperativa = useSucursalOperativa();
  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const [cargando, setCargando] = useState(true);

  const cargar = useCallback(async () => {
    if (!usuario) return;
    const sucursalId = sucursalOperativa?.id ?? null;
    const hoy = hoyLocal();

    // Solo el conteo: la campana no necesita las filas, y traerlas seria
    // pagar por datos que nadie va a leer hasta que abra la pantalla.
    const enSucursal = (tabla: string) => {
      const q = supa.from(tabla).select("id", { count: "exact", head: true });
      return sucursalId ? q.eq("sucursal_id", sucursalId) : q;
    };

    const [comprobantes, rechazados, pedidos, envios, consultas, cheques, caja] =
      await Promise.all([
        enSucursal("comprobantes").eq("estado", "pendiente"),
        enSucursal("comprobantes").eq("estado", "rechazado"),
        enSucursal("pedidos_online").eq("estado", "pendiente"),
        enSucursal("envios").in("estado", ["pendiente", "preparando"]),
        enSucursal("consultas").in("estado", ["abierta", "en_curso"]),
        enSucursal("cheques")
          .in("estado", ["en_cartera", "emitido"])
          .lte("fecha_pago", sumarDias(hoy, 7)),
        enSucursal("turnos_caja")
          .eq("estado", "abierto")
          .lt("abierto_at", `${hoy}T00:00:00`),
      ]);

    const armados: Aviso[] = [];
    const agregar = (
      c: Conteo,
      id: string,
      ruta: string,
      tono: Aviso["tono"],
      texto: (n: number) => string,
      detalle: string,
    ) => {
      const n = c.error ? 0 : (c.count ?? 0);
      if (n > 0) armados.push({ id, cantidad: n, texto: texto(n), detalle, ruta, tono });
    };

    agregar(
      caja,
      "caja",
      "/caja",
      "danger",
      () => "La caja quedó abierta de otro día",
      "Hasta que se cierre, el arqueo mezcla dos jornadas.",
    );
    agregar(
      rechazados,
      "rechazados",
      "/facturacion",
      "danger",
      (n) => (n === 1 ? "1 comprobante rechazado" : `${n} comprobantes rechazados`),
      "ARCA no los aceptó: hay que corregirlos y volver a presentarlos.",
    );
    agregar(
      pedidos,
      "pedidos",
      "/pedidos",
      "warning",
      (n) => (n === 1 ? "1 pedido online sin confirmar" : `${n} pedidos online sin confirmar`),
      "El cliente está esperando que le digas que sí.",
    );
    agregar(
      envios,
      "envios",
      "/pedidos",
      "warning",
      (n) => (n === 1 ? "1 envío sin salir" : `${n} envíos sin salir`),
      "Preparados o pendientes, todavía no arrancaron el reparto.",
    );
    agregar(
      consultas,
      "consultas",
      "/atencion",
      "warning",
      (n) => (n === 1 ? "1 consulta sin resolver" : `${n} consultas sin resolver`),
      "Alguien escribió y todavía no tuvo respuesta.",
    );
    agregar(
      comprobantes,
      "comprobantes",
      "/facturacion",
      "neutral",
      (n) => (n === 1 ? "1 comprobante esperando el CAE" : `${n} comprobantes esperando el CAE`),
      "Están armados: falta cargar el número y el CAE de ARCA.",
    );
    agregar(
      cheques,
      "cheques",
      "/cheques",
      "neutral",
      (n) => (n === 1 ? "1 cheque vence esta semana" : `${n} cheques vencen esta semana`),
      "Depositarlos o cubrirlos antes de la fecha de pago.",
    );

    const permitidas = RUTAS_POR_ROL[usuario.rol];
    setAvisos(armados.filter((a) => permitidas.includes(a.ruta)));
    setCargando(false);
  }, [usuario, sucursalOperativa]);

  useEffect(() => {
    void cargar();
    // Un pedido online puede entrar mientras la pantalla está abierta: sin esto
    // habría que recargar a mano para enterarse.
    const t = setInterval(() => void cargar(), 90_000);
    return () => clearInterval(t);
  }, [cargar]);

  return { avisos, total: avisos.length, cargando, recargar: () => void cargar() };
}
