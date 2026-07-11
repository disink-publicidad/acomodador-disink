// ============================================================
// DISINK · Fase 3 — Crear la sesión de pago (suscripción mensual)
// El navegador llama aquí (POST { plan }). Devuelve la URL segura
// de Stripe Checkout. La llave secreta vive SOLO aquí (env var).
// ============================================================

const Stripe = require('stripe');
const { PLANES } = require('./_lib/miembros');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const APP_URL = process.env.APP_URL || 'https://imprime.disinkcontrol.online';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const plan = String(body.plan || '').toLowerCase();
    const cfg = PLANES[plan];
    if (!cfg || !cfg.priceId) {
      res.status(400).json({ error: 'Plan inválido o precio no configurado: ' + plan });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: cfg.priceId, quantity: 1 }],
      locale: 'es',
      allow_promotion_codes: true,
      // Pide el nombre del negocio para el saludo dentro de la app
      custom_fields: [{
        key: 'negocio',
        label: { type: 'custom', custom: 'Nombre de tu negocio' },
        type: 'text',
      }],
      metadata: { plan, pct: String(cfg.pct) },
      subscription_data: { metadata: { plan, pct: String(cfg.pct) } },
      success_url: APP_URL + '/?membresia=ok&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: APP_URL + '/?membresia=cancelada',
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('crear-checkout error:', err.message);
    res.status(500).json({ error: 'No se pudo iniciar el pago' });
  }
};
