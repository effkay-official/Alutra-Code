import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { askWithFallback } from "./providers.js";
import { MEMORY_PROMPT } from "./prompts.js";

const MAX_FACTS = 40;
const filePath = () => join(process.env.DATA_DIR || "./data", "memory.json");

async function readAll() {
  try {
    const all = JSON.parse(await readFile(filePath(), "utf8"));
    return Array.isArray(all) ? all : [];
  } catch { return []; }
}

export async function getMemory() {
  return readAll();
}

export async function addFacts(facts) {
  if (!Array.isArray(facts) || !facts.length) return;
  await mkdir(process.env.DATA_DIR || "./data", { recursive: true });
  const existing = await readAll();
  const seen = new Set(existing.map((fact) => fact.toLowerCase()));
  const clean = facts
    .filter((fact) => typeof fact === "string" && fact.trim().length > 2)
    .map((fact) => fact.trim())
    .filter((fact) => !seen.has(fact.toLowerCase()));
  const updated = [...clean, ...existing].slice(0, MAX_FACTS);
  if (clean.length) await writeFile(filePath(), JSON.stringify(updated, null, 2));
  return clean;
}

// Extract durable user facts from an exchange and persist them. Best effort;
// failures never break the chat flow.
export async function rememberFrom({ userText, assistantText, provider = "auto", keys = {} }) {
  try {
    if (!userText?.trim()) return [];
    const transcript = `User: ${userText}\nAssistant: ${String(assistantText || "").slice(0, 4000)}`;
    const { content } = await askWithFallback(provider, [{ role: "system", content: MEMORY_PROMPT }, { role: "user", content: transcript }], keys);
    let facts = [];
    try { facts = JSON.parse(content.match(/\[[\s\S]*\]/)?.[0] || "[]"); } catch {}
    return await addFacts(facts);
  } catch { return []; }
}

export async function memoryContext() {
  const facts = await readAll();
  if (!facts.length) return "";
  return `Long-term memory about the user (use to tailor your answer):\n${facts.map((fact) => `- ${fact}`).join("\n")}`;
}