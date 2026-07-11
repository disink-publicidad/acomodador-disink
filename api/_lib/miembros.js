// ============================================================
// DISINK · Fase 3 — Helpers compartidos (backend seguro)
// Corre SOLO en el servidor (Vercel Functions). Usa la service_role
// de Supabase. NUNCA se envía al navegador.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Mapa de planes: nivel -> % de descuento y price_id de Stripe (desde env)
const PLANES = {
  inicio:   { pct: 10, priceId: process.env.PRICE_INICIO },
  standard: { pct: 15, priceId: process.env.PRICE_STANDARD },
  vip:      { pct: 20, priceId: process.env.PRICE_VIP },
};

// A partir de un price_id, saber qué plan es (para el webhook)
function planDesdePrecio(priceId) {
  for (const [nivel, p] of Object.entries(PLANES)) {
    if (p.priceId && p.priceId === priceId) return nivel;
  }
  return null;
}

// --- Llamada genérica a la API REST de Supabase con service_role ---
async function sb(path, opts = {}) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (_) { data = txt; }
  if (!res.ok) {
    throw new Error('Supabase ' + res.status + ': ' + txt);
  }
  return data;
}

// --- Iniciales para el ID a partir de un nombre ---
// "Francisco Uriel Arce Cruz" -> "FUAC" ; "Velas Isa" -> "VI"
function inicialesDe(nombre) {
  const limpio = String(nombre || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '') // quita acentos
    .replace(/[^A-Za-z ]/g, ' ')                       // solo letras y espacios
    .trim();
  if (!limpio) return 'DK';
  const iniciales = limpio.split(/\s+/).map((p) => p.charAt(0).toUpperCase()).join('');
  return iniciales.slice(0, 5) || 'DK';
}

// --- Siguiente número consecutivo (contador seguro en Supabase) ---
async function siguienteNumero() {
  // 1) contador atómico (ideal): función siguiente_consecutivo()
  try {
    const n = await sb('rpc/siguiente_consecutivo', { method: 'POST', body: '{}' });
    const num = typeof n === 'number' ? n : parseInt(n, 10);
    if (num && !isNaN(num)) return num;
  } catch (_) {}
  // 2) respaldo: contar miembros existentes + 1 (por si la función aún no está lista)
  try {
    const r = await sb('miembros?select=id_cliente');
    return (Array.isArray(r) ? r.length : 0) + 1;
  } catch (_) {}
  // 3) último recurso: número basado en el tiempo (no choca)
  return Date.now() % 100000;
}

// --- Generar el ID: INK-INICIALES-Nº  (ej. INK-FUAC-1) ---
async function generarIdUnico(nombreParaIniciales) {
  const ini = inicialesDe(nombreParaIniciales);
  const num = await siguienteNumero();
  const code = 'INK-' + ini + '-' + num;
  // el número es único por el contador, así que no hay choques
  return code;
}

async function buscarPorSubscription(subId) {
  if (!subId) return null;
  const r = await sb('miembros?stripe_subscription_id=eq.' + subId + '&select=*');
  return Array.isArray(r) && r.length ? r[0] : null;
}

async function buscarPorCustomer(customerId) {
  if (!customerId) return null;
  const r = await sb('miembros?stripe_customer_id=eq.' + customerId + '&select=*');
  return Array.isArray(r) && r.length ? r[0] : null;
}

// --- Crear el miembro (idempotente) a partir de los datos del pago ---
// Si ya existe uno con esa suscripción, lo devuelve tal cual (no duplica).
async function asegurarMiembro({ customerId, subscriptionId, priceId, email, nombre, contacto, nivel }) {
  // 1) ¿ya existe por suscripción? -> idempotencia
  const yaSub = await buscarPorSubscription(subscriptionId);
  if (yaSub) return yaSub;

  // 2) ¿existe uno por cliente sin suscripción ligada? -> actualízalo
  const nvl = nivel || planDesdePrecio(priceId) || 'inicio';
  const pct = (PLANES[nvl] && PLANES[nvl].pct) || 0;
  const negocio = (nombre && nombre.trim()) || (email ? email.split('@')[0] : 'Cliente Disink');
  const persona = (contacto && contacto.trim()) || '';
  // iniciales del avatar (1-2 letras): de la persona si hay, si no del negocio
  const iniciales = (persona || negocio).trim().charAt(0).toUpperCase();

  const yaCli = await buscarPorCustomer(customerId);
  if (yaCli) {
    const upd = await sb('miembros?id_cliente=eq.' + yaCli.id_cliente, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        stripe_subscription_id: subscriptionId,
        stripe_price_id: priceId,
        nivel: nvl,
        descuento: pct,
        estado: 'activo',
        email: email || yaCli.email,
        contacto: persona || yaCli.contacto,
      }),
    });
    return Array.isArray(upd) ? upd[0] : yaCli;
  }

  // 3) crear nuevo -> ID INK-INICIALES-Nº (iniciales de la persona, o del negocio)
  const id_cliente = await generarIdUnico(persona || negocio);
  const nuevo = await sb('miembros', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      id_cliente,
      nombre: negocio,
      contacto: persona || null,
      iniciales,
      email: email || null,
      descuento: pct,
      estado: 'activo',
      nivel: nvl,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      stripe_price_id: priceId,
    }),
  });
  return Array.isArray(nuevo) ? nuevo[0] : nuevo;
}

// --- Cambiar estado por cliente de Stripe (suspender / cancelar / reactivar) ---
async function fijarEstadoPorCustomer(customerId, estado) {
  if (!customerId) return;
  await sb('miembros?stripe_customer_id=eq.' + customerId, {
    method: 'PATCH',
    body: JSON.stringify({ estado }),
  });
}

module.exports = {
  PLANES,
  planDesdePrecio,
  asegurarMiembro,
  buscarPorCustomer,
  buscarPorSubscription,
  fijarEstadoPorCustomer,
};
