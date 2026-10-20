# Contrato de datos — Catálogo y stock (P2)

Documento de acuerdo. **No se escribe código de P2 hasta que esto esté aprobado.**
Cambiar esta forma más adelante, con ventas ya cargadas, es caro y riesgoso.

## La decisión de fondo

El negocio vende calzado y ropa: un mismo modelo existe en varios talles y colores,
y **cada combinación se cuenta y se vende por separado**. Un talle 38 negro puede
estar agotado mientras sobra el 44 blanco. Además, el precio puede cambiar según la
combinación.

Eso obliga a separar dos cosas que la gente suele mezclar:

- **El modelo** — "Zapatilla Nike Revolution". Es lo que el cliente pide y lo que se
  busca en el sistema. No tiene stock ni precio propio.
- **La variante** — "Nike Revolution, talle 38, negro". **Esto es lo que existe de
  verdad**: tiene precio, tiene costo, tiene código de barras y es lo único que se
  cuenta y se vende.

Regla que no se negocia: **una venta nunca apunta a un modelo, siempre a una variante.**
Si apuntara al modelo, el sistema no sabría qué talle descontar y el stock sería mentira.

## Las cuatro tablas

### `productos` — el modelo. Compartido entre sucursales.
| campo | tipo | para qué |
|---|---|---|
| `id` | uuid PK | |
| `nombre` | text NOT NULL | "Zapatilla Nike Revolution" |
| `marca` | text | para filtrar y agrupar |
| `categoria` | text | "Calzado", "Indumentaria", "Accesorios" |
| `descripcion` | text | opcional, para la tienda pública |
| `activo` | bool NOT NULL default true | se descataloga, **nunca se borra** |
| `created_at` | timestamptz | |

**Un solo catálogo para las dos sucursales.** No hay "producto de la sucursal 1".
Si el tío da de alta un modelo, existe en las dos; lo que cambia es cuánto hay de
cada una. Esto es lo que evita las dos copias del sistema.

### `variantes` — lo que se vende y se cuenta.
| campo | tipo | para qué |
|---|---|---|
| `id` | uuid PK | |
| `producto_id` | uuid NOT NULL → productos | |
| `talle` | text | text y no número: existe "38", "M", "XL", "Único" |
| `color` | text | |
| `sku` | text | código interno |
| `codigo_barras` | text UNIQUE (indexado) | **el camino principal**: lo lee la pistola |
| `precio` | numeric(12,2) NOT NULL | precio de venta **de esta combinación** |
| `costo` | numeric(12,2) | lo que costó comprarla. Sin esto no hay ganancia real |
| `activa` | bool NOT NULL default true | |

Único: `(producto_id, talle, color)` — no puede haber dos veces el mismo 38 negro.

### `stock` — cuánto hay, por sucursal.
| campo | tipo |
|---|---|
| `variante_id` | uuid → variantes |
| `sucursal_id` | uuid → sucursales |
| `cantidad` | int NOT NULL default 0 |
| `actualizado_at` | timestamptz |

PK compuesta `(variante_id, sucursal_id)`. **Acá vive la separación entre sucursales.**
Mismo catálogo, números distintos.

### `movimientos_stock` — por qué cambió.
Cada suma o resta deja rastro: qué variante, qué sucursal, cuánto, por qué (venta,
compra, ajuste, devolución, traslado), quién y cuándo.

**El stock nunca se edita a mano desde la app.** Se registra un movimiento y el stock
se ajusta solo. Si dentro de seis meses un número no cierra, se puede reconstruir día
por día y ver quién lo tocó. Sin esto, un faltante es una discusión sin pruebas.

## Reglas que van a ir en la base, no solo en la pantalla

- El catálogo lo edita **solo el dueño**. Vendedor y contador lo leen.
- El stock lo mueve cualquier usuario activo, **siempre sobre la sucursal del equipo**
  (nunca contra `usuarios.sucursal_id`; la sucursal sale del equipo, no del usuario).
- Nada se borra: se desactiva. Un producto borrado rompería las ventas viejas.
- Al crear una variante se crea su fila de stock en **cada** sucursal activa, en 0.
  Si no, "no aparece" el producto en la otra sucursal y parece un error del sistema.

## Criterios de aceptación

1. Dar de alta un modelo con 3 talles × 2 colores crea 6 variantes y 12 filas de stock
   (6 × 2 sucursales), todas en 0.
2. Cargar 5 unidades del 38 negro en Sucursal 1 no cambia el stock de Sucursal 2.
3. Un vendedor no puede crear ni editar productos **ni siquiera llamando a la base
   directamente**, salteándose la pantalla.
4. Cada cambio de stock tiene su movimiento asociado. No existe un cambio huérfano.
5. Dos variantes con el mismo código de barras: la base lo rechaza.
6. Leer un código de barras conocido devuelve la variante en una sola consulta por
   índice, sin recorrer la tabla.
7. Vender 3 unidades de algo que tiene 1 deja el stock en -2, avisa antes de confirmar,
   y la variante queda marcada en Stock hasta que alguien la corrija.
8. Cambiar el costo de una variante **no** modifica la ganancia de ninguna venta ya
   registrada.

## Tres decisiones confirmadas por el usuario (2026-07-30)

### 1. Usan pistola lectora. El código de barras manda.
`variantes.codigo_barras` es **el camino principal** para encontrar un producto, no un
dato secundario. Consecuencias:

- Índice único sobre `codigo_barras`. La búsqueda tiene que ser una sola consulta por
  índice, no un `LIKE` sobre el nombre.
- El campo de búsqueda del POS arranca **siempre con el foco puesto**. La pistola es un
  teclado: escribe el código y manda Enter. Si el foco no está ahí, no pasa nada y el
  vendedor no entiende por qué.
