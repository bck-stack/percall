// Two AI jobs: turn a question into a short list of paid checks, then turn the results into an answer.
import { CATALOG, MAX_CHECKS, cleanInput } from "./catalog.js";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const menu = Object.entries(CATALOG)
  .map(([id, c]) => `- ${id}: ${c.about}. Inputs: ${Object.entries(c.inputs).map(([k, v]) => `${k} (${v})`).join(", ")}; required: ${c.required.join(", ")}`)
  .join("\n");

const PLAN_SYSTEM = `You plan paid data checks that answer a user's question about crypto tokens, contracts and wallets.
Each check costs the user money, so pick only the checks that are needed (at most ${MAX_CHECKS}), and never the same check twice with the same input.
Available checks:
${menu}

Reply with JSON only:
{"calls":[{"check":"<id>","input":{...},"why":"<what this check tells the user, max 12 words>"}],"missing":"<empty, or what the user must add, e.g. the token address>"}
For "is this token safe" questions use honeypot and contract-verified, plus holders when the token is on Ethereum. For a wallet you are about to pay, use sanctions first.
Use only addresses and names that appear in the question. If the question cannot be answered with these checks, return no calls and explain in "missing".`;

export async function plan(env, question) {
  const out = await env.AI.run(MODEL, {
    messages: [{ role: "system", content: PLAN_SYSTEM }, { role: "user", content: question }],
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          calls: { type: "array", items: { type: "object", properties: { check: { type: "string", enum: Object.keys(CATALOG) }, input: { type: "object" }, why: { type: "string" } }, required: ["check", "input", "why"] } },
          missing: { type: "string" },
        },
        required: ["calls", "missing"],
      },
    },
    max_tokens: 600,
    temperature: 0,
  });
  const raw = typeof out.response === "string" ? out.response : JSON.stringify(out.response ?? {});
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1) || "{}"); }
  const seen = new Set();
  const calls = [];
  for (const c of Array.isArray(parsed.calls) ? parsed.calls : []) {
    const input = cleanInput(c.check, c.input);
    const key = `${c.check}:${JSON.stringify(input)}`;
    if (!input || seen.has(key) || calls.length >= MAX_CHECKS) continue;
    seen.add(key);
    calls.push({ check: c.check, input, why: String(c.why ?? CATALOG[c.check].about).slice(0, 90) });
  }
  return { raw, calls, missing: calls.length ? "" : String(parsed.missing || "Add the token, contract or wallet address you want checked.").slice(0, 200) };
}

const ANSWER_SYSTEM = `You answer a user's crypto question using only the paid check results you are given.
Write 3 to 6 short sentences in plain English. After each fact, cite the check it came from in square brackets, e.g. [honeypot].
Say clearly when a check failed or returned nothing, and do not guess beyond the data. End with one line starting "Bottom line:".`;

export async function answer(env, question, results) {
  const material = results
    .map((r) => `[${r.check}] ${r.ok ? JSON.stringify(r.data).slice(0, 2500) : `FAILED: ${r.error}`}`)
    .join("\n\n");
  const out = await env.AI.run(MODEL, {
    messages: [{ role: "system", content: ANSWER_SYSTEM }, { role: "user", content: `Question: ${question}\n\nResults:\n${material}` }],
    max_tokens: 500,
    temperature: 0.2,
  });
  return String(out.response ?? "").trim();
}
