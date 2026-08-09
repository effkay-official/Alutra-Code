import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const filePath = () => join(process.env.DATA_DIR || "./data", "conversations.json");

async function readAll() {
  try { return JSON.parse(await readFile(filePath(), "utf8")); } catch { return {}; }
}

export async function saveConversation(id, messages) {
  await mkdir(process.env.DATA_DIR || "./data", { recursive: true });
  const all = await readAll();
  const firstUser = messages.find((message) => message.role === "user")?.content || "New conversation";
  all[id] = { updatedAt: new Date().toISOString(), title: firstUser.replace(/\s+/g, " ").slice(0, 60), messages: messages.slice(-40) };
  await writeFile(filePath(), JSON.stringify(all, null, 2));
}

export async function getConversation(id) {
  const all = await readAll();
  return all[id]?.messages || [];
}

export async function listConversations() {
  const all = await readAll();
  return Object.entries(all)
    .map(([id, entry]) => ({ id, title: entry.title || (entry.messages?.[0]?.content || "Conversation").slice(0, 60), updatedAt: entry.updatedAt, count: (entry.messages || []).length }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function deleteConversation(id) {
  const all = await readAll();
  delete all[id];
  await writeFile(filePath(), JSON.stringify(all, null, 2));
}
