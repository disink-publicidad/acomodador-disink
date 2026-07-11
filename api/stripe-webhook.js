// ============================================================
// DISINK · Fase 3 — Webhook de Stripe (el aviso firmado del pago)
// Stripe llama aquí. Verificamos la FIRMA con STRIPE_WEBHOOK_SECRET.
// Solo si la firma es válida, emitimos/actualizamos el ID en Supabase.
// ============================================================

const Stripe = require('stripe');
const {
  asegurarMiembro,
  planDesdePrecio,
  fijarEstadoPorCustomer,
} = require('./_lib/miembros');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

function leerCrudo(req) {
  return new Promise((resolve, reject) => {
    const trozos = [];
    req.on('data', (c) => trozos.push(c));
    req.on('end', () => resolve(Buffer.concat(trozos)));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  let event;
  try {
    const crudo = await leerCrudo(req);
    const firma = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(crudo, firma, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Firma inválida:', err.message);
    res.status(400).send('Firma inválida');
    return;
  }

  try {
    switch (event.type) {
      // Pago inicial exitoso -> emitir el ID
      case 'checkout.session.completed': {
        const s = event.data.object;
        if (s.mode !== 'subscription') break;
        // El nombre del negocio viene del custom_field
        let nombre = null;
        if (Array.isArray(s.custom_fields)) {
          const f = s.custom_fields.find((x) => x.key === 'negocio');
          if (f && f.text) nombre = f.text.value;
        }
        const email = (s.customer_details && s.customer_details.email) || s.customer_email || null;
        // averiguar el price para saber el nivel
        let priceId = null;
        try {
          const li = await stripe.checkout.sessions.listLineItems(s.id, { limit: 1 });
          priceId = li.data[0] && li.data[0].price ? li.data[0].price.id : null;
        } catch (_) {}
        await asegurarMiembro({
          customerId: s.customer,
          subscriptionId: s.subscription,
          priceId,
          email,
          nombre,
          nivel: (s.metadata && s.metadata.plan) || planDesdePrecio(priceId),
        });
        break;
      }

      // Pago mensual falló definitivamente -> suspender
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        await fijarEstadoPorCustomer(inv.customer, 'suspendido');
        break;
      }

      // Volvió a pagar -> reactivar
      case 'invoice.paid': {
        const inv = event.data.object;
        if (inv.billing_reason && inv.billing_reason !== 'subscription_create') {
          await fijarEstadoPorCustomer(inv.customer, 'activo');
        }
        break;
      }

      // Suscripción cancelada -> cancelar el descuento
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await fijarEstadoPorCustomer(sub.customer, 'cancelado');
        break;
      }

      default:
        // otros eventos: ignorar
        break;
    }
    res.status(200).json({ recibido: true });
  } catch (err) {
    console.error('Error procesando webhook:', err.message);
    // 500 hace que Stripe reintente (es seguro: las operaciones son idempotentes)
    res.status(500).send('Error interno');
  }
}

module.exports = handler;
// Vercel: NO parsear el body; necesitamos el texto crudo para verificar la firma.
module.exports.config = { api: { bodyParser: false } };
