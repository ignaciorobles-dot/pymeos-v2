# Contrato de datos — Ventas, pagos y cuenta corriente (P3)

Documento de acuerdo. **No se escribe la pantalla hasta que esto esté aprobado.**
Esta es la fase más cara de corregir después: cuando haya mil ventas cargadas,
cambiar la forma de una tabla significa migrar plata ya cobrada.

## Las cuatro decisiones del negocio (2026-08-03)

1. **Se fía.** Hay clientes que se llevan mercadería y pagan después.
2. **Los cambios son por otro talle o producto**, no devolución de dinero.
3. **No hay comisiones** por vendedor.
4. **El descuento va sobre el total** de la venta, no por producto.

## La decisión de fondo: un cambio es UNA venta, no dos

Es tentador resolver el cambio de talle como "anulo la venta vieja y hago una
nueva". Está mal por tres razones: la venta original **existió** y no se puede
borrar de la historia, el vendedor tendría que volver a cobrar todo en vez de
cobrar la diferencia, y la caja del día quedaría inflada con una venta que se
hizo dos veces.

Entonces: **una línea de venta puede tener cantidad negativa.**

```
Cambio de talle, el cliente trae el 40 y se lleva el 41 que sale más caro:

  + 1 × Nike Revolution 41 negro    $ 52.000
  − 1 × Nike Revolution 40 negro   −$ 48.000
  ─────────────────────────────────────────
  Total a cobrar                    $  4.000
```

Un solo comprobante, que se lee como lo que pasó. El stock se acomoda solo en
las dos direcciones. Si el par nuevo sale más barato, el total da negativo y el
sistema entiende que **sale** plata de la caja en vez de entrar.

Consecuencia: `cantidad` lleva `check (cantidad <> 0)`, no `> 0`. Positivo es
mercadería que sale del local, negativo es mercadería que vuelve.

## Las tablas

### `clientes` — sólo hacen falta porque se fía.
| campo | tipo | para qué |
|---|---|---|
| `id` | uuid PK | |
| `nombre` | text NOT NULL | |
| `telefono` | text | cómo se lo ubica cuando debe |
| `documento` | text | DNI o CUIT, para cuando haya factura |
| `email`, `direccion`, `notas` | text | |
| `saldo` | numeric(12,2) NOT NULL default 0 | **lo calcula la base, nadie lo escribe** |
| `activo` | bool NOT NULL default true | |

`saldo` positivo = el cliente debe. Negativo = tiene saldo a favor (pagó de más
o devolvió algo ya pagado).

**`saldo` no se edita desde la app.** Igual que el stock: se registra un
movimiento y el saldo se acomoda solo. El permiso de UPDATE sobre esa columna no
existe para nadie. Un saldo que alguien puede tipear es un saldo que no sirve
para discutir con un cliente.

### `movimientos_cuenta` — el libro mayor de lo que se debe.
| campo | tipo | para qué |
|---|---|---|
| `id` | uuid PK | |
| `cliente_id` | uuid NOT NULL → clientes | |
| `sucursal_id` | uuid NOT NULL → sucursales | dónde se fió y dónde se cobró |
| `tipo` | text | `venta`, `pago`, `ajuste` |
| `monto` | numeric(12,2) NOT NULL check (<> 0) | **con signo**: + suma deuda, − la baja |
| `venta_id` | uuid → ventas | de qué venta salió la deuda |
| `usuario_id` | uuid NOT NULL → usuarios | quién lo registró |
| `nota` | text | |
| `created_at` | timestamptz | |

Inmutable, como los movimientos de stock. Un error se corrige con un `ajuste`
que queda a la vista, nunca borrando la fila. Es exactamente la diferencia entre
un saldo que se puede defender y uno que no.

### `medios_pago` — configurables, no escritos en el código.
| campo | tipo | para qué |
|---|---|---|
| `id` | uuid PK | |
| `nombre` | text NOT NULL | "Efectivo", "Débito", "Crédito 3 cuotas" |
| `recargo_porcentaje` | numeric(5,2) NOT NULL default 0 | el famoso 10% de la tarjeta |
| `es_cuenta_corriente` | bool NOT NULL default false | el medio "Fiado" |
| `afecta_caja` | bool NOT NULL default true | efectivo sí; transferencia no toca el cajón |
| `activo`, `orden` | | para la pantalla |

**El recargo se configura, no se hardcodea.** Cuando la tarjeta pase del 10 al
12, se cambia en una pantalla y no hay que tocar código ni redeployar.

