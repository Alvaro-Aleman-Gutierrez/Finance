'use strict';
// Mis Cuentas: todos los datos se guardan solo en este teléfono (localStorage).

const KEY = 'cuentas-datos-v1';

// ---------- estado ----------
function defaults() {
  return {
    version: 1,
    ajustes: {
      tc: 507, split: 0.5, diaCorte: 15,
      tarjetas: ['AMEX', 'VISA', 'PriceSmart'],
      categorias: ['Supermercado', 'Restaurantes', 'Combustible', 'Transporte', 'Suscripciones',
        'Vehículo', 'Seguros', 'Salud', 'Mascotas', 'Hogar', 'Compras', 'Lotería', 'Donaciones',
        'Profesional', 'Intereses', 'Otros'],
      personas: ['Yo', 'Amor'],
      cortes: {}, // día de corte propio de una tarjeta, ej. { BCR: 3 }
      ingresos: [],
      fijos: []
    },
    movimientos: [],
    pagos: [],
    cuotas: [],
    recibos: {}, // { "2026-10": { "Agua": 11109 } } monto real de servicios que varían
    ultimoRespaldo: null,
    cambiosDesdeRespaldo: 0
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const s = JSON.parse(raw);
    return Object.assign(defaults(), s, { ajustes: Object.assign(defaults().ajustes, s.ajustes || {}) });
  } catch (e) {
    return defaults();
  }
}

let S = load();
let persistAsked = false;

function save(cambio = true) {
  if (cambio) S.cambiosDesdeRespaldo = (S.cambiosDesdeRespaldo || 0) + 1;
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
  } catch (e) {
    toast('No se pudo guardar: ' + e.message);
  }
  if (!persistAsked && navigator.storage && navigator.storage.persist) {
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }
}

// ---------- utilidades ----------
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const crcFmt = v => (v < 0 ? '−₡' : '₡') + nf0.format(Math.abs(Math.round(v)));
const usdFmt = v => '$' + nf2.format(v);
const montoFmt = (v, mon) => mon === 'USD' ? usdFmt(v) : (Number.isInteger(v) ? '₡' + nf0.format(v) : '₡' + nf2.format(v));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}
function fechaCorta(s) {
  if (!s) return 'sin fecha';
  const { m, d } = parseISO(s);
  return `${pad(d)}/${pad(m)}`;
}
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MESES_L = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function fechaLarga(s) {
  const { y, m, d } = parseISO(s);
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const wd = new Date(y, m - 1, d).getDay();
  return `${dias[wd]} ${d} de ${MESES_L[m - 1]}`;
}

// "1.234,50" / "1,234.50" / "1234.5" / "17.988" -> número
function parseMonto(txt) {
  let s = String(txt).trim().replace(/[₡$\s]/g, '');
  if (!s) return NaN;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const mil = dec === '.' ? ',' : '.';
    s = s.split(mil).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  return Number(s);
}

// ---------- reglas de negocio ----------
const A = () => S.ajustes;
const yo = () => A().personas[0] || 'Yo';
// La segunda persona es con quien se comparten las tarjetas.
const pareja = () => A().personas[1] || 'Otra persona';
const RESP = () => [...A().personas, 'Compartido'];

