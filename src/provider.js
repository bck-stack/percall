// Buys each check from the data provider over x402: the provider answers 402 with a price,
// the agent's wallet signs a USDC payment on Base, and the retried request returns the data.
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { CATALOG, PROVIDER } from "./catalog.js";

const today = () => new Date().toISOString().slice(0, 10);

// A daily cap on what the agent's wallet may spend, so a busy demo cannot drain it.
async function reserve(env, cost) {
  const key = `spent:${today()}`;
  const spent = Number((await env.STORE.get(key)) ?? 0);
  if (spent + cost > Number(env.DAILY_BUDGET_USD ?? 0.1)) return false;
  await env.STORE.put(key, String(Math.round((spent + cost) * 1e6) / 1e6), { expirationTtl: 3 * 86400 });
  return true;
}

export async function buy(env, call) {
  const item = CATALOG[call.check];
  const url = `${PROVIDER}${item.path}?${new URLSearchParams(call.input)}`;
  if (!env.AGENT_WALLET_KEY) return { ...call, ok: false, error: "agent wallet not configured" };
  if (!(await reserve(env, item.cost))) return { ...call, ok: false, error: "daily data budget reached, try again tomorrow" };

  const account = privateKeyToAccount(env.AGENT_WALLET_KEY);
  const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }] });
  try {
    const r = await pay(url, { signal: AbortSignal.timeout(30000) });
    const body = await r.json().catch(() => null);
    const receipt = r.headers.get("payment-response") || r.headers.get("x-payment-response");
    let tx = null;
    try { tx = receipt ? JSON.parse(atob(receipt)).transaction ?? null : null; } catch {}
    if (!r.ok || !body || body.error) return { ...call, ok: false, error: String(body?.error ?? `HTTP ${r.status}`).slice(0, 200), paidTx: tx };
    return { ...call, ok: true, data: body, cost: item.cost, paidTx: tx };
  } catch (e) {
    return { ...call, ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}
