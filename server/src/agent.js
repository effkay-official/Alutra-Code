import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { nanoid } from "nanoid";
import { PLANNER_SYSTEM, AGENT_SYSTEM, SUBAGENT_SYSTEM, SUMMARIZER_SYSTEM } from "./prompts.js";
import { askWithFallback } from "./providers.js";
import { executeTool, requiresPermission, promptForToolUse } from "./tools.js";

const MAX_TURNS = 6;
const MAX_ACTIONS_PER_TURN = 10;

function parseJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Invalid agent response: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

function permissionKey(toolName, args) {
  if (toolName === "bash") return `bash:${(args.command || "").trim()}`;
  if (toolName === "write") return `write:${args.path}`;
  if (toolName === "edit") return `edit:${args.path}`;
  return `${toolName}:${JSON.stringify(args || {})}`;
}

function needsApproval(toolName, args) {
  if (toolName === "bash") {
    try { return requiresPermission(String(args.command || "")); } catch { return true; }
  }
  return toolName === "write" || toolName === "edit" || toolName === "fetch" || toolName === "agent";
}

const pendingRequests = new Map();

// Returns [promise, id]. The permission event with this id is emitted over SSE;
// the client answers via POST /api/agent/permission:resolve/{id}.
export function createPermissionRequest(payload) {
  const id = randomUUID();
  const promise = new Promise((resolve) => {
    const entry = { resolve, answered: false };
    pendingRequests.set(id, entry);
    setTimeout(() => { const current = pendingRequests.get(id); if (current && !current.answered) { current.resolve({ allow: false, reason: "Timed out waiting for approval." }); pendingRequests.delete(id); } }, 120_000);
  });
  return { promise, id };
}

export function resolvePermission(id, decision) {
  const entry = pendingRequests.get(id);
  if (!entry) return false;
  entry.answered = true;
  entry.resolve(decision);
  pendingRequests.delete(id);
  return true;
}

export async function runAgent({ task, provider, keys, onEvent, _ask = askWithFallback, _sub = askWithFallback }) {
  const planResult = await _ask(provider, [{ role: "system", content: PLANNER_SYSTEM }, { role: "user", content: task }], keys);
  let plan;
  try { plan = JSON.parse(planResult.content); } catch { plan = ["Analyze the request", "Implement the requested project", "Verify the result"]; }
  onEvent({ type: "plan", plan, provider: planResult.provider });

  const workspaceRoot = process.env.WORKSPACE_ROOT || "./agent-workspaces";
  const workspace = resolve(workspaceRoot, `task-${nanoid(8)}`);
  await mkdir(workspace, { recursive: true });
  onEvent({ type: "info", message: `Workspace: ${workspace}` });

  const progress = [];
  const toolPrompt = promptForToolUse();
  const approved = new Set();
  const denied = new Set();
  let context = `Task: ${task}\nPlan:\n${plan.map((step, index) => `${index + 1}. ${step}`).join("\n")}\nWorkspace: ${workspace}`;

  async function callSubagent(prompt) {
    const { content } = await _sub(provider, [{ role: "system", content: SUBAGENT_SYSTEM }, { role: "user", content: prompt }], keys);
    return content;
  }

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const result = await _ask(provider, [
      { role: "system", content: `${AGENT_SYSTEM}\n\n${toolPrompt}` },
      { role: "user", content: context }
    ], keys);
    let response;
    try { response = parseJson(result.content); } catch (error) { onEvent({ type: "error", message: error.message }); break; }
    const actions = Array.isArray(response.actions) ? response.actions.slice(0, MAX_ACTIONS_PER_TURN) : [];
    const outcomes = [];

    for (const action of actions) {
      const toolName = action.tool;
      try {
        if (!toolName) throw new Error("Action missing a tool name.");
        const args = action.arguments || {};
        const key = permissionKey(toolName, args);
        if (needsApproval(toolName, args) && !approved.has(key)) {
          if (denied.has(key)) { outcomes.push(`${toolName}: skipped (previous denial)`); continue; }
          const { promise, id } = createPermissionRequest({ tool: toolName, args, reason: action.reason || "" });
          onEvent({ type: "permission", id, tool: toolName, args, reason: action.reason || "" });
          const decision = await promise;
          if (!decision.allow) { denied.add(key); outcomes.push(`${toolName}: not approved by user`); continue; }
          if (decision.always) approved.add(key);
        }
        const toolResult = await executeTool({ tool: toolName, arguments: args }, { workspace, callSubagent });
        progress.push(toolResult);
        onEvent(toolResult);
        outcomes.push(`${toolName}: ${toolResult.message}`);
      } catch (error) {
        const item = { type: "error", message: error.message };
        progress.push(item); onEvent(item); outcomes.push(`ERROR: ${error.message}`);
      }
    }

    onEvent({ type: "execution", message: response.summary || "Agent iteration complete.", provider: result.provider });
    if (response.done || !actions.length) return { plan, progress, workspace, summary: response.summary || "Agent completed. Reviewed by Alutra Code.", provider: result.provider };
    context = `Continue the task. Latest results:\n${outcomes.join("\n") || "No actions executed yet."}\nOnly return the next safe actions, or mark done when complete.`;
  }
  return { plan, progress, workspace, summary: `Agent reached its ${MAX_TURNS}-iteration limit. Review progress and continue with a follow-up task if needed.` };
}

export async function summarizeSession(messages, provider, keys) {
  const { content } = await askWithFallback(provider, [{ role: "system", content: SUMMARIZER_SYSTEM }, { role: "user", content: `Summarize this conversation so a new session can continue without losing context:\n\n${messages.map((m) => `${m.role}: ${m.content}`).join("\n")}` }], keys);
  return content;
}