const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require(process.env.PYMEOS_PGLITE||'@electric-sql/pglite');
test('Revisión fiscal: PostgreSQL real embebido, sin Gateway ni red',async t=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
   create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
   create function public.rls_auto_enable() returns event_trigger language plpgsql as $$begin end$$;
   create schema storage;create table storage.buckets(id text primary key,name text,public boolean);create table storage.objects(id uuid primary key,bucket_id text,name text);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  const dir=path.join(__dirname,'../supabase/migrations');
  for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
  const actor='00000000-0000-4000-8000-000000000001',branch='00000000-0000-4000-8000-000000000002',seller='00000000-0000-4000-8000-000000000003';
  await db.exec(`insert into auth.users(id,email) values('${actor}','a@test.invalid'),('${seller}','b@test.invalid');
   insert into sucursales(id,nombre,alias,direccion) values('${branch}','Test','test','Prueba');
   insert into usuarios(user_id,nombre,email,rol,sucursal_id) values('${actor}','Test','a@test.invalid','dueno',null),('${seller}','Test2','b@test.invalid','vendedor','${branch}');
   insert into ventas(numero,sucursal_id,usuario_id,subtotal,total,created_at) select n,'${branch}','${actor}',121,121,'2026-09-29T12:00:00Z' from generate_series(1,105)n;
   insert into comprobantes(sucursal_id,venta_id,tipo,punto_venta,emisor_nombre,emisor_cuit,emisor_condicion_iva,receptor_nombre,neto,iva,total,usuario_id)
    select '${branch}',id,'B',3,'Prueba','30700000001','responsable_inscripto','Consumidor final',100,21,121,'${actor}' from ventas where numero<=104;
   insert into comprobante_lineas(comprobante_id,descripcion,cantidad,precio_unitario,neto,iva,subtotal) select id,'Producto ficticio',1,121,100,21,121 from comprobantes;`);
  const ids=(await db.query('select c.id,v.numero from comprobantes c join ventas v on v.id=c.venta_id order by v.numero')).rows.map(r=>r.id);
  const asOwner=()=>db.exec(`reset role;set request.jwt.claim.sub='${actor}';set role authenticated;`);
  const asService=()=>db.exec(`reset role;set role service_role;`);
  const snap=id=>db.query('select vista_revision_fiscal($1) r',[id]).then(r=>r.rows[0].r);
  const review=async id=>{const s=await snap(id);await db.query('select revisar_comprobante($1,$2,$3,true,$4)',[id,branch,s.huella,'revisado en test']);return s.huella;};
  const reserve=(id,h,who=actor,b=branch)=>db.query('select reservar_envio_fiscal($1,$2,$3,$4) k',[id,who,b,h]);
  await asOwner();
  await t.test('lectura muestra ventas sin borrador y páginas sin perder filas',async()=>{
   const r=await db.query("select * from ventas_pendientes_fiscales($1,'2026-09-01','2026-09-30',0)",[branch]);assert.equal(r.rows.length,100);assert.equal(Number(r.rows[0].total_filas),105);
   const last=await db.query("select * from ventas_pendientes_fiscales($1,'2026-09-01','2026-09-30',100)",[branch]);assert.equal(last.rows.length,5);
   assert.ok(r.rows.some(r=>r.estado==='sin_borrador'));
  });
  let hashes=[];
  await t.test('100 revisadas no producen envíos, CAE ni movimientos',async()=>{
   for(const id of ids.slice(0,100))hashes.push(await review(id));
   await db.exec('reset role');
   assert.equal((await db.query('select count(*)::int n from comprobantes where idempotency_key is not null or cae is not null')).rows[0].n,0);
   assert.equal((await db.query('select count(*)::int n from movimientos_stock')).rows[0].n,0);
  });
  await t.test('75 seleccionadas, 25 revisadas sin enviar',async()=>{
   await asService();for(let i=0;i<75;i++)await reserve(ids[i],hashes[i]);
   await db.exec('reset role');
   assert.equal((await db.query('select count(*)::int n from comprobantes where idempotency_key is not null')).rows[0].n,75);
   assert.equal((await db.query("select count(*)::int n from comprobantes where revision_estado='listo' and idempotency_key is null")).rows[0].n,25);
  });
  await t.test('doble clic/respuesta perdida: segunda reserva rechazada, clave estable',async()=>{
   await asService();await assert.rejects(reserve(ids[0],hashes[0]),/Ya solicitado/);
  });
  await t.test('solo servidor reserva; vendedor y sucursal errónea bloqueados',async()=>{
   await asOwner();await assert.rejects(reserve(ids[75],hashes[75]),/permission denied/);
   await asService();await assert.rejects(reserve(ids[75],hashes[75],seller),/autorizado/);
   await assert.rejects(reserve(ids[75],hashes[75],actor,seller),/Sucursal/);
   await db.exec(`reset role;set request.jwt.claim.sub='${seller}';set role authenticated;`);
   await assert.rejects(snap(ids[75]),/Solo dueño/);
   await db.exec('reset role;set role anon;');await assert.rejects(snap(ids[75]),/permission denied/);
  });
  await t.test('huella detecta modificaciones después de revisar',async()=>{
   await db.exec('reset role');await db.query('update comprobante_lineas set descripcion=$2 where comprobante_id=$1',[ids[76],'Cambió']);
   await asService();await assert.rejects(reserve(ids[76],hashes[76]),/versión actual/);
  });
  await t.test('comprobante reservado congela cabecera y renglones',async()=>{
   await db.exec('reset role');
   await assert.rejects(db.query('update comprobantes set total=1 where id=$1',[ids[0]]),/congelados/);
   await assert.rejects(db.query("update comprobante_lineas set descripcion='otro' where comprobante_id=$1",[ids[0]]),/congelados/);
  });
  await t.test('respuesta CAE simulada completa 75, no valida las restantes',async()=>{
   await asService();for(let i=0;i<75;i++)await db.query("select registrar_cae($1,$2,'12345678901234','2026-10-10')",[ids[i],i+1]);
   await db.exec('reset role');assert.equal((await db.query("select count(*)::int n from comprobantes where estado='emitido'")).rows[0].n,75);
   assert.equal((await db.query("select count(*)::int n from comprobantes where revision_estado='listo' and cae is null")).rows[0].n,25);
   await asOwner();const r=await db.query("select * from ventas_pendientes_fiscales($1,'2026-09-01','2026-09-30',0)",[branch]);assert.equal(r.rows.length,30);
  });
  await t.test('totales rotos y venta anulada no se aprueban',async()=>{
   await db.exec('reset role');await db.query('update comprobantes set total=99 where id=$1',[ids[100]]);await asOwner();await assert.rejects(review(ids[100]),/totales/);
   await db.exec('reset role');await db.query("update ventas set estado='anulada',anulada_at=now(),anulada_por=$2 where id=(select venta_id from comprobantes where id=$1)",[ids[101],actor]);await asOwner();await assert.rejects(review(ids[101]),/anulada/);
  });
  await t.test('rechazo confirmado permanece individual y bloquea reemisión automática',async()=>{
   const h=await review(ids[102]);await asService();await reserve(ids[102],h);
   await db.query("select rechazar_comprobante($1,'Rechazo simulado')",[ids[102]]);
   await assert.rejects(reserve(ids[102],h),/Ya solicitado/);
  });
  const discard=(id,b=branch,m='Carga de prueba equivocada')=>db.query('select descartar_borrador_fiscal($1,$2,$3)',[id,b,m]);
  await t.test('descarte exige dueño activo, motivo y sucursal concreta',async()=>{
   await db.exec(`reset role;set request.jwt.claim.sub='${seller}';set role authenticated;`);
   await assert.rejects(discard(ids[103]),/Solo el dueño/);
   await db.exec(`reset role;set request.jwt.claim.sub='';update usuarios set rol='contador',sucursal_id=null where user_id='${seller}';set request.jwt.claim.sub='${seller}';set role authenticated;`);
   await assert.rejects(discard(ids[103]),/Solo el dueño/);
   await db.exec('reset role;set role anon');await assert.rejects(discard(ids[103]),/permission denied/);
   await asOwner();await assert.rejects(discard(ids[103],null),/Sucursal/);
   await assert.rejects(discard(ids[103],seller),/Sucursal/);
   await assert.rejects(discard(ids[103],branch,' '),/motivo/);
   await assert.rejects(discard(ids[103],branch,'x'.repeat(1001)),/motivo/);
   await db.exec(`reset role;set request.jwt.claim.sub='';update usuarios set rol='dueno' where user_id='${seller}';update usuarios set activo=false where user_id='${actor}';`);
   await asOwner();await assert.rejects(discard(ids[103]),/Solo el dueño/);
   await db.exec(`reset role;set request.jwt.claim.sub='';update usuarios set activo=true where user_id='${actor}';`);
  });
  await t.test('CAE y envíos rechazados permanecen protegidos',async()=>{
   await asOwner();await assert.rejects(discard(ids[0]),/nunca enviados/);
   await assert.rejects(discard(ids[102]),/nunca enviados/);
   for(const field of ['numero','emitido_at','job_id','idempotency_key','envio_solicitado_at','intento']){
    await db.exec('reset role');
    const val=['numero','intento'].includes(field)?'999':['emitido_at','envio_solicitado_at'].includes(field)?'now()':"'prueba'";
    await db.query(`update comprobantes set ${field}=${val} where id=$1`,[ids[103]]);
    await asOwner();await assert.rejects(discard(ids[103]),/nunca enviados/);
    await db.exec('reset role;alter table comprobantes disable trigger proteger_borrador_enviado');
    await db.query(`update comprobantes set ${field}=${field==='intento'?'0':'null'} where id=$1`,[ids[103]]);
    await db.exec('alter table comprobantes enable trigger proteger_borrador_enviado');
   }
  });
  await t.test('descarte conserva venta, renglones, stock y auditoría; sigue pendiente sin borrador',async()=>{
   await db.exec('reset role');
   const before=(await db.query('select to_jsonb(v) venta,(select count(*) from movimientos_stock) stock,(select count(*) from comprobante_lineas) lineas from ventas v where id=(select venta_id from comprobantes where id=$1)',[ids[103]])).rows[0];
   await asOwner();await discard(ids[103]);
   const c=(await snap(ids[103])).comprobante;assert.equal(c.estado,'anulado');assert.equal(c.cae,null);
   const rows=(await db.query("select * from ventas_pendientes_fiscales($1,'2026-09-01','2026-09-30',0)",[branch])).rows;
   assert.equal(rows.find(r=>r.venta_id===c.venta_id).estado,'sin_borrador');
   await db.exec('reset role');
   const after=(await db.query('select to_jsonb(v) venta,(select count(*) from movimientos_stock) stock,(select count(*) from comprobante_lineas) lineas from ventas v where id=(select venta_id from comprobantes where id=$1)',[ids[103]])).rows[0];
   assert.deepEqual(after,before);
   const audit=(await db.query("select actor_id,detalle from fiscal_auditoria where comprobante_id=$1 and evento='borrador_descartado'",[ids[103]])).rows;
   assert.equal(audit.length,1);assert.equal(audit[0].actor_id,actor);assert.equal(audit[0].detalle.antes.estado,'pendiente');
   assert.equal((await db.query('select count(*)::int n from comprobantes where cae is not null')).rows[0].n,75);
  });
  await t.test('descartado no admite revisión, envío ni CAE; doble clic no duplica auditoría',async()=>{
   await asOwner();await assert.rejects(discard(ids[103]),/nunca enviados/);
   await assert.rejects(review(ids[103]),/Ya enviado/);
   await asService();await assert.rejects(reserve(ids[103],'h'),/revisar/);
   await assert.rejects(db.query("select registrar_cae($1,999,'12345678901234','2026-10-10')",[ids[103]]),/anulado|pendiente|emitido/i);
  });
  await t.test('rechazado nunca enviado también se puede descartar',async()=>{
   await asOwner();await db.query("select rechazar_comprobante($1,'Sin envío')",[ids[98]]);
   await discard(ids[98]);assert.equal((await snap(ids[98])).comprobante.estado,'anulado');
  });
 }finally{await db.close();}
});
