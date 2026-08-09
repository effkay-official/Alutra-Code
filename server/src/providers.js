import { PROVIDERS } from "../../shared/providers.js";
import { copilotAsk, streamCopilot, isCopilotConfigured } from "./copilot.js";

export class ProviderError extends Error {
  constructor(message, { retryable = false, status = 500 } = {}) { super(message); this.retryable = retryable; this.status = status; }
}

function apiError(response, text) {
  return new ProviderError(`Provider request failed (${response.status}): ${text.slice(0, 300)}`, { retryable: response.status === 429 || response.status >= 500, status: response.status });
}

export function estimateTokens(messages) {
  return messages.reduce((sum, message) => sum + Math.ceil((message.content || "").length / 4), 0);
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
  const model = process.env[provider.modelEnv] || provider.model;
  if (id === "copilot") return copilotAsk(model, messages);
  const key = browserKeys[id] || process.env[provider.key];
  if (!key) throw new ProviderError(`${provider.label} needs an API key. Add it in server/.env or the local key form.`, { status: 400 });
  if (id === "openai") return openAiCompatible("https://api.openai.com/v1/chat/completions", key, model, messages);
  if (id === "openrouter") return openAiCompatible("https://openrouter.ai/api/v1/chat/completions", key, model, messages);
  if (id === "zen") return openAiCompatible("https://opencode.ai/zen/v1/chat/completions", key, model, messages);
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

async function* streamOpenAiCompatible(url, key, model, messages) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages, temperature: 0.2, stream: true, stream_options: { include_usage: false } }) });
  if (!response.ok) throw apiError(response, await response.text());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try { const piece = JSON.parse(data); const token = piece.choices?.[0]?.delta?.content; if (typeof token === "string" && token) yield token; } catch {}
    }
  }
}

async function* streamAnthropic(model, key, system, messages) {
  const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 4096, system, stream: true, messages: messages.filter((message) => message.role !== "system") }) });
  if (!response.ok) throw apiError(response, await response.text());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const event = JSON.parse(line.slice(5).trim());
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) yield event.delta.text;
      } catch {}
    }
  }
}

async function* streamGemini(model, key, system, messages) {
  const latest = messages.filter((message) => message.role !== "system").map((message) => `${message.role}: ${message.content}`).join("\n");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: latest }] }], generationConfig: { temperature: 0.2 } }) });
  if (!response.ok) throw apiError(response, await response.text());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const event = JSON.parse(line.slice(5).trim());
        const token = event.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
        if (token) yield token;
      } catch {}
    }
  }
}

export async function* streamProvider(id, messages, browserKeys = {}) {
  const provider = PROVIDERS[id];
  if (!provider) throw new ProviderError("Unknown model provider.", { status: 400 });
  const model = process.env[provider.modelEnv] || provider.model;
  if (id === "copilot") { yield* streamCopilot(model, messages); return; }
  const key = browserKeys[id] || process.env[provider.key];
  if (!key) throw new ProviderError(`${provider.label} needs an API key. Add it in server/.env or the local key form.`, { status: 400 });
  if (id === "openai") { yield* streamOpenAiCompatible("https://api.openai.com/v1/chat/completions", key, model, messages); return; }
  if (id === "openrouter") { yield* streamOpenAiCompatible("https://openrouter.ai/api/v1/chat/completions", key, model, messages); return; }
  if (id === "zen") { yield* streamOpenAiCompatible("https://opencode.ai/zen/v1/chat/completions", key, model, messages); return; }
  if (id === "deepseek") { yield* streamOpenAiCompatible("https://api.deepseek.com/chat/completions", key, model, messages); return; }
  if (id === "perplexity") { yield* streamOpenAiCompatible("https://api.perplexity.ai/chat/completions", key, model, messages); return; }
  const system = messages.find((message) => message.role === "system")?.content || "";
  if (id === "anthropic") { yield* streamAnthropic(model, key, system, messages); return; }
  yield* streamGemini(model, key, system, messages);
}

export async function* streamWithFallback(selected, messages, keys) {
  const available = await availableProviders(keys);
  const candidates = selected === "auto" ? available : [selected];
  if (!candidates.length) throw new ProviderError("No API keys are configured. Add at least one provider key.", { status: 400 });
  let lastError;
  for (const id of candidates) {
    if ((cooldowns.get(id) || 0) > Date.now()) { lastError = new ProviderError(`${PROVIDERS[id].label} is cooling down.`); continue; }
    try {
      let emitted = false;
      for await (const token of streamProvider(id, messages, keys)) { emitted = true; yield token; }
      if (emitted) return;
      lastError = new ProviderError(`${PROVIDERS[id].label} returned an empty response.`, { retryable: true });
    } catch (error) {
      lastError = error;
      if (error.retryable) { cooldowns.set(id, Date.now() + 60_000); continue; }
      if (selected !== "auto") throw error;
    }
  }
  throw lastError || new ProviderError("Every configured provider failed. Try again in a minute.", { status: 429 });
}

const cooldowns = new Map();
async function availableProviders(keys) {
  const usable = [];
  for (const id of Object.keys(PROVIDERS)) {
    if (id === "copilot") { if (await isCopilotConfigured()) usable.push(id); }
    else if (keys[id] || process.env[PROVIDERS[id].key]) usable.push(id);
  }
  return usable;
}

export async function isProviderConfigured(id, keys = {}) {
  if (id === "copilot") return isCopilotConfigured();
  return Boolean(keys[id] || process.env[PROVIDERS[id].key]);
}

export async function askWithFallback(selected, messages, keys) {
  const available = await availableProviders(keys);
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