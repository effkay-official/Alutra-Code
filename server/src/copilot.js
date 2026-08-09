import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderError } from "./providers.js";

const TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const CHAT_URL = "https://api.githubcopilot.com/chat/completions";

async function loadStoredToken() {
  try {
    const data = JSON.parse(await readFile(join(process.env.DATA_DIR || "./data", "github.json"), "utf8"));
    return data.accessToken || null;
  } catch { return null; }
}

let tokenCache = { token: null, at: 0 };
const CACHE_TTL_MS = 4 * 60 * 1000;

async function copilotToken() {
  if (tokenCache.token && Date.now() - tokenCache.at < CACHE_TTL_MS) return tokenCache.token;
  const githubToken = process.env.GITHUB_TOKEN || (await loadStoredToken());
  if (!githubToken) throw new ProviderError("GitHub Copilot needs a GitHub token with the copilot scope. Set GITHUB_TOKEN in server/.env or re-link GitHub with Copilot access using `gh auth login --scopes copilot`.", { status: 400 });
  const response = await fetch(TOKEN_URL, { headers: { Authorization: `Bearer ${githubToken}`, "User-Agent": "alutra-code" } });
  const text = await response.text();
  if (!response.ok) throw new ProviderError(`Copilot token exchange failed (${response.status}). This usually means the token lacks the copilot scope or Copilot is not enabled for the account. Run \`gh auth login --scopes copilot\` on the server machine and set GITHUB_TOKEN in server/.env.`, { status: 502 });
  const data = JSON.parse(text);
  if (!data.token) throw new ProviderError("Copilot returned no token. Ensure GitHub Copilot is enabled for your account.", { status: 502 });
  tokenCache = { token: data.token, at: Date.now() };
  return data.token;
}

export async function isCopilotConfigured() {
  try { await copilotToken(); return true; } catch { return false; }
}

export async function copilotAsk(model, messages) {
  const token = await copilotToken();
  const response = await fetch(CHAT_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ model, messages, temperature: 0.2, stream: false }) });
  const text = await response.text();
  if (!response.ok) throw new ProviderError(`Copilot request failed (${response.status}): ${text.slice(0, 300)}`, { retryable: response.status === 429 || response.status >= 500, status: response.status });
  return JSON.parse(text).choices?.[0]?.message?.content || "";
}

export async function* streamCopilot(model, messages) {
  const token = await copilotToken();
  const response = await fetch(CHAT_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ model, messages, temperature: 0.2, stream: true }) });
  if (!response.ok) throw new ProviderError(`Copilot request failed (${response.status}): ${(await response.text()).slice(0, 300)}`, { retryable: response.status === 429 || response.status >= 500, status: response.status });
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
      try { const piece = JSON.parse(data); const tokenChunk = piece.choices?.[0]?.delta?.content; if (typeof tokenChunk === "string" && tokenChunk) yield tokenChunk; } catch {}
    }
  }
}
