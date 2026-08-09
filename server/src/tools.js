import { execFile } from "node:child_process";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, relative, resolve, sep, basename, dirname } from "node:path";
import { promisify } from "node:util";
import { ProviderError } from "./providers.js";

const execFileAsync = promisify(execFile);
const operatorPattern = /[|;&<>$()`]/;
const isWindows = process.platform === "win32";
const shellBuiltins = new Set(["echo", "cd", "type", "dir", "cls", "copy", "del", "rmdir", "mkdir", "pwd", "set", "pushd", "popd", "where", "rename", "move", "date", "time", "ver"]);

export function parseCommand(command) {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new ProviderError("Empty command.", { status: 400 });
  const executable = tokens[0].toLowerCase();
  if (tokens.slice(1).some((arg) => operatorPattern.test(arg))) throw new ProviderError(`Blocked unsafe command: ${command}`, { status: 400 });
  return { executable, args: tokens.slice(1) };
}

export function requiresPermission(command) {
  try {
    const { executable } = parseCommand(command);
    return networkExecutables.has(executable) || !harmlessExecutables.has(executable);
  } catch { return true; }
}

const harmfulExecutables = new Set(["rm", "del", "erase", "format", "shutdown", "sudo", "su", "chmod", "chown", "passwd", "nc", "telnet", "ssh", "scp", "socat", "nslookup", "dig", "traceroute", "powershell", "cmd", "pwsh", "bash", "sh"]);
const networkExecutables = new Set(["npm", "npx", "node", "git", "curl", "wget", "pip", "pip3", "python", "python3", "go", "cargo", "gh"]);
const harmlessExecutables = new Set(["ls", "cat", "find", "grep", "head", "tail", "wc", "echo", "pwd", "true", "false", "sleep", "mkdir", "touch", "rg", "jq", "date", "uname", "whoami", "stat", "sed", "awk", "sort", "uniq", "git", "node", "npm", "npx"]);

export function blockReason(exe) {
  if (harmfulExecutables.has(exe)) return `Blocked executable: ${exe}`;
  return null;
}

export const TOOL_CATALOG = {
  write: { name: "write", args: ["path", "content"], description: "Create or overwrite a file inside the workspace with full content." },
  edit: { name: "edit", args: ["path", "old_string", "new_string"], description: "Replace old_string with new_string in an existing workspace file." },
  read: { name: "read", args: ["path", "offset?", "limit?"], description: "Read file content from a path; optional line offset and limit." },
  ls: { name: "ls", args: ["path?"], description: "List a directory inside the workspace." },
  glob: { name: "glob", args: ["pattern"], description: "Find files by glob pattern inside the workspace." },
  grep: { name: "grep", args: ["pattern", "path?", "include?"], description: "Search file contents with a regular expression." },
  bash: { name: "bash", args: ["command", "timeout?"], description: "Run a command in the workspace. Network or mutating commands require approval." },
  fetch: { name: "fetch", args: ["url"], description: "Download a URL and return its visible text (network is not permitted by default)." },
  agent: { name: "agent", args: ["prompt"], description: "Ask a briefly-scoped sub-agent; returns its final result." }
};

export function promptForToolUse() {
  const lines = Object.values(TOOL_CATALOG).map((tool) => {
    const args = Object.entries(tool.args).map(([name, desc]) => `${name}:${desc}`).join(", ");
    return `- ${tool.name}(${args}): ${tool.description}`;
  });
  return `Available tools:\n${lines.join("\n")}\nReturn ONLY JSON: {"summary":"short progress update","actions":[{"tool":"write","reason":"one-line safety justification","arguments":{...}},{"tool":"bash","reason":"...","arguments":{command:"..."}}],"done":false}`;
}

export function safePathInside(workspace, target) {
  const absolute = resolve(workspace, target || ".");
  if (relative(workspace, absolute).startsWith("..") || absolute !== workspace && !absolute.startsWith(workspace + sep)) throw new ProviderError("Agent attempted to access a path outside its workspace.", { status: 400 });
  return absolute;
}

export async function executeTool(tool, { workspace, callSubagent }) {
  const { arguments: args = {} } = tool;
  switch (tool.tool) {
    case "write": {
      const path = safePathInside(workspace, args.path);
      await mkdir(resolve(dirname(path)), { recursive: true });
      await writeFile(path, String(args.content ?? ""), "utf8");
      return { type: "file", path: args.path, message: `${String(args.content || "").length} bytes written` };
    }
    case "edit": {
      const path = safePathInside(workspace, args.path);
      const content = await readFile(path, "utf8");
      const oldString = String(args.old_string || args.oldString || "");
      if (!oldString) throw new ProviderError(`edit on ${args.path} requires old_string.`);
      if (!content.includes(oldString)) throw new ProviderError(`old_string not found in ${args.path}.`);
      await writeFile(path, content.replace(oldString, String(args.new_string ?? "")), "utf8");
      return { type: "event", path: args.path, message: `${oldString.length} chars replaced` };
    }
    case "read": {
      const path = safePathInside(workspace, args.path);
      const raw = await readFile(path, "utf8");
      const lines = raw.split("\n");
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Number(args.limit) || lines.length;
      const out = lines.slice(offset - 1, offset - 1 + limit).join("\n");
      return { type: "tool", message: `Read ${args.path} (${lines.length} lines).\n${out.slice(0, 12_000)}` };
    }
    case "ls": {
      const dir = safePathInside(workspace, args.path || ".");
      const entries = await readdir(dir, { withFileTypes: true });
      const lines = entries.map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`).sort();
      return { type: "event", message: lines.join("\n") || "(empty)" };
    }
