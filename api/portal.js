// ============================================================
// DISINK · Fase 3 — Portal de cliente (autoservicio)
// El cliente entra con su ID y aquí generamos un link seguro de
// Stripe donde él mismo cancela, cambia su tarjeta o ve recibos.
// Te ahorra soporte manual.
// ============================================================

const Stripe = require('stripe');
const { buscarPorCustomer } = require('./_lib/miembros');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const APP_URL = process.env.APP_URL || 'https://imprime.disinkcontrol.online';

// Buscar el stripe_customer_id a partir del id_cliente (con service_role)
async function customerDeId(idCliente) {
  const r = await fetch(
    process.env.SUPABASE_URL + '/rest/v1/miembros?id_cliente=eq.' +
      encodeURIComponent(idCliente) + '&select=stripe_customer_id',
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      },
    }
  );
  const data = await r.json();
  return Array.isArray(data) && data.length ? data[0].stripe_customer_id : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const idCliente = String(body.id_cliente || '').trim().toUpperCase();
    if (!idCliente) {
      res.status(400).json({ error: 'Falta id_cliente' });
      return;
    }
    const customerId = await customerDeId(idCliente);
    if (!customerId) {
      res.status(404).json({ error: 'Ese ID no tiene una membresía con tarjeta' });
      return;
    }
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: APP_URL,
    });
    res.status(200).json({ url: portal.url });
  } catch (err) {
    console.error('portal error:', err.message);
    res.status(500).json({ error: 'No se pudo abrir el portal' });
  }
};
