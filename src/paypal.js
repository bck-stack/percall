// PayPal Orders v2 and Payments v2: create, capture, and refund part of a capture.
async function token(env) {
  const r = await fetch(`${env.PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`PayPal auth ${r.status}`);
  return (await r.json()).access_token;
}

async function call(env, path, body, idem) {
  const r = await fetch(`${env.PAYPAL_BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${await token(env)}`, "content-type": "application/json", ...(idem ? { "PayPal-Request-Id": idem } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`PayPal ${path} ${r.status}: ${data.details?.[0]?.description ?? data.message ?? ""}`.trim());
  return data;
}

export const money = (n) => n.toFixed(2);

export function createOrder(env, quote) {
  return call(env, "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: quote.id,
      custom_id: quote.id,
      description: `PerCall: ${quote.calls.length} paid data check${quote.calls.length === 1 ? "" : "s"}`.slice(0, 127),
      amount: { currency_code: "USD", value: money(quote.price) },
    }],
    payment_source: { paypal: { experience_context: { brand_name: "PerCall", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" } } },
  }, `order-${quote.id}`);
}

export async function getOrder(env, orderId) {
  const r = await fetch(`${env.PAYPAL_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}`, { headers: { authorization: `Bearer ${await token(env)}` } });
  if (!r.ok) throw new Error(`PayPal get order ${r.status}`);
  return r.json();
}

function captureOf(data) {
  const cap = data.purchase_units?.[0]?.payments?.captures?.[0];
  if (!cap || cap.status !== "COMPLETED") throw new Error(`capture not completed (${cap?.status ?? data.status})`);
  return { captureId: cap.id, amount: Number(cap.amount.value), payer: data.payer?.email_address ?? null };
}

export async function captureOrder(env, orderId) {
  try {
    return captureOf(await call(env, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, null, `capture-${orderId}`));
  } catch (e) {
    // Already captured (for example by the toolkit call a moment ago): read the capture from the order.
    if (!/ORDER_ALREADY_CAPTURED|already been captured|422/.test(String(e.message))) throw e;
    return captureOf(await getOrder(env, orderId));
  }
}

export function refund(env, captureId, amount, note, idem) {
  return call(env, `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    amount: { currency_code: "USD", value: money(amount) },
    note_to_payer: note.slice(0, 255),
  }, idem);
}
