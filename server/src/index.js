import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../.env") });

// Resolve relative data/workspace paths against the server directory,
// regardless of which CWD launched the process (dev, CLI, or Docker).
// Absolute values (e.g. Electron's userData dirs) are left untouched.
const serverRoot = resolve(__dirname, "..");
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = join(serverRoot, "data");
} else if (!isAbsolute(process.env.DATA_DIR)) {
  process.env.DATA_DIR = resolve(serverRoot, process.env.DATA_DIR);
}
if (!process.env.WORKSPACE_ROOT) {
  process.env.WORKSPACE_ROOT = join(serverRoot, "agent-workspaces");
} else if (!isAbsolute(process.env.WORKSPACE_ROOT)) {
  process.env.WORKSPACE_ROOT = resolve(serverRoot, process.env.WORKSPACE_ROOT);
}

import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import { PROVIDERS, providerOptions } from "../../shared/providers.js";
import { DAILY_SYSTEM, DAILY_TEMPLATES } from "./prompts.js";
import { askWithFallback, streamWithFallback, isProviderConfigured } from "./providers.js";
import { getConversation, saveConversation, listConversations, deleteConversation } from "./store.js";
import { rememberFrom, memoryContext } from "./memory.js";
import { runAgent, summarizeSession, resolvePermission } from "./agent.js";
import {
  getAuthorizeUrl, getToken, getGithubUser, newState, exchangeCode, clearToken, isGithubConfigured, listRepos, createGithubRepo, redirectUri
} from "./github.js";

const app = express();
const allowedOrigins = (process.env.ALLOWED_ORIGIN || "http://localhost:5173").split(",").map((o) => o.trim()).filter(Boolean);
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)) }));
app.use(express.json({ limit: "1mb" }));

const clientDist = resolve(__dirname, "../../client/dist");
if (existsSync(join(clientDist, "index.html"))) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api\/).*/, (_request, response) => response.sendFile(join(clientDist, "index.html")));
}

const keySet = (value) => typeof value === "string" && value.length > 10;
const validKeys = (keys) => Object.fromEntries(Object.entries(keys || {}).filter(([id, value]) => PROVIDERS[id] && keySet(value)));

app.get("/api/providers", async (_request, response) => {
  const list = [];
  for (const item of providerOptions) list.push({ ...item, configured: await isProviderConfigured(item.id) });
  response.json({ providers: list });
});

