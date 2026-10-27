import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, cleanInput, priceOf, MAX_CHECKS } from "../src/catalog.js";
import { plan } from "../src/ai.js";
import { agentCreateOrder, agentRefund } from "../src/checkout-agent.js";

const fakeAI = (reply) => ({ run: async () => reply });

test("cleanInput keeps known inputs and requires the required ones", () => {
  assert.deepEqual(cleanInput("honeypot", { address: " 0xabc ", chainId: 1, extra: "x" }), { address: "0xabc", chainId: "1" });
  assert.equal(cleanInput("honeypot", { chainId: "1" }), null);
  assert.equal(cleanInput("pool", { chain: "ethereum" }), null);
  assert.equal(cleanInput("nope", { address: "0x1" }), null);
});

test("priceOf is the order fee plus a price per check", () => {
  assert.equal(priceOf([]), 0.1);
  assert.equal(priceOf([{}, {}, {}]), 0.25);
});

test("plan drops unknown checks, missing inputs and duplicates, and caps the list", async () => {
  const calls = [
    { check: "honeypot", input: { address: "0x1", chainId: "1" }, why: "sell test" },
    { check: "honeypot", input: { address: "0x1", chainId: "1" }, why: "again" },
    { check: "made-up", input: { address: "0x1" }, why: "x" },
    { check: "pool", input: { chain: "ethereum" }, why: "missing pool" },
    ...Object.keys(CATALOG).map((k) => ({ check: k, input: { address: "0x2", coin: "pepe", feed: "eth-usd", protocol: "aave", chain: "ethereum", pool: "0x3" }, why: "w" })),
  ];
  const out = await plan({ AI: fakeAI({ response: { calls, missing: "" } }) }, "is 0x1 safe?");
  assert.equal(out.calls.length, MAX_CHECKS);
  assert.equal(out.calls[0].check, "honeypot");
  assert.equal(out.calls.filter((c) => c.check === "honeypot" && c.input.address === "0x1").length, 1);
  assert.ok(out.calls.every((c) => CATALOG[c.check]));
});

test("plan asks for more detail when nothing usable comes back", async () => {
  const out = await plan({ AI: fakeAI({ response: { calls: [], missing: "Add the token address." } }) }, "is this coin good?");
  assert.deepEqual(out.calls, []);
  assert.equal(out.missing, "Add the token address.");
});

// PayPal is replaced by a recorder so no request leaves the test.
function fakePayPal() {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
    seen.push({ url: String(url), body });
    if (String(url).endsWith("/v1/oauth2/token")) return Response.json({ access_token: "t" });
    if (String(url).endsWith("/v2/checkout/orders")) return Response.json({ id: "ORDER123" });
    if (String(url).includes("/refund")) return Response.json({ id: "REFUND1", status: "COMPLETED" });
    return Response.json({}, { status: 404 });
  };
  return seen;
}
const env = (aiReply) => ({ AI: fakeAI(aiReply), PAYPAL_BASE: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" });
const quote = { id: "q1", price: 0.15, fee: 0.1, calls: [{ title: "Sanctions list", why: "is the wallet listed", price: 0.05 }] };

test("an order whose total does not match the quote is not created by the agent", async () => {
  const seen = fakePayPal();
  const wrong = { tool_calls: [{ name: "create_order", arguments: { currencyCode: "USD", items: [{ name: "Sanctions list", itemCost: 5, itemTotal: 5 }, { name: "Agent fee", itemCost: 0.1, itemTotal: 0.1 }] } }] };
  const o = await agentCreateOrder(env(wrong), quote);
  assert.equal(o.via, "direct");
  const order = seen.find((s) => s.url.endsWith("/v2/checkout/orders"));
  assert.equal(order.body.purchase_units[0].amount.value, "0.15");
});

test("a refund for the wrong amount or capture falls back to the exact direct refund", async () => {
  const seen = fakePayPal();
  const wrong = { tool_calls: [{ name: "create_refund", arguments: { capture_id: "OTHER", amount: { currency_code: "USD", value: "0.15" } } }] };
  const r = await agentRefund(env(wrong), "q1", "CAP1", 0.05, [{ title: "Sanctions list" }], 1);
  assert.equal(r.via, "direct");
  const refund = seen.find((s) => s.url.includes("/captures/CAP1/refund"));
  assert.equal(refund.body.amount.value, "0.05");
});
