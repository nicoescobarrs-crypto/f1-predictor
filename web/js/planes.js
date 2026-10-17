/* Planes manuales y laboratorio. Los permisos efectivos los decide Supabase. */
(function () {
const CATALOGO = [
  {codigo:'basico',nombre:'Básico',precio_cop:0,max_escenarios:0,max_comparacion:0,exportar:false},
  {codigo:'vip',nombre:'VIP',precio_cop:9900,max_escenarios:10,max_comparacion:2,exportar:false},
  {codigo:'experto',nombre:'Experto',precio_cop:24900,max_escenarios:50,max_comparacion:5,exportar:true},
];
const Planes = { actual: {...CATALOGO[0]}, escenarios: [], version:0, catalogo:CATALOGO };
const el = id => document.getElementById(id);
const esc = value => escapar(String(value ?? ''));
const precio = value => new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(value);
const fecha = value => new Date(value).toLocaleDateString('es-CO');
const aviso = (id,text) => { el(id).textContent=text; };
const requiereSesion = () => {
  if (Cuenta.sesion) return true;
  Cuenta.abrirModal('entrar'); return false;
};
async function rpc(nombre,args={}) {
  if (!Cuenta.sb) throw new Error('El servicio no está disponible. Reintenta más tarde.');
  const {data,error}=await Cuenta.sb.rpc(nombre,args);
  if(error) throw new Error(error.message);
  return data;
}
Planes.abrir = () => document.querySelector('#tabs [data-panel="planes"]').click();

function pintarPlanes() {
  const p=Planes.actual;
  el('plan-actual').textContent=Cuenta.sesion
    ? `Tu acceso: ${p.nombre}${p.es_admin?' · Administrador':p.codigo!=='basico'&&p.vence_en?` · Hasta ${fecha(p.vence_en)}`:''}`
    : 'Puedes explorar la página con Básico. Inicia sesión para solicitar una mejora.';
  el('planes-tarjetas').innerHTML=Planes.catalogo.map(c=>`<article class="tarjeta plan-tarjeta ${c.codigo===p.codigo?'plan-activo':''}">
    <h3>${esc(c.nombre)}</h3><p class="plan-precio">${c.precio_cop?precio(c.precio_cop):'Gratis'}${c.precio_cop?'<small>COP / mes</small>':''}</p>
    <ul><li>Predicciones, histórico, quiniela y asistente de la página</li>
    ${c.max_escenarios?`<li>Hasta ${c.max_escenarios} escenarios guardados</li><li>Compara hasta ${c.max_comparacion} escenarios</li>`:'<li>Experimenta reordenando la parrilla</li>'}
    ${c.exportar?'<li>Exportación de escenarios a CSV</li>':''}</ul>
    <button class="accion" data-solicitar="${c.codigo}" ${c.codigo===p.codigo||c.codigo==='basico'||p.es_admin?'disabled':''}>
      ${c.codigo===p.codigo?'Tu plan':p.es_admin?'Incluido para administradores':c.codigo==='basico'?'Acceso gratuito':`Solicitar ${esc(c.nombre)}`}</button>
    </article>`).join('');
  el('escenario-cupo').textContent=`${Planes.escenarios.length} / ${p.max_escenarios} escenarios guardados${p.codigo==='basico'?' · Disponibles con VIP o Experto':''}`;
  el('escenario-guardar').disabled=!Cuenta.sesion||p.max_escenarios===0;
  el('escenario-comparar').disabled=p.max_comparacion<2;
  el('escenario-exportar').disabled=!p.exportar;
  pintarEscenarios();
}
function pintarEscenarios() {
  const elegidos=new Set(seleccionados());
  el('escenario-lista').innerHTML=Planes.escenarios.length?Planes.escenarios.map(s=>`<div class="escenario-fila">
    <label><input type="checkbox" name="escenario-elegido" value="${esc(s.id)}" ${elegidos.has(s.id)?'checked':''}> <b>${esc(s.nombre)}</b>
    <small>${esc(s.evento_slug.replace(/^\d+-/,'').replace(/-/g,' '))} · ${fecha(s.creado_en)}</small></label>
    <button class="accion secundaria" data-cargar="${esc(s.id)}">Cargar</button>
    <button class="accion secundaria" data-borrar="${esc(s.id)}">Eliminar</button></div>`).join(''):
    '<p class="texto-tenue">Todavía no tienes escenarios guardados. Ajusta la parrilla y guarda una variante con VIP o Experto.</p>';
}
async function pintarAdmin() {
  el('planes-admin').hidden=!Cuenta.esAdmin();
  if(!Cuenta.esAdmin()) return;
  const usuario=Cuenta.sesion.user.id;
  const {data,error}=await Cuenta.sb.from('solicitudes_plan').select('usuario_id,plan,perfiles(usuario)').order('creada_en');
  if(Cuenta.sesion?.user.id!==usuario||!Cuenta.esAdmin())return;
  if(error) { aviso('planes-solicitudes','No se pudieron cargar las solicitudes.'); return; }
  el('planes-solicitudes').innerHTML=data.length?data.map(s=>`<button class="accion secundaria" data-pendiente="${esc(s.perfiles?.usuario)}" data-plan="${esc(s.plan)}">
    ${esc(s.perfiles?.usuario)} · solicita ${esc(s.plan)}</button>`).join(' '):'<p class="texto-tenue">No hay solicitudes pendientes.</p>';
}
Planes.refrescar = async function () {
  const version=++Planes.version;
  Planes.actual={...CATALOGO[0]}; Planes.escenarios=[];
  el('escenario-resultado').innerHTML=''; el('planes-solicitudes').innerHTML='';
  pintarPlanes(); el('planes-admin').hidden=true;
  if(!Cuenta.sesion) return;
  try {
    const [plan,lista]=await Promise.all([
      rpc('mi_plan'), Cuenta.sb.from('escenarios').select('*').order('creado_en',{ascending:false}),
    ]);
    if(version!==Planes.version) return;
    if(lista.error) throw new Error(lista.error.message);
    Planes.actual=plan; Planes.escenarios=lista.data??[];
    pintarPlanes(); await pintarAdmin();
  } catch(error) { if(version===Planes.version) aviso('planes-estado','No se pudo actualizar tu plan. Tus datos guardados siguen en tu cuenta.'); }
};

function instantanea() {
  if(!estado.evento||!estado.parrilla.length) throw new Error('Selecciona primero un Gran Premio.');
  const resultado=estado.parrilla.map((id,i)=>({
    ...infoPiloto(id),grid:i+1,...(estimacion(id,i+1)??{}),
  })).sort((a,b)=>(a.pos??99)-(b.pos??99)).map((p,i)=>({
    driver_id:p.driver_id,nombre:p.nombre,grid:p.grid,posicion:i+1,
    victoria:p.victoria??null,podio:p.podio??null,puntos:p.puntos??null,abandono:p.abandono??null,
  }));
  return {evento_slug:el('sel-evento').value,parrilla:estado.parrilla.slice(),resultado};
}
const seleccionados=()=>Array.from(document.querySelectorAll('[name="escenario-elegido"]:checked'),n=>n.value);
function comparar(datos) {
  comprobarPropietario(datos);
  const pilotos=Array.from(new Set(datos.flatMap(s=>s.resultado.map(p=>p.driver_id))));
  el('escenario-resultado').innerHTML=`<h3>Comparación de escenarios</h3>
    <p class="texto-tenue">Cada columna conserva la predicción que guardaste. Si los datos del modelo cambian, esos valores históricos se mantienen. Comparar carreras distintas también cambia el contexto.</p>
    <div class="tabla-wrap"><table><thead><tr><th>Piloto</th>${datos.map(s=>`<th>${esc(s.nombre)}</th>`).join('')}</tr></thead>
    <tbody>${pilotos.map(id=>{const nombre=datos.flatMap(s=>s.resultado).find(p=>p.driver_id===id)?.nombre??id;
      return `<tr><td>${esc(nombre)}</td>${datos.map(s=>{const p=s.resultado.find(x=>x.driver_id===id);return `<td>${p?`P${esc(p.posicion)} · sale P${esc(p.grid)}<br>Victoria ${pct(p.victoria)}`:'—'}</td>`;}).join('')}</tr>`;}).join('')}</tbody></table></div>`;
}
// Neutralizar fórmulas al abrir un CSV en una hoja de cálculo.
function celdaCSV(value) { let s=String(value??''); if(/^[\s]*[=+@-]/.test(s)) s="'"+s; return '"'+s.replace(/"/g,'""')+'"'; }
Planes.csv = datos => '\uFEFF'+[['Escenario','Gran Premio','Piloto','Salida','Posición prevista','Victoria','Podio','Puntos','Abandono'],
  ...datos.flatMap(s=>s.resultado.map(p=>[s.nombre,s.evento_slug,p.nombre,p.grid,p.posicion,p.victoria,p.podio,p.puntos,p.abandono]))]
  .map(row=>row.map(celdaCSV).join(',')).join('\r\n');
function descargarCSV(datos) {
  comprobarPropietario(datos);
  const url=URL.createObjectURL(new Blob([Planes.csv(datos)],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a'); a.href=url; a.download='f1-predictor-escenarios.csv'; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function comprobarPropietario(datos) {
  if(!Cuenta.sesion||datos.some(s=>s.usuario_id!==Cuenta.sesion.user.id))throw new Error('La sesión cambió. Vuelve a seleccionar tus escenarios.');
}
function ejecutar(id,accion) {
  return async e=>{ const btn=e.currentTarget; btn.disabled=true; aviso(id,'');
    try { await accion(); } catch(error) { aviso(id,error.message||'No se pudo completar. Reintenta.'); }
    finally { btn.disabled=false; pintarPlanes(); }
  };
}
Planes.iniciar = async function () {
  el('planes-actualizar').onclick=()=>Planes.refrescar();
  el('planes-tarjetas').onclick=async e=>{
    const b=e.target.closest('[data-solicitar]'); if(!b||b.disabled||!requiereSesion())return;
    b.disabled=true;
    try {
      const {error}=await Cuenta.sb.from('solicitudes_plan').upsert({usuario_id:Cuenta.sesion.user.id,plan:b.dataset.solicitar},{onConflict:'usuario_id'});
      if(error)throw new Error(error.message);
      aviso('planes-estado',`Solicitud de ${b.dataset.solicitar.toUpperCase()} enviada. Nico o Martín revisará la activación. No se ha realizado ningún cobro.`);
    } catch(error){aviso('planes-estado',error.message);} finally{pintarPlanes();}
  };
  el('escenario-guardar').onclick=ejecutar('escenario-estado',async()=>{
    if(!requiereSesion())return;
    const nombre=el('escenario-nombre').value.trim(); if(!nombre)throw new Error('Ponle un nombre al escenario.');
    const {error}=await Cuenta.sb.from('escenarios').insert({usuario_id:Cuenta.sesion.user.id,nombre,...instantanea()});
    if(error)throw new Error(error.message);
    await Planes.refrescar(); aviso('escenario-estado','Escenario guardado.');
  });
  el('escenario-lista').onclick=async e=>{
    const cargar=e.target.closest('[data-cargar]'),borrar=e.target.closest('[data-borrar]');
    const id=cargar?.dataset.cargar??borrar?.dataset.borrar;
    const s=Planes.escenarios.find(x=>x.id===id); if(!s)return;
    try {
      if(cargar) {
        const usuario=Cuenta.sesion?.user.id;
        await seleccionarEvento(s.evento_slug); el('sel-evento').value=s.evento_slug;
        if(Cuenta.sesion?.user.id!==usuario)return;
        const ids=estado.evento.grid_referencia.map(p=>p.driver_id);
        if(ids.length!==s.parrilla.length||s.parrilla.some(id=>!ids.includes(id))) throw new Error('La plantilla cambió. Este escenario se conserva para comparar, pero no puede cargarse en la parrilla actual.');
        estado.parrilla=s.parrilla.slice(); renderParrilla(); recomputar();
        aviso('escenario-estado','Parrilla recuperada. El resultado visible se recalcula con los datos actuales.');
      } else {
        const {error}=await Cuenta.sb.from('escenarios').delete().eq('id',id);
        if(error)throw new Error(error.message);
        await Planes.refrescar(); aviso('escenario-estado','Escenario eliminado.');
      }
    } catch(error){aviso('escenario-estado',error.message);}
  };
  el('escenario-comparar').onclick=ejecutar('escenario-estado',async()=>comparar(await rpc('comparar_escenarios',{ids:seleccionados()})));
  el('escenario-exportar').onclick=ejecutar('escenario-estado',async()=>descargarCSV(await rpc('exportar_escenarios',{ids:seleccionados()})));
  el('planes-asignar').onclick=ejecutar('planes-admin-estado',async()=>{
    const usuario=el('planes-usuario').value.trim(),nuevo_plan=el('planes-codigo').value;
    if(!usuario)throw new Error('Escribe el nombre de usuario exacto.');
    const resultado=await rpc('asignar_plan',{usuario,nuevo_plan});
    await Planes.refrescar(); aviso('planes-admin-estado',`Plan ${nuevo_plan} asignado a ${usuario}${resultado.vence_en?` hasta ${fecha(resultado.vence_en)}`:''}.`);
  });
  el('planes-solicitudes').onclick=e=>{const b=e.target.closest('[data-pendiente]');if(b){el('planes-usuario').value=b.dataset.pendiente;el('planes-codigo').value=b.dataset.plan;}};
  Cuenta.alCambiar(()=>{Planes.lista=Planes.refrescar();});
  await Planes.lista;
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)Planes.refrescar();});
};
// Los precios son visibles aunque los datos o la cuenta sigan cargando.
pintarPlanes();
window.Planes=Planes;
})();
