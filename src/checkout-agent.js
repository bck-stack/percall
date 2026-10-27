// The checkout agent: an AI model that handles the PayPal side through PayPal Agent Toolkit.
// It is handed one toolkit tool at a time (create_order, then create_refund), decides the call and its
// arguments, and the server checks those arguments against the quote before the toolkit runs them.
// If the model gets it wrong or does not answer, the same PayPal call is made directly (paypal.js),
// and the receipt says which path was taken.
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";
import { createOrder, captureOrder, refund, money } from "./paypal.js";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function toolkit(env) {
  return new PayPalAgentToolkit({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    configuration: {
      actions: { orders: { create: true, get: true, capture: true }, payments: { createRefund: true, getRefunds: true } },
      context: { sandbox: String(env.PAYPAL_BASE).includes("sandbox") },
    },
  });
}

// Ask the model to make exactly one call to `toolName`; return its arguments, or null.
async function decide(env, tk, toolName, instruction) {
  const tool = tk.getTools().find((t) => t.function.name === toolName);
  if (!tool) return null;
  const out = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: "You are the checkout agent of PerCall. You act on PayPal only through the tool you are given. Make exactly one tool call with the exact figures in the instruction, and nothing else." },
      { role: "user", content: instruction },
    ],
    tools: [{ type: "function", function: { name: tool.function.name, description: tool.function.description.slice(0, 1500), parameters: tool.function.parameters } }],
    temperature: 0,
    max_tokens: 700,
  }).catch(() => null);
  const call = out?.tool_calls?.find((c) => c.name === toolName);
  if (!call) {
    console.log(`[checkout-agent] ${toolName}: no tool call (${JSON.stringify(out ?? null).slice(0, 300)})`);
    return null;
  }
  return typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments;
}

async function run(tk, toolName, args) {
  const msg = await tk.handleToolCall({ id: `call_${toolName}`, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } });
  return JSON.parse(msg.content);
}

const cents = (n) => Math.round(Number(n) * 100);

export async function agentCreateOrder(env, quote) {
  const lines = [
    ...quote.calls.map((c) => ({ name: c.title, description: c.why, cost: c.price })),
    { name: "Agent fee", description: "Planning, buying the data and writing the answer", cost: quote.fee },
  ];
  const instruction = `Create a PayPal order in USD for these line items, quantity 1 each, no tax, no shipping, no discount:\n${lines.map((l) => `- ${l.name} (${l.description}): ${money(l.cost)}`).join("\n")}\nThe order total must be ${money(quote.price)}.`;
  try {
    const tk = toolkit(env);
    const raw = await decide(env, tk, "create_order", instruction);
    // Models often write numbers as strings ("0.05"); the toolkit's schema wants numbers.
    const num = (v, d = 0) => (v === undefined || v === null || v === "" ? d : Number(v));
    const args = raw && {
      ...raw,
      discount: num(raw.discount),
      shippingCost: num(raw.shippingCost),
      items: (raw.items ?? []).map((i) => ({ ...i, quantity: num(i.quantity, 1), itemCost: num(i.itemCost), itemTotal: num(i.itemTotal, num(i.itemCost)), taxPercent: num(i.taxPercent) })),
    };
    const items = args?.items ?? [];
    const total = items.reduce((s, i) => s + cents(i.itemTotal ?? i.itemCost), 0);
    const ok = args && args.currencyCode === "USD" && items.length === lines.length && total === cents(quote.price)
      && items.every((i) => !i.taxPercent && cents(i.itemTotal ?? i.itemCost) === cents(i.itemCost) * (i.quantity ?? 1))
      && !args.shippingCost && !args.discount;
    if (!ok) console.log(`[checkout-agent] create_order arguments rejected: ${JSON.stringify(args ?? null).slice(0, 400)}`);
    if (ok) {
      const site = env.PUBLIC_URL ?? "https://percall.chainmarket-api.workers.dev";
      const order = await run(tk, "create_order", { ...args, shippingAddress: null, returnUrl: `${site}/`, cancelUrl: `${site}/` });
      if (order?.id) return { id: order.id, via: "agent-toolkit" };
    }
  } catch (e) {
    console.log(`[checkout-agent] create_order fell back: ${String(e?.message ?? e).slice(0, 160)}`);
  }
  const order = await createOrder(env, quote);
  return { id: order.id, via: "direct" };
}

export async function agentCapture(env, orderId) {
  try {
    const out = await run(toolkit(env), "pay_order", { id: orderId });
    const unit = out?.response?.purchase_units?.[0];
    const cap = unit?.payments?.captures?.[0];
    if (out?.status === "success" && cap?.status === "COMPLETED") {
      return { captureId: cap.id, amount: Number(cap.amount.value), payer: out.response.payer?.email_address ?? null, via: "agent-toolkit" };
    }
  } catch (e) {
    console.log(`[checkout-agent] pay_order fell back: ${String(e?.message ?? e).slice(0, 160)}`);
  }
  return { ...(await captureOrder(env, orderId)), via: "direct" };   // captureOrder reads the order if it is already captured
}

export async function agentRefund(env, quoteId, captureId, amount, failed, total) {
  const note = `PerCall refund: ${failed.length} of ${total} checks returned no data.`;
  const instruction = `These paid checks returned no data, so the buyer gets their price back: ${failed.map((f) => f.title).join(", ")}.
Refund exactly ${money(amount)} USD of PayPal capture ${captureId}, with the note "${note}".`;
  const tk = toolkit(env);
  const args = await decide(env, tk, "create_refund", instruction).catch(() => null);
  if (args && args.capture_id === captureId && args.amount?.currency_code === "USD" && cents(args.amount.value) === cents(amount)) {
    // Once the toolkit call is sent there is no second attempt: the toolkit sends no idempotency key,
    // so retrying through the direct path could refund twice.
    try {
      const r = await run(tk, "create_refund", { capture_id: captureId, amount: { currency_code: "USD", value: money(amount) }, note_to_payer: note });
      return { id: r?.id ?? null, status: r?.status ?? "UNKNOWN", amount, via: "agent-toolkit" };
    } catch (e) {
      return { id: null, status: "FAILED", amount, via: "agent-toolkit", error: String(e?.message ?? e).slice(0, 200) };
    }
  }
  const r = await refund(env, captureId, amount, note, `refund-${quoteId}`);
  return { id: r.id, status: r.status, amount, via: "direct" };
}
