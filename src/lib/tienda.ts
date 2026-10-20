import { useEffect, useState } from "react";
import { supa } from "./supabase";

/**
 * Lo compartido entre el sistema y la tienda pública: cómo se arma la URL de
 * una foto y dónde vive el carrito.
 */

/**
 * La tabla guarda la ubicación dentro del bucket, no una URL. La URL se arma
 * acá: si mañana cambia el dominio de Storage, no hay que tocar la base.
 */
export function urlFoto(ruta: string): string {
  return supa.storage.from("productos").getPublicUrl(ruta).data.publicUrl;
}

export type ItemCarrito = {
  variante_id: string;
  slug: string;
  producto: string;
  talle: string | null;
  color: string | null;
  precio: number;
  cantidad: number;
  imagen: string | null;
  /** Lo que había en el local cuando se agregó: sirve para no dejar sumar de más. */
  disponible: number;
};

const CLAVE = "pymeos-carrito";
const EVENTO = "pymeos-carrito-cambio";

function leer(): ItemCarrito[] {
  if (typeof window === "undefined") return [];
  try {
    const crudo = window.localStorage.getItem(CLAVE);
    const datos = crudo ? (JSON.parse(crudo) as ItemCarrito[]) : [];
    return Array.isArray(datos) ? datos : [];
  } catch {
    // Si alguien tocó el localStorage a mano, mejor empezar de cero que romper
    // la tienda entera.
    return [];
  }
}

function escribir(items: ItemCarrito[]) {
  window.localStorage.setItem(CLAVE, JSON.stringify(items));
  window.dispatchEvent(new Event(EVENTO));
}

/**
 * El carrito vive en el navegador del comprador, no en la base: alguien que
 * mira la tienda desde Instagram no tiene cuenta ni tiene por qué dejar rastro
 * hasta que decide comprar. Recién ahí se crea el pedido.
 *
 * Arranca vacío y se llena en el efecto porque la página se arma primero en el
 * servidor, donde no existe localStorage.
 */
export function useCarrito() {
  const [items, setItems] = useState<ItemCarrito[]>([]);

  useEffect(() => {
    const sincronizar = () => setItems(leer());
    sincronizar();
    window.addEventListener(EVENTO, sincronizar);
    // Dos pestañas abiertas de la misma tienda tienen que ver lo mismo.
    window.addEventListener("storage", sincronizar);
    return () => {
      window.removeEventListener(EVENTO, sincronizar);
      window.removeEventListener("storage", sincronizar);
    };
  }, []);

  const agregar = (item: ItemCarrito) => {
    const actual = leer();
    const i = actual.findIndex((x) => x.variante_id === item.variante_id);
    if (i >= 0) {
      const suma = actual[i].cantidad + item.cantidad;
      actual[i] = { ...actual[i], cantidad: Math.min(suma, item.disponible), disponible: item.disponible };
    } else {
      actual.push({ ...item, cantidad: Math.min(item.cantidad, item.disponible) });
    }
    escribir(actual);
  };

  const cambiarCantidad = (variante_id: string, cantidad: number) => {
    const actual = leer()
      .map((x) =>
        x.variante_id === variante_id
          ? { ...x, cantidad: Math.max(0, Math.min(cantidad, x.disponible)) }
          : x,
      )
      .filter((x) => x.cantidad > 0);
    escribir(actual);
  };

  const quitar = (variante_id: string) => {
    escribir(leer().filter((x) => x.variante_id !== variante_id));
  };

  const vaciar = () => escribir([]);

  const unidades = items.reduce((a, x) => a + x.cantidad, 0);
  const subtotal = items.reduce((a, x) => a + x.precio * x.cantidad, 0);

  return { items, agregar, cambiarCantidad, quitar, vaciar, unidades, subtotal };
}