- Un código leído que devuelve exactamente una variante **se agrega al ticket solo**,
  sin pantallas intermedias. Con cola de gente, cada clic de más se paga.
- Buscar por nombre sigue existiendo, para lo que no tiene etiqueta o está borrosa.

### 2. Cargan el costo. Y el costo se congela en la venta.
`variantes.costo` se carga y se mantiene. Pero hay una trampa que hay que evitar desde
el día uno:

**La línea de venta guarda su propio `costo_unitario`, copiado en el momento de vender.**
Si la ganancia se calculara mirando `variantes.costo`, el día que el proveedor aumenta y
se actualiza el costo, **cambiaría la ganancia de todas las ventas del pasado**. Los
números de meses cerrados se moverían solos. Con el costo congelado en cada línea, lo
que pasó queda como pasó.

Esto es lo que permite mostrar ganancia real y CMV, que es lo que le faltaba al sistema
viejo.

### 3. Se puede vender en negativo, avisando.
El stock del sistema y el del local no siempre coinciden. El criterio del negocio:
se fija si el producto está físicamente; si está, **se vende igual** y el sistema queda
en negativo; si no está, se cancela la venta.

Entonces el sistema **no frena la venta**, pero tampoco deja pasar el negativo en
silencio:

- Al vender algo en 0 o menos, avisa antes de confirmar. No bloquea: informa.
- La variante en negativo queda **marcada visiblemente** en Stock, con un botón para
  corregir la cantidad real.
- Toda corrección es un movimiento de tipo `ajuste`, con quién y cuándo. Un negativo
  que aparece y desaparece sin dejar rastro es exactamente lo que impide encontrar un
  faltante después.

Un stock en negativo no es un error del sistema: es el sistema diciendo "acá hay algo
que contar".

## 4. El catálogo no se carga a mano: sale de PROGES (2026-08-03)

Hoy no hay ningún dato cargado. El plan del negocio es **exportar el contenido de
PROGES en el local y después cargar las cantidades con un conteo físico**.

Eso cambia una decisión de diseño: el catálogo tiene que estar **preparado para
tragarse una exportación**, no pensado suponiendo que alguien va a tipear cientos de
pares de zapatillas con todos sus talles. Un sistema que exige eso queda vacío y sin
usar.

Consecuencias concretas:

- `variantes.sku` es donde entra el código interno que traiga el archivo de PROGES.
  Tiene índice único: reimportar el mismo archivo **actualiza en vez de duplicar**, y
  un export con códigos repetidos falla de entrada en lugar de ensuciar la base en
  silencio.
- El primer conteo físico entra como movimientos de motivo **`inventario_inicial`**,
  no como `compra`. Registrarlo como compra inventaría una compra que nunca existió y
  ensuciaría el costo de mercadería del primer mes.
- El orden es: primero el catálogo (modelos y variantes), después las cantidades. Se
  puede importar el catálogo entero con todo en 0 y contar después, sucursal por
  sucursal, sin que el sistema quede a medias.

## Lo que quedó construido (2026-08-03)

Cuatro tablas, con las reglas dentro de la base y no solo en la pantalla:

- **`productos`** y **`variantes`** — índice único en `codigo_barras` (parcial: acepta
  variantes sin etiqueta), único en `(producto_id, talle, color)` tratando NULL como
  vacío, único en `sku`, y búsqueda por texto sobre nombre + marca.
- **`stock`** — PK `(variante_id, sucursal_id)`, sin `check >= 0` a propósito, con un
  índice parcial sobre los negativos para la pantalla de faltantes.
- **`movimientos_stock`** — con signo, motivo acotado a una lista, `referencia_id` para
  ir del número al comprobante, quién y cuándo.

Y cuatro automatismos:

1. Variante nueva → fila de stock en 0 en **cada** sucursal activa.
2. Sucursal nueva → arranca con todo el catálogo en 0, no vacía.
3. Movimiento insertado → el stock se acomoda solo. **No hay otra forma de cambiar una
   cantidad**: la tabla `stock` no tiene permiso de escritura para nadie.
4. Los movimientos son inmutables: no se editan ni se borran. Un error se corrige con
   otro movimiento de tipo `ajuste`, que queda a la vista.

### Verificado contra la base real

| Criterio | Resultado |
|---|---|
| 1. Modelo con 3 talles × 2 colores | 6 variantes, 12 filas de stock |
| 2. Cargar en Sucursal 1 | Sucursal 2 quedó intacta en 0 |
| 3. Vendedor crea o edita un producto | Rechazado por la base, no por la pantalla |
| 3. Vendedor lee catálogo y stock | Sí, como corresponde |
| 4. Editar un movimiento | Rechazado |
| 4. Editar `stock` a mano | Rechazado |
| 5. Código de barras duplicado | Rechazado |
| 6. Buscar por código de barras | `Index Scan`, no recorre la tabla |
| 7. Vender 7 teniendo 5 | Quedó en −2, sin frenar la venta |
| — Movimiento a nombre de otro usuario | Rechazado |

El criterio 8 (el costo congelado en la línea de venta) se verifica en P3, cuando exista
la tabla de ventas. La decisión ya está tomada acá.

Todo lo de prueba se borró: el catálogo quedó vacío, como estaba.

### Un hallazgo que hubiera roto la app

Las políticas RLS **no alcanzan solas**: primero hay que tener permiso sobre la tabla, y
las tablas creadas por migración no lo heredan. Sin los `GRANT`, la app hubiera mostrado
`permission denied for table productos` aunque la política dejara pasar. Está corregido y
probado; queda anotado porque va a volver a pasar con cada tabla nueva.
