import "dotenv/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import { PROVIDERS, providerOptions } from "../../shared/providers.js";
import { DAILY_SYSTEM } from "./prompts.js";
import { askWithFallback } from "./providers.js";
import { getConversation, saveConversation } from "./store.js";
import { runAgent } from "./agent.js";
import {
  getAuthorizeUrl, getToken, getGithubUser, newState, exchangeCode, clearToken, isGithubConfigured, listRepos, createGithubRepo
} from "./github.js";

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = resolve(__dirname, "../../client/dist");
if (existsSync(join(clientDist, "index.html"))) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api\/).*/, (_request, response) => response.sendFile(join(clientDist, "index.html")));
}

const keySet = (value) => typeof value === "string" && value.length > 10;
const validKeys = (keys) => Object.fromEntries(Object.entries(keys || {}).filter(([id, value]) => PROVIDERS[id] && keySet(value)));

app.get("/api/providers", (_request, response) => response.json({ providers: providerOptions.map((item) => ({ ...item, configured: Boolean(process.env[PROVIDERS[item.id].key]) })) }));

app.post("/api/chat", async (request, response, next) => {
  try {
    const { content, conversationId = nanoid(), provider = "auto", keys = {} } = request.body;
    if (!content?.trim()) return response.status(400).json({ error: "A message is required." });
    const history = await getConversation(conversationId);
    const messages = [{ role: "system", content: DAILY_SYSTEM }, ...history, { role: "user", content: content.trim() }];
    const result = await askWithFallback(provider, messages, validKeys(keys));
    const updated = [...history, { role: "user", content: content.trim() }, { role: "assistant", content: result.content }];
    await saveConversation(conversationId, updated);
    response.json({ conversationId, content: result.content, provider: result.provider });
  } catch (error) { next(error); }
});

app.post("/api/agent", async (request, response, next) => {
  try {
    const { task, provider = "auto", keys = {} } = request.body;
    if (!task?.trim()) return response.status(400).json({ error: "A task is required." });
    const events = [];
    const result = await runAgent({ task: task.trim(), provider, keys: validKeys(keys), onProgress: (event) => events.push(event) });
    response.json({ ...result, events });
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
    response.json({ authorizeUrl: getAuthorizeUrl(state), redirectUri: `http://localhost:${process.env.PORT || 8787}/api/github/callback` });
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
