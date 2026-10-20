const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PYMEOS_PGLITE || '@electric-sql/pglite');
const root = path.join(__dirname, '..');
test('PostgreSQL aislado: migraciones reales y compra atómica', async t => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}');
      create function public.rls_auto_enable() returns event_trigger language plpgsql as $$ begin end $$;
      create schema storage; create table storage.buckets(id text primary key, name text, public boolean);
      create table storage.objects(id uuid primary key, bucket_id text, name text);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
    const migrations = fs.readdirSync(path.join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
    // Historial legado: el hardening del 14 referencia facturación fechada el 15.
    // Se respeta esa dependencia explícitamente; NO se reescriben migraciones históricas.
    if (migrations.includes('20260814144419_proteger_ventas_de_importes_invalidos.sql')) {
      const fiscal = migrations.splice(migrations.indexOf('20260815120000_facturacion.sql'),1)[0];
      migrations.splice(migrations.indexOf('20260814144419_proteger_ventas_de_importes_invalidos.sql'),0,fiscal);
    }
    for (const file of migrations) {
      try { await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8')); }
      catch(e) { throw new Error(`${file}: ${e.message}`); }
    }
    console.log('Migraciones aplicadas en PostgreSQL embebido, sin red.');
    const user='00000000-0000-4000-8000-000000000001';
    const branch='00000000-0000-4000-8000-000000000002';
    const supplier='00000000-0000-4000-8000-000000000003';
    await db.exec(`insert into auth.users(id,email) values('${user}','test@example.invalid');
      insert into public.sucursales(id,nombre,alias,direccion) values('${branch}','Matienzo prueba','test','Prueba');
      insert into public.usuarios(user_id,nombre,rol,email) values('${user}','Dueño prueba','dueno','test@example.invalid');
      insert into public.proveedores(id,nombre,cuit) values('${supplier}','Proveedor prueba','30711925763');
      set request.jwt.claim.sub='${user}'; set role authenticated;`);
    const body = { documento:'compra', proveedor_id:supplier, fecha:'2026-08-24',tipo_comprobante:'factura_a',punto_venta:'0023',numero_comprobante:'00028806',
      total_documento:1334877.60,iva:228836.16,percepciones:16345.44,pagos:[],
      lineas:[{cantidad:48,costo_unitario:22702,nueva_variante:{nombre:'Modelo ficticio de prueba',marca:'Prueba',talle:'30',color:'Azul',precio_venta:40000}}] };
    const call = d => db.query('select public.registrar_compra_asistida($1,$2) as r',[branch,JSON.stringify(d)]);
    let id;
    await t.test('alta + 48 unidades + impuestos + deuda', async()=>{
      const r=(await call(body)).rows[0].r; id=r.compra_id;
      assert.equal(Number(r.total),1334877.60);
      assert.equal(Number((await db.query('select saldo from public.proveedores where id=$1',[supplier])).rows[0].saldo),1334877.60);
      assert.equal(Number((await db.query('select sum(cantidad) as n from public.stock where sucursal_id=$1',[branch])).rows[0].n),48);
    });
    await t.test('respuesta perdida: mismo documento devuelve misma compra',async()=>{
      const r=(await call({...body,punto_venta:'23',numero_comprobante:'28806'})).rows[0].r;
      assert.equal(r.compra_id,id); assert.equal(r.ya_registrada,true);
      assert.equal((await db.query('select count(*)::int as n from public.compras')).rows[0].n,1);
    });
    await t.test('misma factura con datos distintos no duplica',async()=>{
      await assert.rejects(call({...body,total_documento:1}),/otros datos/);
    });
    await t.test('error al final revierte también los productos nuevos',async()=>{
      const d=structuredClone(body); d.numero_comprobante='999';d.total_documento=2;
      d.lineas[0].nueva_variante.nombre='No debe persistir';
      await assert.rejects(call(d),/no coinciden/);
      assert.equal((await db.query("select count(*)::int as n from public.productos where nombre='No debe persistir'")).rows[0].n,0);
    });
    await t.test('dos colores del mismo modelo reutilizan producto',async()=>{
      const d=structuredClone(body); d.numero_comprobante='2';d.lineas[0].nueva_variante.color='Negro';
      await call(d);
      assert.equal((await db.query('select count(*)::int as n from public.productos')).rows[0].n,1);
      assert.equal((await db.query('select count(*)::int as n from public.variantes')).rows[0].n,2);
    });
    await t.test('falla por talle desconocido sin crear stock genérico',async()=>{
      const d=structuredClone(body);d.numero_comprobante='3';delete d.lineas[0].nueva_variante.talle;
      await assert.rejects(call(d),/talle\/color/);
    });
    await t.test('pagos mayores al subtotal pero menores al total son válidos',async()=>{
      const medio=(await db.query("select id from public.medios_pago where activo and not es_cuenta_corriente and not afecta_caja limit 1")).rows[0].id;
      const d=structuredClone(body);d.numero_comprobante='4';d.pagos=[{medio_pago_id:medio,monto:1200000}];
      const r=(await call(d)).rows[0].r;
      assert.equal(Number(r.pendiente),134877.60);
      assert.equal(Number((await db.query('select sum(monto) as saldo from public.movimientos_proveedor where compra_id=$1',[r.compra_id])).rows[0].saldo),134877.60);
      const repeat=(await call(d)).rows[0].r; assert.equal(repeat.ya_registrada,true);
      assert.equal((await db.query("select count(*)::int as n from public.movimientos_proveedor where compra_id=$1 and tipo='pago'",[r.compra_id])).rows[0].n,1);
    });
    await t.test('anulación revierte mercadería e impuestos',async()=>{
      const saldo=Number((await db.query('select saldo from public.proveedores where id=$1',[supplier])).rows[0].saldo);
      await db.query('select public.anular_compra($1,$2)',[id,'Prueba aislada']);
      const nuevoSaldo=Number((await db.query('select saldo from public.proveedores where id=$1',[supplier])).rows[0].saldo);
      assert.equal(Math.round((saldo-nuevoSaldo)*100),133487760);
      await assert.rejects(call(body),/anulada/);
    });
    await t.test('vendedor no puede crear catálogo ni modificar tablas contables',async()=>{
      const vendedor='00000000-0000-4000-8000-000000000004';
      await db.exec(`reset role; insert into auth.users(id,email) values('${vendedor}','vendedor@example.invalid');
        insert into public.usuarios(user_id,nombre,rol,email,sucursal_id) values('${vendedor}','Vendedor','vendedor','vendedor@example.invalid','${branch}');
        set request.jwt.claim.sub='${vendedor}'; set role authenticated;`);
      const d=structuredClone(body);d.numero_comprobante='5';
      await assert.rejects(call(d),/dueño/);
      await assert.rejects(db.exec('update public.compras set total=1'),/permission denied/);
      await db.exec(`reset role; set request.jwt.claim.sub='${user}'; set role authenticated;`);
    });
    await t.test('variante existente permite compra sin alta de catálogo',async()=>{
      const variante=(await db.query('select id from public.variantes limit 1')).rows[0].id;
      const d=structuredClone(body);d.numero_comprobante='6';
      d.lineas=[{variante_id:variante,cantidad:48,costo_unitario:22702}];
      await call(d);
      assert.equal((await db.query('select count(*)::int as n from public.variantes')).rows[0].n,2);
    });
    await t.test('anon y sesión ausente no pueden ejecutar',async()=>{
      await db.exec('reset role; set role anon;');
      await assert.rejects(call(body),/permission denied/);
      await db.exec("reset role; set request.jwt.claim.sub=''; set role authenticated;");
      await assert.rejects(call(body),/usuario activo/);
      await db.exec(`reset role; set request.jwt.claim.sub='${user}'; set role authenticated;`);
    });
    await t.test('fracción, total incorrecto y sobrepago revierten todo',async()=>{
      const d=structuredClone(body);d.numero_comprobante='7';d.lineas[0].cantidad=1.5;
      await assert.rejects(call(d),/entera/);
      const medio=(await db.query("select id from public.medios_pago where activo and not es_cuenta_corriente and not afecta_caja limit 1")).rows[0].id;
      d.lineas[0].cantidad=48;d.pagos=[{medio_pago_id:medio,monto:2000000}];
      await assert.rejects(call(d),/más que el total/);
      assert.equal((await db.query("select count(*)::int as n from public.compras where numero_comprobante='7'")).rows[0].n,0);
    });
  } finally { await db.close(); }
});