function sendEvent(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

app.post("/api/chat/stream", async (request, response, next) => {
  try {
    const { content, conversationId = nanoid(), provider = "auto", keys = {}, template = "coder" } = request.body;
    if (!content?.trim()) return response.status(400).json({ error: "A message is required." });
    const system = DAILY_TEMPLATES[template] || DAILY_SYSTEM;
    const memory = await memoryContext();
    const history = await getConversation(conversationId);
    const messages = [{ role: "system", content: memory ? `${system}\n\n${memory}` : system }, ...history, { role: "user", content: content.trim() }];
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.write(`retry: 2000\n\n`);
    let emitted = false;
    const pieces = [];
    try {
      for await (const token of streamWithFallback(provider, messages, validKeys(keys))) {
        emitted = true;
        pieces.push(token);
        sendEvent(response, { type: "token", text: token });
      }
      if (!emitted) throw new Error("The provider returned no text. Try a different model or add a provider key.");
      const assistantText = pieces.join("");
      const updated = [...history, { role: "user", content: content.trim() }, { role: "assistant", content: assistantText }];
      await saveConversation(conversationId, updated);
      rememberFrom({ userText: content.trim(), assistantText, provider, keys: validKeys(keys) });
      sendEvent(response, { type: "done", conversationId, provider });
    } catch (error) {
      if (!response.headersSent) return next(error);
      sendEvent(response, { type: "error", message: error.message || "Streaming failed." });
    }
    response.end();
  } catch (error) { next(error); }
});

app.post("/api/agent/stream", async (request, response, next) => {
  try {
    const { task, provider = "auto", keys = {} } = request.body;
    if (!task?.trim()) return response.status(400).json({ error: "A task is required." });
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.write(`retry: 2000\n\n`);
    const onEvent = (event) => {
      sendEvent(response, event);
    };
    const result = await runAgent({ task: task.trim(), provider, keys: validKeys(keys), onEvent });
    sendEvent(response, { type: "done", ...result });
    response.end();
  } catch (error) {
    sendEvent(response, { type: "error", message: error.message });
    response.end();
  }
});

// Non-streaming chat (kept for compatibility / quick API use).
app.post("/api/chat", async (request, response, next) => {
  try {
    const { content, conversationId = nanoid(), provider = "auto", keys = {}, template = "coder" } = request.body;
    if (!content?.trim()) return response.status(400).json({ error: "A message is required." });
    const system = DAILY_TEMPLATES[template] || DAILY_SYSTEM;
    const memory = await memoryContext();
    const history = await getConversation(conversationId);
    const messages = [{ role: "system", content: memory ? `${system}\n\n${memory}` : system }, ...history, { role: "user", content: content.trim() }];
    const result = await askWithFallback(provider, messages, validKeys(keys));
    const updated = [...history, { role: "user", content: content.trim() }, { role: "assistant", content: result.content }];
    await saveConversation(conversationId, updated);
    rememberFrom({ userText: content.trim(), assistantText: result.content, provider, keys: validKeys(keys) });
    response.json({ conversationId, content: result.content, provider: result.provider });
  } catch (error) { next(error); }
});

app.post("/api/agent/permission", async (request, response) => {
  const { id, allow, always = false } = request.body || {};
  if (!id) return response.status(400).json({ error: "A permission id is required." });
  const resolved = resolvePermission(id, { allow: Boolean(allow), always: Boolean(always) });
  if (!resolved) return response.status(404).json({ error: "Permission request not found or already answered." });
  response.json({ ok: true });
});

// Session management (list, load, delete).
app.get("/api/sessions", async (_request, response, next) => {
  try { response.json({ sessions: await listConversations() }); } catch (error) { next(error); }
});

app.get("/api/sessions/:id", async (request, response, next) => {
  try {
    const history = await getConversation(request.params.id);
    if (!history.length) return response.status(404).json({ error: "Conversation not found." });
    response.json({ conversationId: request.params.id, messages: history });
  } catch (error) { next(error); }
});

app.delete("/api/sessions/:id", async (request, response, next) => {
  try { await deleteConversation(request.params.id); response.json({ ok: true }); } catch (error) { next(error); }
});

app.post("/api/sessions/compact", async (request, response, next) => {
  try {
    const { conversationId, provider = "auto", keys = {} } = request.body;
    if (!conversationId) return response.status(400).json({ error: "A conversationId is required." });
    const history = await getConversation(conversationId);
    if (!history.length) return response.status(400).json({ error: "No conversation to compact." });
    const summary = await summarizeSession(history, provider, validKeys(keys));
    const newConversationId = nanoid();
    await saveConversation(newConversationId, [{ role: "user", content: "Summary of previous session:\n" + summary }]);
    response.json({ conversationId: newConversationId, summary });
  } catch (error) { next(error); }
});

app.get("/api/github/status", async (_request, response, next) => {
  try {
    const configured = isGithubConfigured();
    const user = await getGithubUser();
    response.json({ configured, user });
  } catch (error) { next(error); }
});

app.post("/api/github/connect", async (_request, response, next) => {
  try {
    if (!isGithubConfigured()) return response.status(409).json({ error: "GitHub OAuth is not configured. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to server/.env." });
    const state = newState();
    response.json({ authorizeUrl: getAuthorizeUrl(state), redirectUri: redirectUri() });
  } catch (error) { next(error); }
});

app.get("/api/github/callback", async (request, response, next) => {
  try {
    const { code, state } = request.query;
    await exchangeCode(code, state);
    const origin = process.env.ALLOWED_ORIGIN || `${request.protocol}://${request.get("host")}`;
    response.redirect(`${origin}/?github=connected`);
  } catch (error) { next(error); }
});

app.post("/api/github/disconnect", async (_request, response) => {
  await clearToken();
  response.json({ ok: true });
});

app.get("/api/github/repos", async (request, response, next) => {
  try {
    const prefix = typeof request.query.q === "string" ? request.query.q : "";
    const user = await getGithubUser();
    if (!user) return response.json({ repos: [] });
    response.json({ repos: await listRepos(user, prefix) });
  } catch (error) { next(error); }
});

app.post("/api/github/repos", async (request, response, next) => {
  try {
    const { name, description = "", private: isPrivate = false } = request.body || {};
    if (!name?.trim()) return response.status(400).json({ error: "A repo name is required." });
    response.json(await createGithubRepo({ name: name.trim(), description, private: isPrivate }));
  } catch (error) { next(error); }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || 500).json({ error: error.message || "Unexpected server error." });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`Alutra Code API listening at http://localhost:${port}`));
