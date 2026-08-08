import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const filePath = () => join(process.env.DATA_DIR || "./data", "conversations.json");

async function readAll() {
  try { return JSON.parse(await readFile(filePath(), "utf8")); } catch { return {}; }
}

export async function saveConversation(id, messages) {
  await mkdir(process.env.DATA_DIR || "./data", { recursive: true });
  const all = await readAll();
  all[id] = { updatedAt: new Date().toISOString(), messages: messages.slice(-40) };
  await writeFile(filePath(), JSON.stringify(all, null, 2));
}

export async function getConversation(id) {
  const all = await readAll();
  return all[id]?.messages || [];
}
