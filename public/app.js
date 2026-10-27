const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (n) => `$${Number(n).toFixed(2)}`;
const show = (id) => ["ask", "quote", "working", "receipt"].forEach((s) => $(s).classList.toggle("hidden", s !== id && !(id === "quote" && s === "ask")));

const EXAMPLES = [
  "Is the token 0x6982508145454Ce325dDbE47a25d4ec3d2311933 on Ethereum safe to buy?",
  "Is the wallet 0x8589427373D6D84E98730D7795D8f6f8731FDA16 on a sanctions list?",
  "What does the wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 hold?",
  "How deep is the market for pepe, and what is the Chainlink ETH price?",
];

async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

// Which PayPal steps the checkout agent made through PayPal Agent Toolkit.
function via(p) {
  const steps = [["order", p.orderVia], ["capture", p.captureVia], ["refund", p.refund?.via]].filter(([, v]) => v);
  const agent = steps.filter(([, v]) => v === "agent-toolkit").map(([k]) => k);
  const direct = steps.filter(([, v]) => v === "direct").map(([k]) => k);
  return [agent.length ? `checkout agent via PayPal Agent Toolkit: ${agent.join(", ")}` : "", direct.length ? `direct PayPal API: ${direct.join(", ")}` : ""].filter(Boolean).join(" · ");
}

function renderReceipt(rc) {
  $("r-question").textContent = rc.question;
  $("r-answer").textContent = rc.answer;
  $("r-checks").innerHTML = rc.checks.map((c) => `
    <li>
      <span class="${c.ok ? "ok" : "bad"}">${c.ok ? "Returned data" : "No data, refunded"}</span> · <strong>${esc(c.title)}</strong>
      <small>${esc(Object.entries(c.input).map(([k, v]) => `${k}=${v}`).join(" · "))}</small>
      ${c.providerTx ? `<small>Paid to provider: <a href="https://basescan.org/tx/${esc(c.providerTx)}" target="_blank" rel="noopener">${esc(c.providerTx.slice(0, 18))}…</a></small>` : ""}
      ${c.ok ? `<details><summary>Raw result</summary><pre>${esc(JSON.stringify(c.data, null, 2).slice(0, 6000))}</pre></details>` : `<small>${esc(c.error)}</small>`}
    </li>`).join("");
  const p = rc.paypal;
  $("r-pay").innerHTML = `
    <dt>Charged</dt><dd>${usd(p.charged)} (PayPal capture ${esc(p.captureId)})</dd>
    <dt>Refunded</dt><dd>${p.refund ? `${usd(p.refund.amount)} · ${esc(p.refund.status)}${p.refund.id ? ` (refund ${esc(p.refund.id)})` : ""}` : "nothing to refund"}</dd>
    <dt>You paid</dt><dd><strong>${usd(p.net)}</strong></dd>
    <dt>Handled by</dt><dd>${esc(via(p))}</dd>`;
  $("r-link").href = `/?r=${rc.id}`;
  show("receipt");
}

async function loadPayPal(clientId) {
  if (window.paypal) return;
  await new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons`;
    s.onload = ok; s.onerror = () => fail(new Error("PayPal could not load"));
    document.head.appendChild(s);
  });
}

async function showQuote(qt, cfg) {
  $("quote-question").textContent = qt.question;
  $("quote-calls").innerHTML = qt.calls.map((c) => `<li><strong>${esc(c.title)}</strong> · ${usd(c.price)}<small>${esc(c.why)}</small></li>`).join("")
    + `<li><strong>Agent fee</strong> · ${usd(qt.fee)}<small>Planning, buying and writing the answer</small></li>`;
  $("quote-total").textContent = usd(qt.price);
  show("quote");
  $("paypal-buttons").innerHTML = "";
  await loadPayPal(cfg.paypalClientId);
  window.paypal.Buttons({
    style: { layout: "vertical", shape: "rect", label: "pay" },
    createOrder: async () => (await api("/api/orders", { quoteId: qt.id })).id,
    onApprove: async ({ orderID }) => {
      show("working");
      try { renderReceipt(await api(`/api/orders/${orderID}/capture`, {})); }
      catch (e) { show("ask"); $("ask-note").textContent = e.message; }
    },
    onError: (e) => { $("ask-note").textContent = `PayPal: ${e?.message ?? e}`; },
  }).render("#paypal-buttons");
}

async function main() {
  const cfg = await api("/api/config");
  const rid = new URLSearchParams(location.search).get("r");
  if (rid) { try { renderReceipt(await api(`/api/receipts/${rid}`)); return; } catch { /* fall through to the form */ } }

  $("examples").innerHTML = EXAMPLES.map((q, i) => `<button type="button" data-i="${i}">${esc(q.length > 52 ? `${q.slice(0, 50)}…` : q)}</button>`).join("");
  $("examples").onclick = (e) => { const i = e.target.dataset?.i; if (i !== undefined) $("question").value = EXAMPLES[i]; };
  $("quote-cancel").onclick = () => show("ask");
  $("ask-form").onsubmit = async (e) => {
    e.preventDefault();
    $("ask-note").textContent = "";
    $("ask-btn").disabled = true; $("ask-btn").textContent = "Planning…";
    try {
      const qt = await api("/api/quote", { question: $("question").value });
      if (qt.missing) $("ask-note").textContent = qt.missing;
      else await showQuote(qt, cfg);
    } catch (err) { $("ask-note").textContent = err.message; }
    finally { $("ask-btn").disabled = false; $("ask-btn").textContent = "Get a quote"; }
  };
}

main().catch((e) => { $("ask-note").textContent = e.message; });
