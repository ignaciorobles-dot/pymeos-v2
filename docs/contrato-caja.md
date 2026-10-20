# Contrato de datos — Caja

Qué es la caja acá: **el cajón de plata física de una sucursal**. No es "el
resumen del día" ni "cuánto vendimos". Es cuánta plata hay adentro del cajón, y
por qué.

Decisión del negocio, ya tomada y no se vuelve a discutir:

1. **Apertura y cierre con arqueo.** A la mañana se abre poniendo cuánto
   efectivo hay. A la noche se cuenta la plata y se cierra. El sistema muestra
   cuánto *debería* haber, cuánto hay de verdad, y guarda la diferencia con el
   nombre de quien cerró.
2. **Solo el efectivo entra a la caja.** Tarjeta, transferencia y Mercado Pago
   se registran en la venta, pero no tocan el cajón. Eso ya estaba en la base:
   cada medio de pago tiene una marca `afecta_caja`. La caja lee esa marca; no
   hay una lista de medios escrita en el código.

## Tablas

### `turnos_caja` — un turno = de la apertura al cierre

| Columna | Para qué |
|---|---|
| `sucursal_id` | De qué cajón hablamos. Sale del equipo, nunca se elige. |
| `numero` | Correlativo **por sucursal**. Centro #1 y Norte #1 conviven. |
| `monto_apertura` | Lo que había en el cajón al abrir. |
| `abierto_por`, `abierto_at` | Quién abrió y cuándo. |
| `estado` | `abierto` / `cerrado`. |
| `monto_contado` | Lo que se contó al cerrar. |
| `monto_esperado` | Lo que el sistema decía que tenía que haber. Se congela al cerrar. |
| `diferencia` | `contado − esperado`. Negativo = falta plata. |
| `cerrado_por`, `cerrado_at`, `nota_cierre` | Quién cerró, cuándo y la explicación. |

Un índice único parcial impide **dos turnos abiertos en la misma sucursal**.
No hay forma de tener dos cajas abiertas en el mismo local, ni por error ni por
dos personas apretando el botón al mismo tiempo.

### `movimientos_caja` — la plata que entra o sale a mano

Ingresos y retiros que no son una venta: un vuelto que se repone, plata que el
dueño se lleva al banco, la devolución de una venta anulada.

| Columna | Para qué |
|---|---|
| `turno_id`, `sucursal_id` | A qué turno pertenece. |
| `tipo` | `ingreso` (positivo), `retiro` (negativo), `anulacion` (negativo, la escribe el sistema). |
| `monto` | Con signo. Un check obliga a que el signo coincida con el tipo. |
| `motivo` | Obligatorio. Un movimiento sin motivo no se puede explicar después. |
| `usuario_id`, `created_at` | Quién y cuándo. |
| `referencia_id` | La venta anulada, cuando corresponde. |

**Son inmutables**: un trigger rechaza `update` y `delete`. Un error se corrige
con otro movimiento, no borrando el anterior.

## El saldo no se guarda: se calcula

`saldo_esperado_caja(turno_id)` suma, cada vez que se pregunta:

```
monto_apertura
+ pagos de ventas con medio afecta_caja, en la ventana del turno
+ cobros de cuenta corriente con medio afecta_caja, en la ventana del turno
+ movimientos_caja del turno (ingresos suman, retiros restan)
```

La ventana es por tiempo: `abierto_at <= created_at < cerrado_at (o ahora)`,
sobre la misma sucursal. Una columna con el saldo se desincroniza el día que
alguien inserte una fila por afuera; una suma, no.

`movimientos_del_turno(turno_id)` devuelve esa misma plata como lista, para la
pantalla. Sale de las mismas fuentes: **la lista y el número grande no se pueden
contradecir**.

## Las cuatro operaciones

| Función | Quién | Qué frena |
|---|---|---|
| `abrir_caja(sucursal, monto)` | Cualquier usuario activo | Sucursal inactiva, monto negativo, caja ya abierta. |
| `registrar_movimiento_caja(sucursal, tipo, monto, motivo)` | Ingreso: cualquiera. **Retiro: solo dueño.** | Sin caja abierta, sin motivo, monto ≤ 0, o un retiro que deje la caja en negativo. |
| `cerrar_caja(turno, contado, nota)` | Cualquier usuario activo | **Una diferencia distinta de cero sin explicación.** |
| `anular_venta(...)` | Dueño | Si la venta se cobró en efectivo y la caja está cerrada, no deja anular: esa plata hay que devolverla del cajón. |

Las tablas **no tienen permiso de insert, update ni delete para nadie**. La
única puerta son estas funciones. Ocultar un botón no es seguridad.

## La consecuencia que hay que saber

Un trigger sobre `pagos` y `movimientos_cuenta` rechaza cualquier cobro en
efectivo si la caja de esa sucursal está cerrada:

> La caja de esta sucursal está cerrada. Abrila antes de cobrar en efectivo.

Es a propósito y es la contracara de haber elegido arqueo: si la plata entra al
cajón, tiene que haber un turno donde contarla. **Abrir la caja pasa a ser lo
primero que se hace a la mañana**, antes de la primera venta. Vender con tarjeta
o transferencia sigue andando con la caja cerrada.

Está puesto como trigger y no adentro de `registrar_venta` para que valga por
cualquier camino que inserte un pago: el POS de hoy, la tienda de mañana, o una
carga manual.

## Una venta anulada no borra la plata que entró

La venta anulada sigue contando en el saldo esperado: esa plata entró de verdad.
Lo que hace `anular_venta` es escribir un movimiento `anulacion` en contra. El
cajón cuenta las dos veces, y en la lista se ven las dos: la entrada y la
devolución.
