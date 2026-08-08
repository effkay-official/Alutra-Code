import { PROVIDERS } from "../../shared/providers.js";

export class ProviderError extends Error {
  constructor(message, { retryable = false, status = 500 } = {}) { super(message); this.retryable = retryable; this.status = status; }
}

function apiError(response, text) {
  return new ProviderError(`Provider request failed (${response.status}): ${text.slice(0, 300)}`, { retryable: response.status === 429 || response.status >= 500, status: response.status });
}

async function openAiCompatible(url, key, model, messages) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages, temperature: 0.2 }) });
  const text = await response.text();
  if (!response.ok) throw apiError(response, text);
  return JSON.parse(text).choices?.[0]?.message?.content || "";
}

export async function askProvider(id, messages, browserKeys = {}) {
  const provider = PROVIDERS[id];
  if (!provider) throw new ProviderError("Unknown model provider.", { status: 400 });
  const key = browserKeys[id] || process.env[provider.key];
  if (!key) throw new ProviderError(`${provider.label} needs an API key. Add it in server/.env or the local key form.`, { status: 400 });
  const model = process.env[provider.modelEnv] || provider.model;
  if (id === "openai") return openAiCompatible("https://api.openai.com/v1/chat/completions", key, model, messages);
  if (id === "deepseek") return openAiCompatible("https://api.deepseek.com/chat/completions", key, model, messages);
  if (id === "perplexity") return openAiCompatible("https://api.perplexity.ai/chat/completions", key, model, messages);
  if (id === "anthropic") {
    const system = messages.find((message) => message.role === "system")?.content || "";
    const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 4096, system, messages: messages.filter((message) => message.role !== "system") }) });
    const text = await response.text(); if (!response.ok) throw apiError(response, text);
    return JSON.parse(text).content?.map((item) => item.text || "").join("") || "";
  }
  const latest = messages.filter((message) => message.role !== "system").map((message) => `${message.role}: ${message.content}`).join("\n");
  const system = messages.find((message) => message.role === "system")?.content || "";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: latest }] }], generationConfig: { temperature: 0.2 } }) });
  const text = await response.text(); if (!response.ok) throw apiError(response, text);
  return JSON.parse(text).candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
}

const cooldowns = new Map();
export async function askWithFallback(selected, messages, keys) {
  const available = Object.keys(PROVIDERS).filter((id) => keys[id] || process.env[PROVIDERS[id].key]);
  const candidates = selected === "auto" ? available : [selected];
  if (!candidates.length) throw new ProviderError("No API keys are configured. Add at least one provider key.", { status: 400 });
  let lastError;
  for (const id of candidates) {
    if ((cooldowns.get(id) || 0) > Date.now()) continue;
    try { return { content: await askProvider(id, messages, keys), provider: id }; }
    catch (error) { lastError = error; if (error.retryable) cooldowns.set(id, Date.now() + 60_000); else if (selected !== "auto") throw error; }
  }
  throw lastError || new ProviderError("Every configured free provider is temporarily cooling down. Try again in a minute.", { status: 429 });
}
