import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve, relative, sep } from "node:path";
import { nanoid } from "nanoid";
import { AGENT_SYSTEM, PLANNER_SYSTEM } from "./prompts.js";
import { askWithFallback, ProviderError } from "./providers.js";

const execFileAsync = promisify(execFile);
const MAX_ACTIONS = 12;
const MAX_TURNS = 3;
const safeExecutables = new Set(["npm", "npx", "node"]);

function parseJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new ProviderError("The model returned an invalid agent response. Try again.", { status: 502 });
  return JSON.parse(match[0]);
}

function safePath(workspace, target) {
  const absolute = resolve(workspace, target);
  if (relative(workspace, absolute).startsWith("..") || !absolute.startsWith(workspace + sep)) throw new ProviderError("Agent attempted to access a path outside its workspace.", { status: 400 });
  return absolute;
}

async function runCommand(workspace, command) {
  const [executable, ...args] = command.trim().split(/\s+/);
  if (!safeExecutables.has(executable) || args.some((arg) => /[|;&<>`$()]/.test(arg))) throw new ProviderError(`Blocked unsafe agent command: ${command}`, { status: 400 });
  const { stdout, stderr } = await execFileAsync(executable, args, { cwd: workspace, timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  return `${stdout}${stderr}`.slice(-4000) || "Command completed.";
}

export async function runAgent({ task, provider, keys, onProgress }) {
  const planResult = await askWithFallback(provider, [{ role: "system", content: PLANNER_SYSTEM }, { role: "user", content: task }], keys);
  let plan;
  try { plan = JSON.parse(planResult.content); } catch { plan = ["Analyze the request", "Implement the requested project", "Verify the result"]; }
  onProgress({ type: "plan", plan, provider: planResult.provider });
  const workspace = resolve(process.env.WORKSPACE_ROOT || "./agent-workspaces", `task-${nanoid(8)}`);
  await mkdir(workspace, { recursive: true });
  const progress = [];
  let context = `Task: ${task}\nPlan:\n${plan.map((step, index) => `${index + 1}. ${step}`).join("\n")}\nWorkspace is empty: ${workspace}.`;
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const result = await askWithFallback(provider, [{ role: "system", content: AGENT_SYSTEM }, { role: "user", content: context }], keys);
    let response;
    try { response = parseJson(result.content); } catch (error) { onProgress({ type: "error", message: error.message }); break; }
    const actions = Array.isArray(response.actions) ? response.actions.slice(0, MAX_ACTIONS) : [];
    const outcomes = [];
    for (const action of actions) {
      try {
        if (action.type === "write" && typeof action.path === "string" && typeof action.content === "string") {
          const destination = safePath(workspace, action.path);
          await mkdir(resolve(destination, ".."), { recursive: true });
          await writeFile(destination, action.content, "utf8");
          const item = { type: "file", path: action.path, message: "Created" }; progress.push(item); onProgress(item); outcomes.push(`${action.path}: written`);
        } else if (action.type === "command" && typeof action.command === "string") {
          const output = await runCommand(workspace, action.command);
          const item = { type: "command", command: action.command, message: output }; progress.push(item); onProgress(item); outcomes.push(`${action.command}: ${output}`);
        }
      } catch (error) { const item = { type: "error", message: error.message }; progress.push(item); onProgress(item); outcomes.push(`ERROR: ${error.message}`); }
    }
    onProgress({ type: "execution", message: response.summary || "Agent iteration complete.", provider: result.provider });
    if (response.done || !actions.length) return { plan, progress, workspace, summary: response.summary || "Agent completed." };
    context = `Continue the task. Results from the last iteration:\n${outcomes.join("\n")}\nOnly return the next safe actions or mark done.`;
  }
  return { plan, progress, workspace, summary: "Agent reached its three-iteration limit. Review progress and continue with a follow-up task if needed." };
}