### `ventas` — la cabecera.
| campo | tipo | para qué |
|---|---|---|
| `id` | uuid PK | |
| `numero` | bigint NOT NULL | correlativo **por sucursal**, arranca en 1 |
| `sucursal_id` | uuid NOT NULL | la del equipo, siempre |
| `usuario_id` | uuid NOT NULL | quién vendió (auditoría, no comisión) |
| `cliente_id` | uuid → clientes | obligatorio sólo si se fía |
| `estado` | text | `completada`, `anulada` |
| `subtotal` | numeric(12,2) | suma de las líneas, con signo |
| `descuento` | numeric(12,2) default 0 | sobre el total |
| `recargo` | numeric(12,2) default 0 | suma de los recargos de los pagos |
| `total` | numeric(12,2) | subtotal − descuento + recargo |
| `venta_origen_id` | uuid → ventas | si es un cambio, de qué venta viene |
| `anulada_at`, `anulada_por`, `motivo_anulacion` | | |
| `created_at` | timestamptz | |

Único `(sucursal_id, numero)`. El número lo asigna la base tomando un lock, no
la app: dos vendedores cobrando al mismo tiempo en el mismo local no pueden
sacar el mismo número de ticket.

### `venta_lineas` — lo que realmente se vendió.
| campo | tipo | para qué |
|---|---|---|
| `id` | uuid PK | |
| `venta_id` | uuid NOT NULL → ventas | |
| `variante_id` | uuid NOT NULL → variantes | nunca un producto: hay que saber el talle |
| `cantidad` | int NOT NULL check (<> 0) | negativo = vuelve al local (cambio) |
| `precio_unitario` | numeric(12,2) NOT NULL | congelado |
| `costo_unitario` | numeric(12,2) | **congelado**, ver abajo |
| `subtotal` | numeric generated | `cantidad × precio_unitario` |

### `pagos` — con qué se pagó.
| campo | tipo |
|---|---|
| `id` | uuid PK |
| `venta_id` | uuid NOT NULL → ventas |
| `medio_pago_id` | uuid NOT NULL → medios_pago |
| `monto` | numeric(12,2) NOT NULL check (<> 0) |
| `recargo` | numeric(12,2) NOT NULL default 0 |

Tabla aparte y no una columna en `ventas` porque **se paga mitad y mitad**:
$30.000 en efectivo y el resto con débito es lo más normal del mundo. Con una
columna, eso no entra. Monto negativo = plata que sale (vuelto de un cambio).

## El costo congelado (criterio 8 del contrato de catálogo)

`venta_lineas.costo_unitario` se copia de `variantes.costo` **en el momento de
vender** y no se vuelve a mirar nunca.

Si la ganancia se calculara leyendo `variantes.costo`, el día que el proveedor
aumenta y se actualiza el costo **cambiaría la ganancia de todas las ventas del
pasado**: meses ya cerrados se moverían solos. Con el costo congelado, lo que
pasó queda como pasó.

Esto es lo que permite mostrar ganancia real y costo de mercadería vendida, que
es lo que le faltaba al sistema viejo.

## Reglas que van en la base, no en la pantalla

- La venta se guarda **siempre en la sucursal del equipo**. Nunca en la del
  `usuarios.sucursal_id` de quien la hace: el que reemplaza un día en el otro
  local tiene que poder vender ahí.
- **Una venta nunca se borra.** Se anula, y la anulación devuelve el stock y
  revierte la cuenta corriente con movimientos nuevos, no borrando los viejos.
- **Los pagos tienen que sumar el total.** Una venta guardada a la que le falta
  plata es una venta que nadie va a poder cuadrar a fin de mes.
- **Si hay un pago con medio de cuenta corriente, `cliente_id` es obligatorio.**
  Fiarle a nadie es perder la mercadería.
- El stock se mueve por `movimientos_stock` con motivo `venta` o `devolucion` y
  `referencia_id` apuntando a la venta. **Nunca escribiendo la tabla `stock`.**
- Vender más de lo que hay **no frena la venta**: deja el stock en negativo y lo
  marca, como ya se decidió en el contrato de catálogo.

## Criterios de aceptación

1. Vender 2 pares descuenta 2 del stock **de la sucursal del equipo**, y deja
   dos filas en `movimientos_stock` con motivo `venta` apuntando a la venta.
2. Una venta pagada mitad efectivo mitad débito guarda dos filas en `pagos`, y
   la suma de los pagos es igual al total.
3. Guardar una venta cuyos pagos no suman el total: la base la rechaza.
4. Un cambio de talle con diferencia a favor del local genera **una** venta con
   una línea positiva y una negativa, total positivo, y el stock se mueve en las
   dos direcciones.