case "glob": {
      const { glob } = await import("node:fs");
      const matches = [];
      for await (const file of glob (args.pattern, { cwd: workspace, absolute: true })) matches.push(relative(workspace, file));
      return { type: "event", message: matches.slice(0, 500).join("\n") || "No matches." };
    }
    case "grep": {
      const { stdout, stderr } = await grepFiles(workspace, args);
      return { type: "event", message: `${stdout}${stderr}`.slice(0, 12_000) || "No matches." };
    }
    case "bash": {
      const { executable, args: cmdArgs } = parseCommand(args.command);
      const blocked = blockReason(executable);
      if (blocked) throw new ProviderError(blocked, { status: 403 });
      const timeoutSeconds = Math.min(Number(args.timeout) || 60, 600);
      const { stdout, stderr } = await runCommand({ executable, args: cmdArgs, command: args.command, cwd: workspace, timeout: timeoutSeconds * 1000 });
      return { type: "command", command: args.command, message: `${stdout}${stderr}`.slice(-8000) || "Command completed." };
    }
    case "fetch": {
      const response = await fetch(String(args.url));
      const text = await response.text();
      if (!response.ok) throw new ProviderError(`Fetch ${args.url} failed: ${response.status}.`, { status: 502 });
      return { type: "event", message: text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 10_000) };
    }
    case "agent": {
      const result = callSubagent ? await callSubagent(String(args.prompt || "")) : "(sub-agent unavailable)";
      return { type: "event", message: result };
    }
    default:
      throw new ProviderError(`Unknown tool: ${tool.tool}.`, { status: 400 });
  }
}

async function runCommand({ executable, args, command, cwd, timeout }) {
  const opts = { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
  // Shell built-ins (echo, cd, type, ...) aren't executable files; run them
  // through the platform shell. Operators are already rejected by parseCommand.
  if (isWindows && shellBuiltins.has(executable)) {
    const { execFile: run } = await import("node:child_process");
    const { promisify: toPromise } = await import("node:util");
    const runAsync = toPromise(run);
    const { stdout, stderr } = await runAsync("cmd", ["/d", "/s", "/c", command], opts);
    return { stdout, stderr };
  }
  try {
    return await execFileAsync(executable, args, opts);
  } catch (error) {
    if (error.code === "ENOENT" && isWindows) {
      const windowsPath = executable.endsWith(".cmd") ? executable : `${executable}.cmd`;
      try { return await execFileAsync(windowsPath, args, opts); } catch {}
    }
    throw error;
  }
}

async function grepFiles(workspace, args) {
  const pattern = String(args.pattern || "");
  if (!pattern) throw new ProviderError("grep requires a pattern.");
  const include = String(args.include || "");
  const matches = [];
  const seen = new Set();
  const stack = [workspace];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (include && !entry.name.endsWith(include)) continue;
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        const content = await readFile(full, "utf8");
        const re = new RegExp(pattern, "i");
        content.split("\n").forEach((line, index) => { if (re.test(line)) matches.push(`${relative(workspace, full)}:${index + 1}: ${line.trim().slice(0, 160)}`); });
      } catch {}
    }
    if (matches.length > 400) break;
  }
  return { stdout: matches.join("\n"), stderr: "" };
}