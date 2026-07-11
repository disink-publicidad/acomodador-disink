// ============================================================
// DISINK · Fase 3 — Consultar el ID recién emitido tras pagar
// El navegador vuelve del pago con ?session_id=... y llama aquí.
// Devuelve el ID para mostrarlo al instante (aunque el webhook
// aún no haya llegado: aquí también lo aseguramos, idempotente).
// ============================================================

const Stripe = require('stripe');
const { asegurarMiembro, planDesdePrecio } = require('./_lib/miembros');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  try {
    const sessionId = (req.query && req.query.session_id) ||
      new URL(req.url, 'http://x').searchParams.get('session_id');
    if (!sessionId) {
      res.status(400).json({ error: 'Falta session_id' });
      return;
    }

    const s = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items'],
    });

    if (s.payment_status !== 'paid') {
      res.status(202).json({ pendiente: true });
      return;
    }

    let nombre = null;
    if (Array.isArray(s.custom_fields)) {
      const f = s.custom_fields.find((x) => x.key === 'negocio');
      if (f && f.text) nombre = f.text.value;
    }
    const email = (s.customer_details && s.customer_details.email) || null;
    const priceId = s.line_items && s.line_items.data[0] && s.line_items.data[0].price
      ? s.line_items.data[0].price.id : null;

    const m = await asegurarMiembro({
      customerId: s.customer,
      subscriptionId: s.subscription,
      priceId,
      email,
      nombre,
      nivel: (s.metadata && s.metadata.plan) || planDesdePrecio(priceId),
    });

    // Solo devolvemos campos públicos (nunca los de Stripe)
    res.status(200).json({
      id_cliente: m.id_cliente,
      nombre: m.nombre,
      iniciales: m.iniciales,
      nivel: m.nivel,
      descuento: m.descuento,
      estado: m.estado,
    });
  } catch (err) {
    console.error('consultar-membresia error:', err.message);
    res.status(500).json({ error: 'No se pudo consultar la membresía' });
  }
};