5. Un cambio donde el par nuevo es más barato da total negativo y registra un
   pago negativo: sale plata de la caja.
6. Fiar sin elegir cliente: la base lo rechaza.
7. Fiar $50.000 deja `clientes.saldo` en 50.000 y una fila en
   `movimientos_cuenta`. Cobrarle $20.000 lo deja en 30.000.
8. Nadie puede escribir `clientes.saldo` directamente, ni siquiera llamando a la
   base sin pasar por la pantalla.
9. Anular una venta devuelve el stock, revierte la deuda si había, y la venta
   queda visible como anulada — no desaparece.
10. Dos ventas simultáneas en la misma sucursal no pueden sacar el mismo número.
11. Cambiar el costo de una variante no modifica la ganancia de ninguna venta ya
    registrada.
12. Un vendedor puede vender, pero **no** puede anular una venta ni editar los
    medios de pago.

Los cuatro siguientes no estaban en la lista original. Aparecieron probando el
criterio 13, y son el agujero más caro de los que tenía la primera versión:
sin ellos se podía "devolver" mercadería que nunca se compró y llevarse la
diferencia en efectivo.

13. Recibir un producto que **no figura** en el ticket original: se rechaza.
14. El recargo del medio de pago sale de la tabla, no del código.
15. Devolver 3 pares contra un ticket donde salió 1: se rechaza.
16. Devolver dos veces el mismo par contra el mismo ticket: se rechaza.

## Lo que quedó construido

Migraciones: `ventas_tablas`,
`ventas_saldo_e_inmutabilidad`, `ventas_registrar_venta`,
`ventas_anular_y_cobrar_cuenta`, `ventas_rls_y_permisos`,
`ventas_medios_pago_iniciales`, `ventas_total_cuadra_al_cerrar`,
`ventas_no_devolver_mas_de_lo_vendido`.

**Una venta se guarda con una sola llamada, o no se guarda.** No se arma con
siete inserts desde el navegador: si se pudiera armar por partes existiría la
venta a la que le faltan los pagos, o la que descontó stock y no quedó
guardada. Las tablas `ventas`, `venta_lineas`, `pagos` y `movimientos_cuenta`
**no tienen permiso de escritura para nadie**. La única puerta son tres
funciones:

| función | quién | qué hace |
|---|---|---|
| `registrar_venta(...)` | cualquier usuario activo | la venta entera: líneas, stock, pagos, deuda |
| `anular_venta(venta, motivo)` | sólo `dueno` | revierte stock y deuda, deja la venta visible como anulada |
| `registrar_pago_cuenta(...)` | cualquier usuario activo | cobra a cuenta corriente |
| `ajustar_cuenta(...)` | sólo `dueno`, con nota obligatoria | corrige un saldo dejando rastro |

**El precio no lo manda el navegador.** En una línea positiva, precio y costo
salen de `variantes`. En una negativa, salen del ticket original. Como el
descuento va sobre el total, el navegador no tiene ninguna razón legítima para
mandar un precio unitario — y así desaparece toda una familia de fraudes.

**El número de ticket se toma bajo `pg_advisory_xact_lock` por sucursal**, no
con una secuencia: tiene que ser correlativo y sin huecos dentro de cada local.

Detalle de implementación que costó una vuelta: `total = subtotal − descuento +
recargo` no puede ser un `CHECK`, porque la venta se arma en pasos y el
invariante no se cumple en el medio. Postgres no deja diferir un `CHECK`, así
que es un `constraint trigger ... deferrable initially deferred`: se verifica al
cerrar la transacción, no en cada paso.

**Verificado**: los 16 criterios corren contra la base real dentro de una
transacción que se revierte. Después de la corrida: 0 ventas, 0 productos,
0 movimientos. No queda una sola fila de prueba.

## Lo que NO entra en P3

- Facturación fiscal real (ARCA). La venta guarda lo que hace falta para
  facturar después, pero no se emite nada. Ya está decidido: no se emiten
  comprobantes fiscales hasta integrar un proveedor.
- Caja y arqueo diario: es P4. `medios_pago.afecta_caja` ya está previsto para
  que P4 no tenga que migrar nada.
- Comisiones: el negocio no las paga.
- Devolución de dinero contra una venta vieja sin llevarse otra cosa. Hoy el
  negocio hace cambios. Si mañana devuelve plata, el modelo ya lo soporta (una
  venta con una sola línea negativa) y sólo hace falta la pantalla.
