// The checks PerCall can buy. Each one is a pay-per-call endpoint on a public x402 data API;
// `cost` is what the provider charges in USDC, `price` what the buyer pays through PayPal.
export const PROVIDER = "https://api.chainmarket-api.workers.dev";

export const CATALOG = {
  "contract-verified": {
    path: "/api/crypto/smart-contract-verify",
    title: "Contract source check",
    about: "Is the token or contract source code verified on the block explorer, and what is it",
    inputs: { address: "contract address 0x…", chainId: "EVM chain id, 1 = Ethereum, 8453 = Base, 56 = BNB" },
    required: ["address"],
    cost: 0.002,
  },
  "honeypot": {
    path: "/api/crypto/honeypot-detector",
    title: "Honeypot test",
    about: "Can a buyer sell the token again after buying, and what are the buy and sell taxes",
    inputs: { address: "token address 0x…", chainId: "EVM chain id, 1 = Ethereum, 8453 = Base, 56 = BNB" },
    required: ["address"],
    cost: 0.002,
  },
  "holders": {
    path: "/api/crypto/token-holder-concentration",
    title: "Holder concentration",
    about: "How much of an Ethereum token's supply the largest wallets hold",
    inputs: { address: "Ethereum token address 0x…" },
    required: ["address"],
    cost: 0.002,
  },
  "pool": {
    path: "/api/crypto/dex-pool-liquidity",
    title: "Pool liquidity",
    about: "Liquidity in USD and the two tokens of a DEX pool",
    inputs: { chain: "ethereum, base, bsc, arbitrum, polygon or solana", pool: "pool or pair address" },
    required: ["chain", "pool"],
    cost: 0.002,
  },
  "sanctions": {
    path: "/api/crypto/sanctioned-crypto-wallets",
    title: "Sanctions list",
    about: "Whether a wallet address appears on the US OFAC sanctions list",
    inputs: { address: "wallet address", currency: "ETH, XBT, USDT, TRX and so on" },
    required: ["address"],
    cost: 0.002,
  },
  "evm-portfolio": {
    path: "/api/crypto/debank-wallet-portfolio",
    title: "Wallet portfolio",
    about: "What an EVM wallet holds across chains and protocols, in USD",
    inputs: { address: "EVM wallet address 0x…" },
    required: ["address"],
    cost: 0.002,
  },
  "solana-wallet": {
    path: "/api/crypto/solscan-account-tokens",
    title: "Solana wallet tokens",
    about: "Tokens held by a Solana wallet",
    inputs: { address: "Solana wallet address" },
    required: ["address"],
    cost: 0.002,
  },
  "market-depth": {
    path: "/api/crypto/coingecko-market-depth",
    title: "Market depth",
    about: "Where a coin trades and how deep its order books are",
    inputs: { coin: "CoinGecko id such as bitcoin, ethereum, pepe" },
    required: ["coin"],
    cost: 0.002,
  },
  "price-feed": {
    path: "/api/crypto/chainlink-price-feeds",
    title: "Chainlink price",
    about: "Current Chainlink oracle price for a pair",
    inputs: { feed: "pair such as eth-usd, btc-usd, link-usd" },
    required: ["feed"],
    cost: 0.002,
  },
  "unlocks": {
    path: "/api/crypto/token-vesting-schedule",
    title: "Token unlocks",
    about: "Upcoming token unlocks and vesting of a protocol",
    inputs: { protocol: "protocol name such as aave, arbitrum, optimism" },
    required: ["protocol"],
    cost: 0.002,
  },
};

// What the buyer pays per check, and the fixed part of every order (covers the AI and payment work).
export const PRICE_PER_CHECK = 0.05;
export const ORDER_FEE = 0.1;
export const MAX_CHECKS = 5;

export function priceOf(calls) {
  return Math.round((ORDER_FEE + calls.length * PRICE_PER_CHECK) * 100) / 100;
}

// Keep only known inputs, as trimmed strings; null when a required input is missing.
export function cleanInput(id, input) {
  const item = CATALOG[id];
  if (!item) return null;
  const out = {};
  for (const k of Object.keys(item.inputs)) {
    const v = input?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") out[k] = String(v).trim().slice(0, 120);
  }
  return item.required.every((k) => out[k]) ? out : null;
}
