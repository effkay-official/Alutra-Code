import "dotenv/config";
import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import { PROVIDERS, providerOptions } from "../../shared/providers.js";
import { DAILY_SYSTEM } from "./prompts.js";
import { askWithFallback } from "./providers.js";
import { getConversation, saveConversation } from "./store.js";
import { runAgent } from "./agent.js";

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

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

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || 500).json({ error: error.message || "Unexpected server error." });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`Alutra Code API listening at http://localhost:${port}`));
