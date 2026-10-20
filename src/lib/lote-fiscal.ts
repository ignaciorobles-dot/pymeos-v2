/** Una respuesta aceptada no es un CAE. Nunca reintentar automáticamente un lote. */
export async function ejecutarLoteFiscal<T>(
  ids: readonly string[],
  enviar: (id: string) => Promise<T>,
  progreso: (id: string, resultado: T | Error) => void,
) {
  for (const id of new Set(ids)) {
    try {
      progreso(id, await enviar(id));
    } catch (e) {
      progreso(
        id,
        e instanceof Error ? e : new Error("Respuesta desconocida; consultar antes de repetir"),
      );
    }
  }
}
