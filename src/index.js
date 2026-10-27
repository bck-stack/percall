// PerCall: ask a question, approve a quote, pay with PayPal, get an answer built from paid data checks.
// Checks that return nothing are refunded to the buyer's PayPal automatically.
import { CATALOG, ORDER_FEE, PRICE_PER_CHECK, MAX_CHECKS, priceOf } from "./catalog.js";
import { plan, answer } from "./ai.js";
import { agentCreateOrder, agentCapture, agentRefund } from "./checkout-agent.js";
import { buy } from "./provider.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const id = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const DAY = 86400;

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

// Planning runs a model on every question, so each visitor gets a few per hour.
async function allowQuote(env, req) {
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const key = `rl:${ip}:${new Date().toISOString().slice(0, 13)}`;
  const n = Number((await env.STORE.get(key)) ?? 0);
  if (n >= Number(env.QUOTES_PER_HOUR ?? 20)) return false;
  await env.STORE.put(key, String(n + 1), { expirationTtl: 2 * 3600 });
  return true;
}

async function quote(env, req) {
  const { question } = await body(req);
  const q = String(question ?? "").trim().slice(0, 500);
  if (q.length < 8) return json({ error: "Ask a question about a token, contract or wallet." }, 400);
  if (!(await allowQuote(env, req))) return json({ error: "Too many questions from this address this hour." }, 429);
  const { calls, missing, raw } = await plan(env, q);
  if (!calls.length) return json({ missing, ...(req.headers.get("x-debug") ? { raw } : {}) });
  const qt = {
    id: id(), question: q, status: "quoted", createdAt: Date.now(),
    calls: calls.map((c) => ({ ...c, title: CATALOG[c.check].title, price: PRICE_PER_CHECK })),
    fee: ORDER_FEE, price: priceOf(calls),
  };
  await env.STORE.put(`quote:${qt.id}`, JSON.stringify(qt), { expirationTtl: DAY });
  return json(qt);
}

async function order(env, req) {
  const { quoteId } = await body(req);
  const qt = JSON.parse((await env.STORE.get(`quote:${quoteId}`)) ?? "null");
  if (!qt) return json({ error: "Quote expired. Ask again." }, 404);
  if (qt.status !== "quoted") return json({ error: "This quote is already paid." }, 409);
  const o = await agentCreateOrder(env, qt);
  await env.STORE.put(`order:${o.id}`, JSON.stringify({ quoteId: qt.id, via: o.via }), { expirationTtl: DAY });
  return json({ id: o.id });
}

async function capture(env, orderId) {
  const link = JSON.parse((await env.STORE.get(`order:${orderId}`)) ?? "null");
  if (!link) return json({ error: "Unknown order." }, 404);
  const cap = await agentCapture(env, orderId);
  const key = `quote:${link.quoteId}`;
  const qt = JSON.parse((await env.STORE.get(key)) ?? "null");
  if (!qt) return json({ error: "Quote not found for this payment." }, 404);
  if (qt.status !== "quoted") return json(JSON.parse((await env.STORE.get(`receipt:${qt.id}`)) ?? "{}"));
  await env.STORE.put(key, JSON.stringify({ ...qt, status: "running", orderId }), { expirationTtl: DAY });

  const results = await Promise.all(qt.calls.map((c) => buy(env, c)));
  const failed = results.filter((r) => !r.ok);
  const refundDue = Math.round(failed.length * PRICE_PER_CHECK * 100) / 100;
  let refundInfo = null;
  if (refundDue > 0) {
    try {
      refundInfo = await agentRefund(env, qt.id, cap.captureId, refundDue, failed.map((f) => ({ title: CATALOG[f.check].title })), results.length);
    } catch (e) {
      refundInfo = { amount: refundDue, status: "FAILED", error: String(e.message).slice(0, 200) };
    }
  }
  const text = results.some((r) => r.ok) ? await answer(env, qt.question, results) : "None of the checks returned data, so there is no answer and the checks were refunded.";
  const receipt = {
    id: qt.id, question: qt.question, answer: text, paidAt: Date.now(),
    paypal: { orderId, orderVia: link.via, captureId: cap.captureId, captureVia: cap.via, charged: cap.amount, refund: refundInfo, net: Math.round((cap.amount - (["FAILED", "UNKNOWN"].includes(refundInfo?.status) ? 0 : refundDue)) * 100) / 100 },
    checks: results.map((r) => ({ check: r.check, title: CATALOG[r.check].title, input: r.input, why: r.why, ok: r.ok, error: r.error ?? null, providerTx: r.paidTx ?? null, data: r.ok ? r.data : null })),
  };
  await env.STORE.put(`receipt:${qt.id}`, JSON.stringify(receipt), { expirationTtl: 90 * DAY });
  await env.STORE.put(key, JSON.stringify({ ...qt, status: "done", orderId }), { expirationTtl: DAY });
  return json(receipt);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/api/config") return json({ paypalClientId: env.PAYPAL_CLIENT_ID, pricePerCheck: PRICE_PER_CHECK, orderFee: ORDER_FEE, maxChecks: MAX_CHECKS, checks: Object.entries(CATALOG).map(([k, c]) => ({ id: k, title: c.title, about: c.about })) });
      if (p === "/api/quote" && req.method === "POST") return await quote(env, req);
      if (p === "/api/orders" && req.method === "POST") return await order(env, req);
      const m = p.match(/^\/api\/orders\/([A-Z0-9]+)\/capture$/);
      if (m && req.method === "POST") return await capture(env, m[1]);
      const r = p.match(/^\/api\/receipts\/([a-f0-9]{16})$/);
      if (r) {
        const rec = await env.STORE.get(`receipt:${r[1]}`);
        return rec ? new Response(rec, { headers: { "content-type": "application/json" } }) : json({ error: "not found" }, 404);
      }
      if (p.startsWith("/api/")) return json({ error: "not found" }, 404);
      return env.ASSETS.fetch(req);
    } catch (e) {
      return json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
    }
  },
};