function corteKey(y, m) {
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${pad(m)}`;
}
function sumarMes(c, n) {
  const [y, m] = c.split('-').map(Number);
  return corteKey(y, m + n);
}
// Día de corte de cada tarjeta (si no tiene uno propio, el general).
const diaDe = t => (A().cortes && A().cortes[t]) || A().diaCorte;
// Con corte el 15: compras del 16 de un mes al 15 del siguiente forman un corte,
// que lleva el nombre del mes en que cierra y se paga a fin de ese mes.
function corteDeFecha(iso, dia = A().diaCorte) {
  if (!iso) return '';
  const { y, m, d } = parseISO(iso);
  return corteKey(y, m + (d > dia ? 1 : 0));
}
const corteMov = mv => mv.mesManual || corteDeFecha(mv.fecha, diaDe(mv.tarjeta));
// Un pago cuenta para el corte del mes en que se hace (se paga hasta fin de mes).
const cortePago = p => p.mesManual || (p.fecha ? p.fecha.slice(0, 7) : '');
const quincena = iso => (parseISO(iso).d <= 15 ? 1 : 2);

function infoCorte(c, dia = A().diaCorte) {
  const [y, m] = c.split('-').map(Number);
  const desde = new Date(y, m - 2, dia + 1);
  const hasta = new Date(y, m - 1, dia);
  const limite = new Date(y, m, 0);
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  let estado = 'Cerrado';
  if (hoy <= hasta) estado = 'En curso';
  else if (hoy <= limite) estado = 'Por pagar';
  const dias = Math.round((limite - hoy) / 86400000);
  const f = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  return { desde: f(desde), hasta: f(hasta), limite: f(limite), estado, dias, nombre: `${MESES_L[m - 1]} ${y}` };
}

// Corte que conviene mostrar al abrir: el que se está pagando, si aún no vence.
function corteInicial() {
  // Después del día de corte, el corte de este mes ya cerró y se está pagando;
  // antes, el corte de este mes sigue en curso. En ambos casos es el del mes actual.
  const { y, m } = parseISO(hoyISO());
  return corteKey(y, m);
}

const enColones = (monto, mon) => (mon === 'USD' ? monto * A().tc : monto);
const montoCRC = mv => enColones(mv.monto, mv.moneda);
function parteYo(mv) {
  const k = mv.resp === yo() ? 1 : mv.resp === 'Compartido' ? A().split : 0;
  return montoCRC(mv) * k;
}

// Parte de una persona en un gasto. "Compartido" es entre usted y la 2ª persona.
function parteDe(mv, p) {
  if (p === yo()) return parteYo(mv);
  if (mv.resp === p) return montoCRC(mv);
  if (mv.resp === 'Compartido' && p === pareja()) return montoCRC(mv) * (1 - A().split);
  return 0;
}

// ---------- compras a cuotas (tasa cero) ----------
// Cada compra genera sola su cuota en cada corte, desde primerCorte hasta la última cuota.
function mesesEntre(a, b) {
  const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}
function cuotaEn(pl, c) {
  const n = mesesEntre(pl.primerCorte, c);
  if (n < 0) return null;
  if (!pl.cuotaInicial) return pl.total ? null : 0; // sin número: se repite hasta que la quite
  const k = pl.cuotaInicial + n;
  return pl.total && k > pl.total ? null : k;
}
function ultimoCorte(pl) {
  return pl.total && pl.cuotaInicial ? sumarMes(pl.primerCorte, pl.total - pl.cuotaInicial) : null;
}
function movsAuto(c) {
  return (S.cuotas || []).map(pl => {
    const k = cuotaEn(pl, c);
    if (k === null) return null;
    return { id: `auto:${pl.id}:${c}`, auto: true, planId: pl.id, fecha: '', mesManual: c, tarjeta: pl.tarjeta,
      comercio: pl.descripcion, moneda: pl.moneda, monto: pl.monto, resp: pl.resp, cat: pl.cat,
      cuota: k || null, cuotas: pl.total || null, nota: 'Cuota automática' };
  }).filter(Boolean);
}
const movsDe = c => S.movimientos.filter(mv => corteMov(mv) === c).concat(movsAuto(c));

// Servicios que varían: si ya anotó el recibo del mes se usa ese monto; si no, el estimado.
const recibo = (c, concepto) => (S.recibos && S.recibos[c] ? S.recibos[c][concepto] : undefined);
function fijoMonto(f, p, c) {
  const r = f.variable && p === yo() ? recibo(c, f.concepto) : undefined;
  return enColones(r !== undefined ? Number(r) : Number(f.montos[p]) || 0, f.moneda);
}

function calcular(c) {
  const a = A();
  const movs = movsDe(c);
  const pagos = S.pagos.filter(p => cortePago(p) === c);

  const tarjetas = a.tarjetas.map(t => {
    const ms = movs.filter(mv => mv.tarjeta === t);
    const crc = ms.filter(mv => mv.moneda !== 'USD').reduce((s, mv) => s + mv.monto, 0);
    const usd = ms.filter(mv => mv.moneda === 'USD').reduce((s, mv) => s + mv.monto, 0);
    const total = ms.reduce((s, mv) => s + montoCRC(mv), 0);
    const mi = ms.reduce((s, mv) => s + parteYo(mv), 0);
    return { nombre: t, crc, usd, total, mi, otros: total - mi, n: ms.length };
  });
  const tarjYo = tarjetas.reduce((s, t) => s + t.mi, 0);
  const tarjTotal = tarjetas.reduce((s, t) => s + t.total, 0);

  const fijosPersona = {};
  a.personas.forEach(p => {
    fijosPersona[p] = a.fijos.reduce((s, f) => s + fijoMonto(f, p, c), 0);
  });
  const ingQ1 = a.ingresos.reduce((s, i) => s + (Number(i.q1) || 0), 0);
  const ingQ2 = a.ingresos.reduce((s, i) => s + (Number(i.q2) || 0), 0);
  const ingresos = ingQ1 + ingQ2;
  const fijosYo = fijosPersona[yo()] || 0;
  const gastos = tarjYo + fijosYo;
  const intereses = movs.filter(mv => mv.cat === 'Intereses').reduce((s, mv) => s + montoCRC(mv), 0);

  const pagado = (dest, q) => pagos.filter(p => p.destino === dest && quincena(p.fecha) === q)
    .reduce((s, p) => s + enColones(p.monto, p.moneda), 0);
  const plan = [
    ...tarjetas.map(t => ({ dest: t.nombre, aPagar: t.total, tipo: 'tarjeta' })),
    ...a.fijos.map(f => ({ dest: f.concepto, aPagar: fijoMonto(f, yo(), c), tipo: 'fijo',
      variable: !!f.variable, estimado: !!f.variable && recibo(c, f.concepto) === undefined })),
    { dest: 'Otro', aPagar: 0, tipo: 'otro' }
  ].map(r => {
    const p1 = pagado(r.dest, 1), p2 = pagado(r.dest, 2);
    return Object.assign(r, { p1, p2, pend: r.tipo === 'otro' ? 0 : r.aPagar - p1 - p2 });
  });
  const totAPagar = plan.reduce((s, r) => s + r.aPagar, 0);
  const totP1 = plan.reduce((s, r) => s + r.p1, 0);
  const totP2 = plan.reduce((s, r) => s + r.p2, 0);
  const pendiente = plan.reduce((s, r) => s + Math.max(0, r.pend), 0);

  const cats = {};
  movs.forEach(mv => { cats[mv.cat || 'Sin categoría'] = (cats[mv.cat || 'Sin categoría'] || 0) + parteYo(mv); });
  const categorias = Object.entries(cats).filter(([, v]) => Math.abs(v) > 0.005).sort((x, y) => y[1] - x[1]);

  const otras = a.personas.slice(1).map(p => {
    const t = movs.reduce((s, mv) => s + parteDe(mv, p), 0);
    return { nombre: p, tarjetas: t, fijos: fijosPersona[p] || 0, total: t + (fijosPersona[p] || 0) };
  }).filter(o => o.total > 0);

  return {
    movs, pagos, tarjetas, tarjYo, tarjTotal, fijosYo, ingQ1, ingQ2, ingresos, gastos,
    balance: ingresos - gastos, intereses, plan, totAPagar, totP1, totP2, pendiente,
    debePrimera: Math.max(0, totAPagar - ingQ2), faltante: Math.max(0, totAPagar - ingresos),
    categorias, otras
  };
}

// ---------- navegación ----------
let tab = 'resumen';
let corte = corteInicial();

document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => {
  tab = b.dataset.tab;
  document.querySelectorAll('nav.tabs button').forEach(x => x.classList.toggle('on', x === b));
  render();
  window.scrollTo(0, 0);
}));
$('#prevC').addEventListener('click', () => { corte = sumarMes(corte, -1); render(); });
$('#nextC').addEventListener('click', () => { corte = sumarMes(corte, 1); render(); });
$('#fab').addEventListener('click', () => (tab === 'pagos' ? formPago() : formGasto()));

function render() {
  const titles = { resumen: 'Resumen', movs: 'Gastos', pagos: 'Pagos', ajustes: 'Ajustes' };
  $('#title').textContent = titles[tab];
  const ic = infoCorte(corte);
  $('#corteLbl').textContent = `${MESES[Number(corte.slice(5)) - 1]} ${corte.slice(0, 4)}`;
  $('#corteEst').textContent = ic.estado;
  $('#corteNav').classList.toggle('hidden', tab === 'ajustes');
  $('#fab').classList.toggle('hidden', tab === 'ajustes');
  $('#fab').textContent = tab === 'pagos' ? '+ Pago' : '+ Gasto';
  const v = $('#view');
  if (tab === 'resumen') v.innerHTML = vistaResumen();
  else if (tab === 'movs') v.innerHTML = vistaMovs();
  else if (tab === 'pagos') v.innerHTML = vistaPagos();
  else v.innerHTML = vistaAjustes();
  bindVista();
}

// ---------- vistas ----------
function bannerRespaldo() {
  const n = S.cambiosDesdeRespaldo || 0;
  if (!S.movimientos.length && !S.pagos.length) {
    return `<div class="banner">¿Primera vez? Cargue sus datos desde Ajustes → Importar respaldo.
      <button data-go="ajustes">Ir</button></div>`;
  }
  const dias = S.ultimoRespaldo ? (Date.now() - S.ultimoRespaldo) / 86400000 : Infinity;
  if (n >= 10 && dias > 7) {
    return `<div class="banner">Tiene ${n} cambios sin respaldo. Si pierde el teléfono, se pierden.
      <button data-act="respaldo">Respaldar</button></div>`;
  }
  return '';
}

function vistaResumen() {
  const r = calcular(corte);
  const ic = infoCorte(corte);
  const pct = r.ingresos ? r.gastos / r.ingresos : 0;
  let estadoPago = '';
  if (ic.estado === 'Por pagar') {
    estadoPago = r.pendiente <= 0.5 ? '<span class="pill green">Pagado</span>'
      : `<span class="pill ${ic.dias <= 5 ? 'red' : 'blue'}">${ic.dias === 0 ? 'Vence hoy' : `Faltan ${ic.dias} días para pagar`}</span>`;
  } else if (ic.estado === 'Cerrado') {
    estadoPago = r.pendiente <= 0.5 ? '<span class="pill green">Pagado</span>' : '<span class="pill red">Venció</span>';
  } else {
    estadoPago = `<span class="pill blue">Corte en curso · cierra el ${ic.hasta}</span>`;
  }
  const maxCat = r.categorias.length ? r.categorias[0][1] : 1;
  const planVis = r.plan.filter(p => p.aPagar > 0.5 || p.p1 + p.p2 > 0.5 || p.variable);

  // mes a mes del año del corte
  const year = corte.slice(0, 4);
  const anual = [];
  for (let m = 1; m <= 12; m++) {
    const c = `${year}-${pad(m)}`;
    const tot = movsDe(c).reduce((s, mv) => s + parteYo(mv), 0);
    anual.push({ c, m, tot });
  }
  const maxA = Math.max(1, ...anual.map(x => x.tot));

  return `
  ${bannerRespaldo()}
  <div class="quick"><button class="p" data-act="gasto">+ Gasto</button><button data-act="pago">+ Pago</button></div>
  <div class="card hero">
    <div class="lab">Balance de ${esc(ic.nombre)} (ingresos − gastos)</div>
    <div class="big ${r.balance < 0 ? 'neg' : 'pos'}">${crcFmt(r.balance)}</div>
    <div class="sub">${r.balance < 0 ? 'Gasta más de lo que gana' : 'Le sobra dinero'}</div>
    <div style="margin-top:8px">${estadoPago}</div>
    <div class="kpis">
      <div><small>Ingresos</small><b>${crcFmt(r.ingresos)}</b></div>
      <div><small>Gastos (mi parte)</small><b>${crcFmt(r.gastos)}</b></div>
      <div><small>Intereses</small><b class="${r.intereses > 0 ? 'neg' : ''}">${crcFmt(r.intereses)}</b></div>
    </div>
    <div class="hint" style="margin-top:8px">Compras del ${ic.desde} al ${ic.hasta} · pagar a más tardar el ${ic.limite} · gasta el ${Math.round(pct * 100)}% de su ingreso</div>
  </div>

  <div class="card">
    <h2>Plan de pago</h2>
    <div class="row total"><span class="l">Pendiente por pagar</span><span class="r ${r.pendiente > 0.5 ? 'neg' : 'pos'}">${crcFmt(Math.max(0, r.pendiente))}</span></div>
    ${planVis.map(p => {
      const pag = p.p1 + p.p2;
      const w = p.aPagar > 0 ? Math.min(100, pag / p.aPagar * 100) : 100;
      return `<div class="plan-item">
        <div class="t"><b>${esc(p.dest)}${p.variable ? ` <span class="pill ${p.estimado ? 'blue' : 'green'}" data-recibo="${esc(p.dest)}" style="cursor:pointer">${p.estimado ? 'estimado · poner recibo' : 'recibo ✓'}</span>` : ''}</b><span>${crcFmt(pag)} <span class="hint">de ${crcFmt(p.aPagar)}</span></span></div>
        <div class="bar"><i style="width:${w}%"></i></div>
        <div class="s"><span>1ª: ${crcFmt(p.p1)} · 2ª: ${crcFmt(p.p2)}</span><span class="${p.pend > 0.5 ? 'neg' : 'pos'}">${p.tipo === 'otro' ? '' : p.pend > 0.5 ? 'Falta ' + crcFmt(p.pend) : p.pend < -0.5 ? 'Pagó ' + crcFmt(-p.pend) + ' de más' : 'Listo'}</span></div>
      </div>`;
    }).join('') || '<div class="empty">Sin pagos ni montos para este corte.</div>'}
    <div class="hint">Las tarjetas aparecen por el total del estado (incluye la parte de las otras personas, que luego le devuelven).</div>
  </div>

  <div class="card">
    <h2>¿Cómo va cada quincena?</h2>
    ${[['1ª quincena', r.ingQ1, r.totP1], ['2ª quincena', r.ingQ2, r.totP2]].map(([n, ing, pag]) => `
      <div class="row"><span class="l">${n}</span><span class="r">${crcFmt(ing)} − ${crcFmt(pag)} = <span class="${ing - pag < 0 ? 'neg' : ''}">${crcFmt(ing - pag)}</span></span></div>`).join('')}
    <div class="row"><span class="l">Con la 1ª debe pagar al menos</span><span class="r">${crcFmt(r.debePrimera)}</span></div>
    <div class="row"><span class="l">Faltante del mes (si paga todo)</span><span class="r ${r.faltante > 0 ? 'neg' : ''}">${crcFmt(r.faltante)}</span></div>
  </div>

  <div class="card">
    <h2>¿En qué se va mi dinero?</h2>
    ${r.categorias.length ? r.categorias.map(([n, v]) => `
      <div class="cat"><span class="n">${esc(n)}</span><span class="track"><i style="width:${Math.max(0, v / maxCat * 100)}%"></i></span><span class="v">${crcFmt(v)}</span></div>`).join('')
      : '<div class="empty">Todavía no hay gastos en este corte.</div>'}
    <div class="hint">Gasto en tarjetas, solo mi parte.</div>
  </div>

  <div class="card">
    <h2>Tarjetas</h2>
    ${r.tarjetas.filter(t => t.n).map(t => `
      <div class="plan-item">
        <div class="t"><b>${esc(t.nombre)}</b><b>${crcFmt(t.total)}</b></div>
        ${diaDe(t.nombre) !== A().diaCorte ? (() => { const ii = infoCorte(corte, diaDe(t.nombre));
          return `<div class="s"><span>Corta el día ${diaDe(t.nombre)} · compras del ${ii.desde} al ${ii.hasta}</span></div>`; })() : ''}
        <div class="bar">${t.total > 0 ? `<i style="width:${t.mi / t.total * 100}%"></i><i class="o" style="width:${t.otros / t.total * 100}%"></i>` : ''}</div>
        <div class="s"><span>Mi parte ${crcFmt(t.mi)} · otros ${crcFmt(t.otros)}</span><span>${t.usd ? usdFmt(t.usd) + ' en dólares' : ''}</span></div>
      </div>`).join('') || '<div class="empty">Sin cargos en este corte.</div>'}
    <div class="legend"><span style="--c:var(--blue)">Mi parte</span><span style="--c:var(--orange)">Otras personas</span></div>
  </div>

  ${r.otras.length ? `<div class="card"><h2>A cargo de otras personas</h2>
    ${r.otras.map(o => `<div class="row"><span class="l">${esc(o.nombre)}</span><span class="r">${crcFmt(o.total)}</span></div>`).join('')}
    <div class="hint">Lo que le toca a cada persona en las tarjetas (incluye cuotas) y en los gastos fijos.</div></div>` : ''}

  <div class="card">
    <h2>Mes a mes ${year} (mi parte en tarjetas)</h2>
    <div class="cols">${anual.map(x => `<div class="c ${x.c === corte ? 'sel' : ''}" title="${crcFmt(x.tot)}">
      <i style="height:${x.tot / maxA * 100}%"></i><small>${MESES[x.m - 1][0].toUpperCase()}</small></div>`).join('')}</div>
  </div>
  <div style="height:70px"></div>`;
}

function filtro(txt, mv) {
  if (!txt) return true;
  const t = txt.toLowerCase();
  return [mv.comercio, mv.cat, mv.tarjeta, mv.nota, mv.destino, mv.resp].some(x => String(x || '').toLowerCase().includes(t));
}
let busqueda = '';

function agrupar(items, render1) {
  const sorted = items.slice().sort((a, b) => (b.auto ? 1 : 0) - (a.auto ? 1 : 0) ||
    (b.fecha || '').localeCompare(a.fecha || '') || (b.creado || 0) - (a.creado || 0));
  let out = '', last = null;
  sorted.forEach(it => {
    const k = it.auto ? 'auto' : it.fecha || '';
    if (k !== last) {
      out += `<div class="day">${k === 'auto' ? 'Cuotas del mes (se cargan solas)' : k ? fechaLarga(k) : 'Sin fecha'}</div>`;
      last = k;
    }
    out += render1(it);
  });
  return out;
}

function vistaMovs() {
  const movs = movsDe(corte).filter(mv => filtro(busqueda, mv));
  const tot = movs.reduce((s, mv) => s + montoCRC(mv), 0);
  const mi = movs.reduce((s, mv) => s + parteYo(mv), 0);
  const suya = movs.reduce((s, mv) => s + parteDe(mv, pareja()), 0);
  const resto = tot - mi - suya;
  return `
  <input class="search" id="buscar" placeholder="Buscar comercio, categoría…" value="${esc(busqueda)}">
  <div class="card">
    <div class="row total"><span class="l">${movs.length} gastos en este corte</span><span class="r">${crcFmt(tot)}</span></div>
    <div class="row"><span class="l">Mi parte</span><span class="r">${crcFmt(mi)}</span></div>
    <div class="row"><span class="l">Parte de ${esc(pareja())}</span><span class="r">${crcFmt(suya)}</span></div>
    ${Math.abs(resto) > 0.5 ? `<div class="row"><span class="l">Otras personas</span><span class="r">${crcFmt(resto)}</span></div>` : ''}
    ${tot > 0 ? `<div class="bar"><i style="width:${mi / tot * 100}%"></i><i class="o" style="width:${suya / tot * 100}%"></i>${resto > 0.5 ? `<i class="a" style="width:${resto / tot * 100}%"></i>` : ''}</div>` : ''}
  </div>
  <div class="card">${movs.length ? agrupar(movs, mv => `
    <div class="list-item" data-mov="${mv.id}">
      <div class="m"><b>${esc(mv.comercio)}</b><small>${esc(mv.tarjeta)} · ${esc(mv.cat)}${mv.resp === 'Compartido' ? ` · compartido (${esc(pareja())} ${crcFmt(parteDe(mv, pareja()))})` : mv.resp !== yo() ? ' · ' + esc(mv.resp) : ''}${mv.cuota ? ` · cuota ${mv.cuota}${mv.cuotas ? '/' + mv.cuotas : ''}` : ''}</small></div>
      <div class="amt">${montoFmt(mv.monto, mv.moneda)}${mv.moneda === 'USD' ? `<small>${crcFmt(montoCRC(mv))}</small>` : ''}</div>
    </div>`) : '<div class="empty">No hay gastos en este corte.</div>'}</div>
  <div style="height:70px"></div>`;
}

function vistaPagos() {
  const ps = S.pagos.filter(p => cortePago(p) === corte && filtro(busqueda, p));
  const r = calcular(corte);
  return `
  <div class="card">
    <div class="row"><span class="l">Pagado en la 1ª quincena</span><span class="r">${crcFmt(r.totP1)}</span></div>
    <div class="row"><span class="l">Pagado en la 2ª quincena</span><span class="r">${crcFmt(r.totP2)}</span></div>
    <div class="row total"><span class="l">Pendiente</span><span class="r ${r.pendiente > 0.5 ? 'neg' : 'pos'}">${crcFmt(Math.max(0, r.pendiente))}</span></div>
  </div>
  <div class="card">${ps.length ? agrupar(ps, p => `
    <div class="list-item" data-pago="${p.id}">
      <div class="m"><b>${esc(p.destino)}</b><small>${quincena(p.fecha)}ª quincena${p.nota ? ' · ' + esc(p.nota) : ''}</small></div>
      <div class="amt">${montoFmt(p.monto, p.moneda)}</div>
    </div>`) : '<div class="empty">No hay pagos registrados para este corte.<br>Si paga en dos partes, registre cada abono por separado.</div>'}</div>
  <div style="height:70px"></div>`;
}

function vistaAjustes() {
  const a = A();
  const resp = S.ultimoRespaldo ? new Date(S.ultimoRespaldo).toLocaleDateString('es-CR') : 'nunca';
  return `
  <div class="card">
    <h2>Datos</h2>
    <button class="btn block p" data-act="excel">Exportar a Excel</button>
    <button class="btn block" data-act="respaldo">Guardar respaldo</button>
    <button class="btn block" data-act="importar">Importar respaldo</button>
    <div class="hint">Último respaldo: ${resp}. ${S.movimientos.length} gastos y ${S.pagos.length} pagos guardados en este teléfono.
    Guarde el respaldo en un lugar seguro: si borra los datos del navegador o pierde el teléfono, es la única copia.</div>
  </div>

  <div class="card">
    <h2>General</h2>
    <div class="two">
      <div class="field"><label>Tipo de cambio (₡ por $)</label><input id="aj-tc" inputmode="decimal" value="${a.tc}"></div>
      <div class="field"><label>Día de corte (general)</label><input id="aj-dia" inputmode="numeric" value="${a.diaCorte}"></div>
    </div>
    <div class="field"><label>Día de corte de cada tarjeta</label>
      <table class="mini-table">${a.tarjetas.map(t => `<tr><td>${esc(t)}</td>
        <td style="width:90px"><input data-corte="${esc(t)}" inputmode="numeric" value="${diaDe(t)}"></td></tr>`).join('')}</table>
      <div class="hint">Todas se pagan a fin del mes en que cortan.</div></div>
    <div class="field"><label>Mi parte en gastos compartidos (%)</label><input id="aj-split" inputmode="decimal" value="${Math.round(a.split * 100)}"></div>
  </div>

  <div class="card">
    <h2>Ingresos por quincena (₡)</h2>
    <table class="mini-table" id="aj-ing">
      <tr><td><small>Fuente</small></td><td><small>1ª</small></td><td><small>2ª</small></td><td></td></tr>
      ${a.ingresos.map((i, k) => `<tr data-k="${k}">
        <td><input data-f="fuente" value="${esc(i.fuente)}"></td>
        <td><input data-f="q1" inputmode="decimal" value="${i.q1 || 0}"></td>
        <td><input data-f="q2" inputmode="decimal" value="${i.q2 || 0}"></td>
        <td><button class="btn d" data-delIng="${k}" aria-label="Quitar">✕</button></td></tr>`).join('')}
    </table>
    <button class="btn block" data-act="addIng">+ Agregar ingreso</button>
  </div>

  <div class="card">
    <h2>Compras a cuotas y tasa cero</h2>
    <div class="hint">Cada una se carga sola en su tarjeta cada mes, hasta la última cuota.</div>
    ${(S.cuotas || []).slice().sort((x, y) => (x.tarjeta + x.descripcion).localeCompare(y.tarjeta + y.descripcion)).map(pl => {
      const k = cuotaEn(pl, corteInicial());
      const fin = ultimoCorte(pl);
      const estado = k === null ? (fin && mesesEntre(fin, corteInicial()) > 0 ? `terminó en ${fin}` : `empieza en ${pl.primerCorte}`)
        : k ? `cuota ${k}${pl.total ? ' de ' + pl.total : ''}${fin ? ' · termina ' + fin : ''}` : 'todos los meses';
      return `<div class="list-item" data-plan="${pl.id}">
        <div class="m"><b>${esc(pl.descripcion)}</b><small>${esc(pl.tarjeta)} · ${esc(pl.resp)} · ${estado}</small></div>
        <div class="amt">${montoFmt(pl.monto, pl.moneda)}<small>al mes</small></div></div>`;
    }).join('') || '<div class="empty">No hay compras a cuotas.</div>'}
    <button class="btn block" data-act="addCuota">+ Agregar compra a cuotas</button>
  </div>

  <div class="card">
    <h2>Gastos fijos mensuales</h2>
    ${a.fijos.map((f, k) => `<details class="fijo" data-k="${k}">
      <summary><span>${esc(f.concepto)}${f.variable ? ' <small class="hint">(varía)</small>' : ''}</span><span>${montoFmt(Number(f.montos[yo()]) || 0, f.moneda)}</span></summary>
      <div class="two">
        <div class="field"><label>Concepto</label><input data-f="concepto" value="${esc(f.concepto)}"></div>
        <div class="field"><label>Moneda</label><select data-f="moneda">
          <option ${f.moneda !== 'USD' ? 'selected' : ''}>CRC</option><option ${f.moneda === 'USD' ? 'selected' : ''}>USD</option></select></div>
      </div>
      <label class="hint" style="display:flex;gap:8px;align-items:center;margin:4px 0">
        <input type="checkbox" data-f="variable" ${f.variable ? 'checked' : ''} style="width:20px;height:20px">
        El monto cambia cada mes (recibo). Lo de abajo es el estimado.</label>
      <div class="two">${a.personas.map(p => `<div class="field"><label>${esc(p)}</label>
        <input data-p="${esc(p)}" inputmode="decimal" value="${Number(f.montos[p]) || 0}"></div>`).join('')}</div>
      <button class="btn d" data-delFijo="${k}">Quitar este gasto fijo</button>
    </details>`).join('')}
    <button class="btn block" data-act="addFijo">+ Agregar gasto fijo</button>
  </div>

  <div class="card">
    <h2>Listas</h2>
    <div class="hint">Al cambiar un nombre, también se cambia en todos los gastos y pagos que ya lo usan.</div>
    ${editorLista('tarjetas', 'Tarjetas')}
    ${editorLista('categorias', 'Categorías')}
    ${editorLista('personas', 'Personas (1ª = usted, 2ª = con quien comparte las tarjetas)')}
  </div>
  <button class="btn block p" data-act="guardarAj">Guardar ajustes</button>
  <button class="btn block d" data-act="borrar" style="width:100%">Borrar todos los datos</button>
  <div class="hint" style="text-align:center;margin:16px 0 40px">Mis Cuentas · los datos viven solo en este teléfono</div>`;
}

function bindVista() {
  document.querySelectorAll('[data-mov]').forEach(el => el.addEventListener('click', () => {
    const id = el.dataset.mov;
    if (id.startsWith('auto:')) return formCuota(S.cuotas.find(pl => pl.id === id.split(':')[1]));
    formGasto(S.movimientos.find(m => m.id === id));
  }));
  document.querySelectorAll('[data-recibo]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); formRecibo(el.dataset.recibo); }));
  document.querySelectorAll('[data-plan]').forEach(el => el.addEventListener('click', () => formCuota(S.cuotas.find(pl => pl.id === el.dataset.plan))));
  document.querySelectorAll('[data-pago]').forEach(el => el.addEventListener('click', () => formPago(S.pagos.find(p => p.id === el.dataset.pago))));
  document.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => document.querySelector(`nav.tabs [data-tab="${el.dataset.go}"]`).click()));
  document.querySelectorAll('[data-act]').forEach(el => el.addEventListener('click', () => acciones[el.dataset.act]()));
  document.querySelectorAll('[data-delIng],[data-deling]').forEach(el => el.addEventListener('click', () => {
    leerAjustes(); A().ingresos.splice(Number(el.dataset.deling), 1); save(); render();
  }));
  document.querySelectorAll('[data-delFijo],[data-delfijo]').forEach(el => el.addEventListener('click', () => {
    if (!confirm('¿Quitar este gasto fijo?')) return;
    leerAjustes(); A().fijos.splice(Number(el.dataset.delfijo), 1); save(); render();
  }));
  document.querySelectorAll('[data-agregar]').forEach(el => el.addEventListener('click', () => {
    const tipo = el.dataset.agregar;
    leerAjustes();
    const base = { tarjetas: 'Nueva tarjeta', categorias: 'Nueva categoría', personas: 'Nueva persona' }[tipo];
    let n = base, k = 2;
    while (A()[tipo].includes(n)) n = `${base} ${k++}`;
    A()[tipo].push(n);
    if (tipo === 'personas') A().fijos.forEach(f => { f.montos[n] = 0; });
    save(); render();
    const inp = document.querySelector(`[data-lista="${tipo}"] input[data-i="${A()[tipo].length - 1}"]`);
    if (inp) { inp.focus(); inp.select(); }
    toast('Escriba el nombre y toque "Guardar ajustes"');
  }));
  document.querySelectorAll('[data-quitar]').forEach(el => el.addEventListener('click', () => {
    leerAjustes();
    const [tipo, i] = el.dataset.quitar.split(':');
    const lista = A()[tipo];
    if (lista.length <= 1) return toast('Debe quedar al menos uno');
    const nombre = lista[Number(i)];
    const n = usos(tipo, nombre);
    if (tipo === 'categorias' && n) {
      const destino = lista.includes('Otros') && nombre !== 'Otros' ? 'Otros' : lista.find(x => x !== nombre);
      if (!confirm(`${n} gastos usan "${nombre}". Pasarán a "${destino}". ¿Quitarla?`)) return;
      renombrar('categorias', nombre, destino);
    } else if (n) {
      if (!confirm(`"${nombre}" se usa en ${n} registros, que conservarán ese nombre. ¿Quitarlo de la lista?`)) return;
    } else if (!confirm(`¿Quitar "${nombre}"?`)) return;
    A()[tipo] = [...new Set(A()[tipo].filter(x => x !== nombre))];
    save(); render();
  }));
  const b = $('#buscar');
  if (b) b.addEventListener('input', () => {
    busqueda = b.value;
    const pos = b.selectionStart;
    render();
    const nb = $('#buscar'); nb.focus(); nb.setSelectionRange(pos, pos);
  });
}

function leerAjustes() {
  const a = A();
  if (!$('#aj-tc')) return;
  const tc = parseMonto($('#aj-tc').value); if (tc > 0) a.tc = tc;
  const dia = parseInt($('#aj-dia').value, 10); if (dia >= 1 && dia <= 28) a.diaCorte = dia;
  a.cortes = {};
  document.querySelectorAll('[data-corte]').forEach(inp => {
    const v = parseInt(inp.value, 10);
    if (v >= 1 && v <= 28 && v !== a.diaCorte) a.cortes[inp.dataset.corte] = v;
  });
  const sp = parseMonto($('#aj-split').value); if (sp >= 0 && sp <= 100) a.split = sp / 100;
  document.querySelectorAll('#aj-ing tr[data-k]').forEach(tr => {
    const i = a.ingresos[Number(tr.dataset.k)];
    i.fuente = tr.querySelector('[data-f=fuente]').value.trim();
    i.q1 = parseMonto(tr.querySelector('[data-f=q1]').value) || 0;
    i.q2 = parseMonto(tr.querySelector('[data-f=q2]').value) || 0;
  });
  document.querySelectorAll('details.fijo').forEach(d => {
    const f = a.fijos[Number(d.dataset.k)];
    const nuevoC = d.querySelector('[data-f=concepto]').value.trim() || f.concepto;
    if (nuevoC !== f.concepto) {
      S.pagos.forEach(p => { if (p.destino === f.concepto) p.destino = nuevoC; });
      Object.values(S.recibos || {}).forEach(m => { if (f.concepto in m) { m[nuevoC] = m[f.concepto]; delete m[f.concepto]; } });
    }
    f.concepto = nuevoC;
    f.moneda = d.querySelector('[data-f=moneda]').value;
    f.variable = d.querySelector('[data-f=variable]').checked;
    d.querySelectorAll('[data-p]').forEach(inp => { f.montos[inp.dataset.p] = parseMonto(inp.value) || 0; });
  });
  document.querySelectorAll('[data-lista]').forEach(box => {
    const tipo = box.dataset.lista;
    box.querySelectorAll('input[data-i]').forEach(inp => {
      const viejo = a[tipo][Number(inp.dataset.i)];
      const nuevo = inp.value.trim();
      if (nuevo && nuevo !== viejo) renombrar(tipo, viejo, nuevo);
    });
    a[tipo] = [...new Set(a[tipo])];
  });
}

function usos(tipo, nombre) {
  const todo = [...S.movimientos, ...S.cuotas];
  if (tipo === 'categorias') return todo.filter(m => m.cat === nombre).length;
  if (tipo === 'tarjetas') return todo.filter(m => m.tarjeta === nombre).length + S.pagos.filter(p => p.destino === nombre).length;
  return todo.filter(m => m.resp === nombre).length +
    A().fijos.filter(f => Number(f.montos[nombre]) > 0).length;
}

// Cambia un nombre en la lista y en todo lo que ya lo usa.
function renombrar(tipo, viejo, nuevo) {
  const a = A();
  a[tipo] = a[tipo].map(x => (x === viejo ? nuevo : x));
  if (tipo === 'categorias') [...S.movimientos, ...S.cuotas].forEach(m => { if (m.cat === viejo) m.cat = nuevo; });
  if (tipo === 'tarjetas') {
    if (a.cortes && viejo in a.cortes) { a.cortes[nuevo] = a.cortes[viejo]; delete a.cortes[viejo]; }
    [...S.movimientos, ...S.cuotas].forEach(m => { if (m.tarjeta === viejo) m.tarjeta = nuevo; });
    S.pagos.forEach(p => { if (p.destino === viejo) p.destino = nuevo; });
  }
  if (tipo === 'personas') {
    [...S.movimientos, ...S.cuotas].forEach(m => { if (m.resp === viejo) m.resp = nuevo; });
    a.fijos.forEach(f => {
      if (viejo in f.montos) {
        f.montos[nuevo] = (Number(f.montos[nuevo]) || 0) + (Number(f.montos[viejo]) || 0);
        delete f.montos[viejo];
      }
    });
  }
}

function editorLista(tipo, titulo) {
  const items = A()[tipo];
  const fijas = tipo === 'personas' ? 2 : 1; // no se pueden quitar: usted y su pareja / al menos una
  return `<div class="field" data-lista="${tipo}"><label>${esc(titulo)}</label>
    <table class="mini-table">${items.map((x, i) => `<tr>
      <td><input data-i="${i}" value="${esc(x)}"></td>
      <td style="width:52px">${i < fijas && tipo === 'personas' ? '' : `<button class="btn d" data-quitar="${tipo}:${i}" aria-label="Quitar">✕</button>`}</td>
    </tr>`).join('')}</table>
    <button class="btn block" data-agregar="${tipo}">+ Agregar</button></div>`;
}

// ---------- formularios ----------
function abrirSheet(html) {
  $('#sheet').innerHTML = '<div class="grab"></div>' + html;
  $('#sheetBg').classList.add('open');
  $('#sheet').classList.add('open');
}
function cerrarSheet() {
  $('#sheetBg').classList.remove('open');
  $('#sheet').classList.remove('open');
}
$('#sheetBg').addEventListener('click', cerrarSheet);

function seg(name, opts, val) {
  return `<div class="seg" data-seg="${name}">${opts.map(o => `<button type="button" data-v="${esc(o)}" class="${o === val ? 'on' : ''}">${esc(o)}</button>`).join('')}</div>`;
}
function bindSegs(onChange) {
  document.querySelectorAll('#sheet [data-seg]').forEach(g => g.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    g.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (onChange) onChange(g.dataset.seg, b.dataset.v);
  })));
}
const segVal = name => { const b = document.querySelector(`#sheet [data-seg="${name}"] button.on`); return b ? b.dataset.v : ''; };

function opcionesCorte(sel) {
  const set = new Set([...S.movimientos.map(corteMov), ...S.pagos.map(cortePago), corte, sumarMes(corte, -1), sumarMes(corte, 1)]);
  return ['', ...[...set].filter(Boolean).sort()].map(c => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c || 'Automático (según la fecha)'}</option>`).join('');
}

// comercios usados antes -> sugiere categoría y tarjeta
function memoriaComercios() {
  const m = new Map();
  S.movimientos.slice().sort((a, b) => (a.creado || 0) - (b.creado || 0) || (a.fecha || '').localeCompare(b.fecha || ''))
    .forEach(mv => m.set(mv.comercio.trim().toUpperCase(), mv));
  return m;
}

function formGasto(mv) {
  const nuevo = !mv;
  const ult = S.movimientos.slice().sort((a, b) => (b.creado || 0) - (a.creado || 0))[0];
  mv = mv || { fecha: hoyISO(), tarjeta: (ult && ult.tarjeta) || A().tarjetas[0], moneda: 'CRC', resp: yo(), cat: '', comercio: '', monto: '', cuota: null, cuotas: null, mesManual: '', nota: '' };
  const mem = memoriaComercios();
  const comercios = [...new Set(S.movimientos.map(m => m.comercio))].sort();
  abrirSheet(`
    <h3>${nuevo ? 'Nuevo gasto' : 'Editar gasto'}</h3>
    <div class="amount">
      <input id="g-monto" inputmode="decimal" placeholder="0" value="${mv.monto === '' ? '' : mv.monto}" autocomplete="off">
      ${seg('moneda', ['₡', '$'], mv.moneda === 'USD' ? '$' : '₡')}
    </div>
    <div class="field"><label>Tarjeta</label>${seg('tarjeta', A().tarjetas, mv.tarjeta)}</div>
    <div class="field"><label>Comercio</label>
      <input id="g-com" list="g-coms" value="${esc(mv.comercio)}" placeholder="Ej. Walmart" autocomplete="off">
      <datalist id="g-coms">${comercios.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    <div class="field"><label>Categoría</label><select id="g-cat">
      <option value="">— elegir —</option>
      ${A().categorias.map(c => `<option ${c === mv.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      ${mv.cat && !A().categorias.includes(mv.cat) ? `<option selected>${esc(mv.cat)}</option>` : ''}
    </select></div>
    <div class="field"><label>¿De quién es?</label>${seg('resp', RESP(), mv.resp)}</div>
    <div class="field"><label>Fecha</label><input id="g-fecha" type="date" value="${mv.fecha || ''}"></div>
    <div class="hint" id="g-corte"></div>
    <details class="more" ${mv.cuota || mv.mesManual || mv.nota ? 'open' : ''}><summary>Más opciones</summary>
      <div class="two">
        <div class="field"><label>Cuota #</label><input id="g-cuota" inputmode="numeric" value="${mv.cuota || ''}"></div>
        <div class="field"><label>De (total cuotas)</label><input id="g-cuotas" inputmode="numeric" value="${mv.cuotas || ''}"></div>
      </div>
      ${nuevo ? `<label class="hint" style="display:flex;gap:8px;align-items:center;margin:4px 0 8px">
        <input type="checkbox" id="g-rep" checked style="width:20px;height:20px"> Si pone cuotas, cargar sola cada mes hasta la última</label>` : ''}
      <div class="field"><label>Mes del corte (si el banco lo puso en otro)</label><select id="g-mes">${opcionesCorte(mv.mesManual)}</select></div>
      <div class="field"><label>Nota</label><input id="g-nota" value="${esc(mv.nota)}"></div>
    </details>
    <div class="actions">
      ${nuevo ? '' : '<button class="btn d" id="g-del">Eliminar</button>'}
      <button class="btn" id="g-cancel">Cancelar</button>
      <button class="btn p" id="g-ok">Guardar</button>
    </div>`);
  bindSegs(() => upd());
  const upd = () => {
    const t = segVal('tarjeta');
    const c = $('#g-mes').value || corteDeFecha($('#g-fecha').value, diaDe(t));
    $('#g-corte').textContent = c ? `Va al corte ${c} de ${t} · se paga a más tardar el ${infoCorte(c).limite}` : 'Sin fecha: elija el mes del corte en "Más opciones".';
  };
  $('#g-fecha').addEventListener('change', upd);
  $('#g-mes').addEventListener('change', upd);
  upd();
  $('#g-com').addEventListener('change', () => {
    const prev = mem.get($('#g-com').value.trim().toUpperCase());
    if (prev && !$('#g-cat').value) $('#g-cat').value = prev.cat;
  });
  $('#g-cancel').addEventListener('click', cerrarSheet);
  if (!nuevo) $('#g-del').addEventListener('click', () => {
    if (!confirm('¿Eliminar este gasto?')) return;
    S.movimientos = S.movimientos.filter(x => x.id !== mv.id);
    save(); cerrarSheet(); render(); toast('Gasto eliminado');
  });
  $('#g-ok').addEventListener('click', () => {
    const monto = parseMonto($('#g-monto').value);
    if (!(monto > 0) && !(monto < 0)) return toast('Escriba el monto');
    const comercio = $('#g-com').value.trim();
    if (!comercio) return toast('Escriba el comercio');
    const fecha = $('#g-fecha').value;
    const mesManual = $('#g-mes').value;
    if (!fecha && !mesManual) return toast('Ponga la fecha o el mes del corte');
    const cat = $('#g-cat').value || (mem.get(comercio.toUpperCase()) || {}).cat || 'Otros';
    const datos = {
      fecha, tarjeta: segVal('tarjeta'), comercio, moneda: segVal('moneda') === '$' ? 'USD' : 'CRC', monto,
      resp: segVal('resp'), cat, cuota: parseInt($('#g-cuota').value, 10) || null, cuotas: parseInt($('#g-cuotas').value, 10) || null,
      mesManual, nota: $('#g-nota').value.trim()
    };
    const c = corteMov(datos);
    if (nuevo && datos.cuota && datos.cuotas && $('#g-rep') && $('#g-rep').checked) {
      S.cuotas.push({ id: uid(), tarjeta: datos.tarjeta, descripcion: comercio, resp: datos.resp, cat, moneda: datos.moneda,
        monto, primerCorte: c, cuotaInicial: datos.cuota, total: datos.cuotas });
      save(); cerrarSheet();
      if (c !== corte) corte = c;
      render();
      return toast(`Compra a cuotas guardada: se cargará sola hasta ${sumarMes(c, datos.cuotas - datos.cuota)}`);
    }
    if (nuevo) S.movimientos.push(Object.assign({ id: uid(), creado: Date.now() }, datos));
    else Object.assign(mv, datos);
    save(); cerrarSheet();
    if (c && c !== corte && nuevo) corte = c;
    render();
    toast(nuevo ? `Guardado en el corte ${c}` : 'Cambios guardados');
  });
  if (nuevo) setTimeout(() => $('#g-monto').focus(), 250);
}

function formCuota(pl) {
  const nuevo = !pl;
  pl = pl || { tarjeta: A().tarjetas[0], descripcion: '', resp: yo(), cat: 'Compras', moneda: 'CRC', monto: '',
    primerCorte: corte, cuotaInicial: null, total: null };
  const kHoy = nuevo ? null : cuotaEn(pl, corte);
  abrirSheet(`
    <h3>${nuevo ? 'Nueva compra a cuotas' : 'Compra a cuotas'}</h3>
    <div class="hint" style="margin-bottom:8px">Monto de la cuota mensual. Se carga sola cada mes en la tarjeta.</div>
    <div class="amount">
      <input id="c-monto" inputmode="decimal" placeholder="0" value="${pl.monto === '' ? '' : pl.monto}" autocomplete="off">
      ${seg('moneda', ['₡', '$'], pl.moneda === 'USD' ? '$' : '₡')}
    </div>
    <div class="field"><label>Tarjeta</label>${seg('tarjeta', A().tarjetas, pl.tarjeta)}</div>
    <div class="field"><label>Descripción</label><input id="c-desc" value="${esc(pl.descripcion)}" placeholder="Ej. Tasa cero refrigeradora"></div>
    <div class="field"><label>¿De quién es?</label>${seg('resp', RESP(), pl.resp)}</div>
    <div class="field"><label>Categoría</label><select id="c-cat">
      ${A().categorias.map(c => `<option ${c === pl.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      ${pl.cat && !A().categorias.includes(pl.cat) ? `<option selected>${esc(pl.cat)}</option>` : ''}
    </select></div>
    <div class="field"><label>En el corte</label><select id="c-corte">${opcionesCorte(corte).replace('<option value="" ', '<option value="" disabled ')}</select></div>
    <div class="two">
      <div class="field"><label>va la cuota #</label><input id="c-k" inputmode="numeric" value="${kHoy || (nuevo ? '' : '')}" placeholder="?"></div>
      <div class="field"><label>de (total)</label><input id="c-tot" inputmode="numeric" value="${pl.total || ''}" placeholder="?"></div>
    </div>
    <div class="hint" id="c-info"></div>
    <div class="actions">
      ${nuevo ? '' : '<button class="btn d" id="c-del">Eliminar</button>'}
      <button class="btn" id="c-cancel">Cancelar</button>
      <button class="btn p" id="c-ok">Guardar</button>
    </div>`);
  bindSegs();
  const sel = $('#c-corte');
  if (!sel.value) sel.value = corte;
  const info = () => {
    const k = parseInt($('#c-k').value, 10), t = parseInt($('#c-tot').value, 10);
    $('#c-info').textContent = k && t ? (k > t ? 'La cuota no puede ser mayor que el total.' : `Termina en el corte ${sumarMes(sel.value, t - k)}.`)
      : 'Si no sabe el número de cuota, déjelo vacío: se cargará todos los meses hasta que la elimine.';
  };
  ['#c-k', '#c-tot'].forEach(id => $(id).addEventListener('input', info));
  sel.addEventListener('change', info);
  info();
  $('#c-cancel').addEventListener('click', cerrarSheet);
  if (!nuevo) $('#c-del').addEventListener('click', () => {
    if (!confirm('¿Eliminar esta compra a cuotas? Desaparecen también sus cuotas de los meses anteriores.')) return;
    S.cuotas = S.cuotas.filter(x => x.id !== pl.id);
    save(); cerrarSheet(); render(); toast('Compra a cuotas eliminada');
  });
  $('#c-ok').addEventListener('click', () => {
    const monto = parseMonto($('#c-monto').value);
    if (!(monto > 0)) return toast('Escriba el monto de la cuota');
    const descripcion = $('#c-desc').value.trim();
    if (!descripcion) return toast('Escriba una descripción');
    const k = parseInt($('#c-k').value, 10) || null, t = parseInt($('#c-tot').value, 10) || null;
    if (k && t && k > t) return toast('La cuota no puede ser mayor que el total');
    if (t && !k) return toast('Ponga también el número de cuota');
    const c = sel.value;
    const datos = { tarjeta: segVal('tarjeta'), descripcion, resp: segVal('resp'), cat: $('#c-cat').value,
      moneda: segVal('moneda') === '$' ? 'USD' : 'CRC', monto, cuotaInicial: k, total: t };
    if (nuevo) {
      S.cuotas.push(Object.assign({ id: uid(), primerCorte: c }, datos));
    } else {
      // Mantiene los meses anteriores: si cambia la cuota de este corte, se recalcula el inicio.
      const n = mesesEntre(pl.primerCorte, c);
      datos.primerCorte = n >= 0 ? pl.primerCorte : c;
      if (k) {
        datos.cuotaInicial = n >= 0 ? k - n : k;
        if (datos.cuotaInicial < 1) { datos.primerCorte = sumarMes(c, 1 - k); datos.cuotaInicial = 1; }
      }
      Object.assign(pl, datos);
    }
    save(); cerrarSheet(); render(); toast('Compra a cuotas guardada');
  });
  if (nuevo) setTimeout(() => $('#c-monto').focus(), 250);
}

function formRecibo(concepto, c = corte) {
  const f = A().fijos.find(x => x.concepto === concepto);
  if (!f) return;
  const actual = recibo(c, concepto);
  abrirSheet(`
    <h3>Recibo de ${esc(concepto)}</h3>
    <div class="hint" style="margin-bottom:8px">Monto real del recibo para el corte ${c} (${esc(infoCorte(c).nombre)}).
      Estimado: ${montoFmt(Number(f.montos[yo()]) || 0, f.moneda)}.</div>
    <div class="amount"><input id="r-monto" inputmode="decimal" placeholder="0" value="${actual !== undefined ? actual : ''}" autocomplete="off">
      <span class="pill blue">${f.moneda === 'USD' ? '$' : '₡'}</span></div>
    <div class="actions">
      ${actual !== undefined ? '<button class="btn d" id="r-del">Usar estimado</button>' : ''}
      <button class="btn" id="r-cancel">Cancelar</button>
      <button class="btn p" id="r-ok">Guardar</button>
    </div>`);
  $('#r-cancel').addEventListener('click', cerrarSheet);
  if (actual !== undefined) $('#r-del').addEventListener('click', () => {
    delete S.recibos[c][concepto];
    save(); cerrarSheet(); render(); toast('Se usará el monto estimado');
  });
  $('#r-ok').addEventListener('click', () => {
    const v = parseMonto($('#r-monto').value);
    if (!(v >= 0)) return toast('Escriba el monto del recibo');
    S.recibos = S.recibos || {};
    (S.recibos[c] = S.recibos[c] || {})[concepto] = v;
    save(); cerrarSheet(); render(); toast(`Recibo de ${concepto} guardado`);
  });
  setTimeout(() => $('#r-monto').focus(), 250);
}

function formPago(p) {
  const nuevo = !p;
  const destinos = [...A().tarjetas, ...A().fijos.map(f => f.concepto), 'Otro'];
  p = p || { fecha: hoyISO(), destino: A().tarjetas[0], moneda: 'CRC', monto: '', mesManual: '', nota: '' };
  const r = calcular(corte);
  abrirSheet(`
    <h3>${nuevo ? 'Nuevo pago' : 'Editar pago'}</h3>
    <div class="amount">
      <input id="p-monto" inputmode="decimal" placeholder="0" value="${p.monto === '' ? '' : p.monto}" autocomplete="off">
      ${seg('moneda', ['₡', '$'], p.moneda === 'USD' ? '$' : '₡')}
    </div>
    <div class="field"><label>¿Qué pagó?</label>${seg('destino', destinos, p.destino)}</div>
    <div class="hint" id="p-falta"></div>
    <label class="hint hidden" id="p-rec-box" style="display:flex;gap:8px;align-items:center;margin:8px 0">
      <input type="checkbox" id="p-rec" checked style="width:20px;height:20px"> Este es el monto del recibo de este mes</label>
    <div class="field"><label>Fecha del pago</label><input id="p-fecha" type="date" value="${p.fecha || ''}"></div>
    <div class="hint" id="p-info"></div>
    <details class="more" ${p.mesManual || p.nota ? 'open' : ''}><summary>Más opciones</summary>
      <div class="field"><label>Corte que está pagando</label><select id="p-mes">${opcionesCorte(p.mesManual)}</select></div>
      <div class="field"><label>Nota</label><input id="p-nota" value="${esc(p.nota)}"></div>
    </details>
    <div class="actions">
      ${nuevo ? '' : '<button class="btn d" id="p-del">Eliminar</button>'}
      <button class="btn" id="p-cancel">Cancelar</button>
      <button class="btn p" id="p-ok">Guardar</button>
    </div>`);
  const updFalta = () => {
    const c = $('#p-mes').value || ($('#p-fecha').value || '').slice(0, 7);
    const rr = c === corte ? r : calcular(c);
    const fila = rr.plan.find(x => x.dest === segVal('destino'));
    $('#p-falta').textContent = fila && fila.tipo !== 'otro' ? `De ${fila.dest} falta pagar ${crcFmt(Math.max(0, fila.pend))} del corte ${c}.` : '';
    const fx = A().fijos.find(x => x.concepto === segVal('destino'));
    $('#p-rec-box').classList.toggle('hidden', !(nuevo && fx && fx.variable && c && recibo(c, fx.concepto) === undefined));
    const f = $('#p-fecha').value;
    $('#p-info').textContent = f ? `Cuenta como pago de la ${quincena(f)}ª quincena, corte ${c}.` : '';
  };
  bindSegs(updFalta);
  $('#p-fecha').addEventListener('change', updFalta);
  $('#p-mes').addEventListener('change', updFalta);
  updFalta();
  $('#p-cancel').addEventListener('click', cerrarSheet);
  if (!nuevo) $('#p-del').addEventListener('click', () => {
    if (!confirm('¿Eliminar este pago?')) return;
    S.pagos = S.pagos.filter(x => x.id !== p.id);
    save(); cerrarSheet(); render(); toast('Pago eliminado');
  });
  $('#p-ok').addEventListener('click', () => {
    const monto = parseMonto($('#p-monto').value);
    if (!(monto > 0)) return toast('Escriba el monto');
    const fecha = $('#p-fecha').value;
    if (!fecha) return toast('Ponga la fecha del pago');
    const datos = { fecha, destino: segVal('destino'), moneda: segVal('moneda') === '$' ? 'USD' : 'CRC', monto,
      mesManual: $('#p-mes').value, nota: $('#p-nota').value.trim() };
    if (nuevo) S.pagos.push(Object.assign({ id: uid(), creado: Date.now() }, datos));
    else Object.assign(p, datos);
    const c = cortePago(datos);
    if (!$('#p-rec-box').classList.contains('hidden') && $('#p-rec').checked) {
      S.recibos = S.recibos || {};
      const fx = A().fijos.find(x => x.concepto === datos.destino);
      const enMonedaFijo = datos.moneda === fx.moneda ? datos.monto
        : datos.moneda === 'USD' ? datos.monto * A().tc : datos.monto / A().tc;
      (S.recibos[c] = S.recibos[c] || {})[datos.destino] = enMonedaFijo;
    }
    save(); cerrarSheet();
    if (nuevo && c !== corte) corte = c;
    render(); toast('Pago guardado');
  });
  if (nuevo) setTimeout(() => $('#p-monto').focus(), 250);
}

// ---------- acciones ----------
const acciones = {
  gasto: () => formGasto(),
  addCuota: () => formCuota(),
  pago: () => formPago(),
  addIng: () => { leerAjustes(); A().ingresos.push({ fuente: 'Nuevo ingreso', q1: 0, q2: 0 }); save(); render(); },
  addFijo: () => {
    leerAjustes();
    const montos = {}; A().personas.forEach(p => { montos[p] = 0; });
    A().fijos.push({ concepto: 'Nuevo gasto', moneda: 'CRC', montos });
    save(); render();
    const all = document.querySelectorAll('details.fijo'); if (all.length) all[all.length - 1].open = true;
  },
  guardarAj: () => { leerAjustes(); save(); render(); toast('Ajustes guardados'); },
  respaldo: () => {
    const fecha = hoyISO();
    descargar(new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' }), `respaldo-cuentas-${fecha}.json`);
    S.ultimoRespaldo = Date.now(); S.cambiosDesdeRespaldo = 0; save(false); render();
  },
  importar: () => $('#fileIn').click(),
  excel: () => {
    descargar(crearExcel(), `cuentas-${hoyISO()}.xlsx`);
  },
  borrar: () => {
    if (!confirm('¿Borrar TODOS los datos de este teléfono? Esto no se puede deshacer.')) return;
    if (!confirm('¿Seguro? Asegúrese de tener un respaldo.')) return;
    S = defaults(); save(false); corte = corteInicial(); render(); toast('Datos borrados');
  }
};

$('#fileIn').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!d || !Array.isArray(d.movimientos) || !d.ajustes) throw new Error('El archivo no es un respaldo de Mis Cuentas.');
    const msg = `Este respaldo tiene ${d.movimientos.length} gastos, ${(d.cuotas || []).length} compras a cuotas y ${(d.pagos || []).length} pagos.\n` +
      (S.movimientos.length || S.pagos.length ? 'Va a REEMPLAZAR los datos actuales de este teléfono. ¿Continuar?' : '¿Cargarlo?');
    if (!confirm(msg)) return;
    const nuevo = Object.assign(defaults(), d, { ajustes: Object.assign(defaults().ajustes, d.ajustes) });
    nuevo.movimientos.forEach((m, i) => { m.id = m.id || uid(); m.creado = m.creado || i; m.monto = Number(m.monto); });
    nuevo.pagos = (nuevo.pagos || []).map(p => Object.assign(p, { id: p.id || uid(), monto: Number(p.monto) }));
    nuevo.recibos = nuevo.recibos || {};
    nuevo.cuotas = (nuevo.cuotas || []).map(pl => Object.assign(pl, { id: pl.id || uid(), monto: Number(pl.monto) }));
    nuevo.ultimoRespaldo = Date.now(); nuevo.cambiosDesdeRespaldo = 0;
    S = nuevo; save(false); corte = corteInicial(); render();
    toast('Datos cargados');
  } catch (err) {
    alert('No se pudo importar: ' + err.message);
  }
});

function descargar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Archivo descargado: ' + nombre);
}

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- Excel (.xlsx) sin librerías ----------
// Columnas iguales a las hojas Movimientos (A–P) y Pagos (A–I) de cuentas_2026.xlsx.
function crearExcel() {
  const serial = iso => { if (!iso) return null; const { y, m, d } = parseISO(iso); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000; };
  const hasta = sumarMes(corteInicial(), 1);
  const autos = [];
  (S.cuotas || []).forEach(pl => {
    for (let c = pl.primerCorte; mesesEntre(c, hasta) >= 0; c = sumarMes(c, 1)) {
      autos.push(...movsAuto(c).filter(m => m.planId === pl.id));
    }
  });
  const movs = S.movimientos.concat(autos).sort((a, b) => corteMov(a).localeCompare(corteMov(b)) || (a.fecha || '').localeCompare(b.fecha || ''));
  const hojaM = [
    ['Mes (corte)', 'Fecha', 'Tarjeta', 'Comercio', 'Moneda', 'Monto', 'Responsable', 'Categoría', 'Cuota #', 'De (cuotas)',
      'Monto en ₡', 'Mi parte ₡', 'Parte otros ₡', 'Cuotas restantes', 'Nota', 'Mes manual (opcional)'],
    ...movs.map(m => [corteMov(m), { d: serial(m.fecha) }, m.tarjeta, m.comercio, m.moneda, m.monto, m.resp, m.cat,
      m.cuota, m.cuotas, montoCRC(m), parteYo(m), montoCRC(m) - parteYo(m),
      m.cuota && m.cuotas ? m.cuotas - m.cuota : null, m.nota, m.mesManual])
  ];
  const pagos = S.pagos.slice().sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
  const hojaP = [
    ['Fecha', 'Destino', 'Moneda', 'Monto', 'Mes manual (opcional)', 'Nota', 'Mes (corte)', 'Quincena', 'Monto en ₡'],
    ...pagos.map(p => [{ d: serial(p.fecha) }, p.destino, p.moneda, p.monto, p.mesManual, p.nota, cortePago(p),
      quincena(p.fecha) + 'ª', enColones(p.monto, p.moneda)])
  ];
  const hojaR = [['Mes (corte)', 'Concepto', 'Monto del recibo'],
    ...Object.keys(S.recibos || {}).sort().flatMap(c => Object.entries(S.recibos[c]).map(([k, v]) => [c, k, Number(v)]))];
  const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const colL = i => { let s = ''; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
  const sheet = rows => {
    const body = rows.map((row, ri) => `<row r="${ri + 1}">${row.map((v, ci) => {
      const ref = colL(ci) + (ri + 1);
      if (v === null || v === undefined || v === '') return '';
      if (typeof v === 'object') return v.d === null ? '' : `<c r="${ref}" s="1"><v>${v.d}</v></c>`;
      if (typeof v === 'number') return `<c r="${ref}"${ri ? ' s="3"' : ''}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${ri ? '' : ' s="2"'}><is><t>${xmlEsc(v)}</t></is></c>`;
    }).join('')}</row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="3" width="12" customWidth="1"/><col min="4" max="4" width="38" customWidth="1"/><col min="5" max="16" width="13" customWidth="1"/></cols><sheetData>${body}</sheetData></worksheet>`;
  };
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Movimientos" sheetId="1" r:id="rId1"/><sheet name="Pagos" sheetId="2" r:id="rId2"/><sheet name="Recibos" sheetId="3" r:id="rId4"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/></Relationships>',
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': sheet(hojaM),
    'xl/worksheets/sheet2.xml': sheet(hojaP),
    'xl/worksheets/sheet3.xml': sheet(hojaR)
  };
  return new Blob([zip(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ZIP sin compresión (suficiente para un .xlsx)
function zip(files) {
  const enc = new TextEncoder();
  const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nb = enc.encode(name), data = enc.encode(content), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), nb, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nb);
    offset += 30 + nb.length + data.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const n = Object.keys(files).length;
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, n, true); e.setUint16(10, n, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)]);
}

// ---------- inicio ----------
render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
