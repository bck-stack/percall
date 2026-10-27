# PerCall

Pay per answer. Ask a question about a token, contract or wallet; an AI agent buys the data checks it needs, you pay once with PayPal, and every check that comes back empty is refunded to your PayPal on the spot.

- Live demo (PayPal sandbox): https://percall.chainmarket-api.workers.dev
- Demo video: https://youtu.be/hRfy-9pUfKw
- Built for the PayPal AI Hackathon 2026

## Why

Before you send money to a wallet or buy a token, the useful answers sit behind paid data APIs that charge a fraction of a cent per call and want an account, an API key or a crypto wallet. PerCall puts one PayPal checkout in front of all of them: you see the exact price first, an agent does the buying, and you never pay for a check that returned nothing.

## How it works

1. **Plan.** An AI model reads the question and picks up to five checks from a menu of paid data endpoints (honeypot test, contract source check, holder concentration, pool liquidity, sanctions list, wallet portfolio, Solana wallet tokens, market depth, Chainlink price, token unlocks), with the inputs taken from the question. If the question has no address or name to check, it asks for one instead of charging.
2. **Quote.** The buyer sees every check, why it is needed and its price, plus the agent fee.
3. **Pay.** The checkout agent creates the PayPal order through **PayPal Agent Toolkit** (`create_order`). The buyer approves it with PayPal; the agent captures it (`pay_order`).
4. **Buy.** The agent pays the data provider per call in USDC over x402 on Base and collects the results. A daily budget caps what the agent's wallet can spend.
5. **Refund.** For every check that returned no data, the checkout agent refunds its price through PayPal Agent Toolkit (`create_refund`).
6. **Answer.** The model writes a short answer that cites the check behind each fact. The receipt page shows the answer, every check with its raw result and provider payment, and the PayPal capture and refund.

The model proposes each PayPal call; the server checks the arguments against the quote (currency, line items, total, capture id, refund amount) before the toolkit runs them. If the model's call does not match, the server makes the same PayPal call directly with the exact figures, and the receipt shows which path was used.

## PayPal

| Step | PayPal API | Through |
|---|---|---|
| Create the order with one line item per check | Orders v2 `POST /v2/checkout/orders` | Agent Toolkit `create_order` |
| Buyer approval | PayPal JavaScript SDK buttons | browser |
| Capture | Orders v2 `POST /v2/checkout/orders/{id}/capture` | Agent Toolkit `pay_order` |
| Partial refund of empty checks | Payments v2 `POST /v2/payments/captures/{id}/refund` | Agent Toolkit `create_refund` |

## AI

- Cloudflare Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- Planning uses JSON-schema output limited to the check ids on the menu.
- The checkout agent uses tool calling with the tool definitions exported by PayPal Agent Toolkit.
- The answer is written only from the purchased results, with a citation per fact.

## Code

| File | What it does |
|---|---|
| `src/index.js` | Worker routes: quote, order, capture, receipt |
| `src/ai.js` | Planner and answer writer |
| `src/checkout-agent.js` | PayPal Agent Toolkit tools driven by the model, with argument checks and direct fallback |
| `src/paypal.js` | Direct Orders v2 and Payments v2 calls |
| `src/provider.js` | x402 purchase of each check, daily budget |
| `src/catalog.js` | The check menu and prices |
| `public/` | The web app |
| `test/` | Unit tests (`npm test`) |

## Run it

Requirements: Node 20+, a Cloudflare account (Workers, Workers AI, KV), a PayPal developer account with a sandbox REST app, and a Base wallet with a little USDC for the provider payments.

```bash
npm install
npx wrangler kv namespace create PERCALL   # put the id in wrangler.toml as STORE
npx wrangler secret put PAYPAL_CLIENT_ID
npx wrangler secret put PAYPAL_CLIENT_SECRET
npx wrangler secret put AGENT_WALLET_KEY   # private key of the wallet that pays the data provider
npm run deploy
npm test
```

Settings in `wrangler.toml`: `PAYPAL_BASE` (sandbox by default), `DAILY_BUDGET_USD` (provider spend cap per day, default 0.10), `QUOTES_PER_HOUR` (questions per visitor per hour), `PUBLIC_URL`. The provider is reached through a service binding because it runs on the same Cloudflare account; remove `services` in `wrangler.toml` to call it over the public URL instead.

## Try it

Open the demo, pick one of the example questions, approve the quote with a PayPal sandbox buyer account, and read the receipt. Asking about an address that does not exist (for example a random `0x…`) shows the refund path.

## License

MIT
