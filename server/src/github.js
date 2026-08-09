import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const AUTH_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const SCOPES = ["repo", "workflow", "read:user"];

export function isGithubConfigured() {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

function tokenFilePath() {
  return join(process.env.DATA_DIR || "./data", "github.json");
}

async function loadToken() {
  try {
    return JSON.parse(await readFile(tokenFilePath(), "utf8")).accessToken || null;
  } catch {
    return null;
  }
}

export async function saveToken(accessToken) {
  await mkdir(process.env.DATA_DIR || "./data", { recursive: true });
  await writeFile(tokenFilePath(), JSON.stringify({ accessToken, savedAt: new Date().toISOString() }, null, 2));
}

export async function clearToken() {
  try {
    await writeFile(tokenFilePath(), JSON.stringify({ accessToken: null }, null, 2));
  } catch {}
}

export function getAuthorizeUrl(codeVerifier) {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", codeVerifier);
  return url.toString();
}

export function redirectUri() {
  return process.env.GITHUB_REDIRECT_URI || `http://localhost:${process.env.PORT || 8787}/api/github/callback`;
}

let currentState = null;
export function newState() {
  currentState = randomBytes(24).toString("hex");
  return currentState;
}

export async function exchangeCode(code, state) {
  if (!state || !currentState || state !== currentState) throw Object.assign(new Error("Invalid OAuth state."), { status: 400 });
  currentState = null;
  const body = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    client_secret: process.env.GITHUB_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri()
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString()
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw Object.assign(new Error(`GitHub token exchange failed: ${data.error_description || data.error || response.status}`), { status: 502 });
  await saveToken(data.access_token);
  return data.access_token;
}

export async function getGithubUser() {
  const token = await loadToken();
  if (!token) return null;
  const response = await fetch(USER_URL, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "alutra-code", Accept: "application/vnd.github+json" } });
  if (response.status === 401) { await clearToken(); return null; }
  if (!response.ok) return null;
  const user = await response.json();
  return { login: user.login, name: user.name, avatarUrl: user.avatar_url, htmlUrl: user.html_url };
}

export async function listRepos(user, prefix = "") {
  const token = await loadToken();
  if (!token) throw Object.assign(new Error("No GitHub connection."), { status: 401 });
  const url = new URL(`https://api.github.com/user/repos`);
  url.searchParams.set("visibility", "all");
  url.searchParams.set("per_page", "100");
  url.searchParams.set("sort", "updated");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "alutra-code", Accept: "application/vnd.github+json" } });
  if (!response.ok) return [];
  const data = await response.json();
  return data
    .filter((repo) => !prefix || repo.full_name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((repo) => ({ fullName: repo.full_name, url: repo.html_url, description: repo.description, private: repo.private, updatedAt: repo.updated_at, cloneUrl: repo.clone_url }));
}

export async function createGithubRepo({ name, description = "", private: isPrivate = false }) {
  const token = await loadToken();
  if (!token) throw Object.assign(new Error("No GitHub connection."), { status: 401 });
  const response = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "alutra-code", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, private: isPrivate, auto_init: true })
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(`Could not create repo: ${data.message || response.status}`), { status: 502 });
  return { fullName: data.full_name, url: data.html_url, cloneUrl: data.clone_url };
}

export function githubHeaders() {
  return { "User-Agent": "alutra-code", Accept: "application/vnd.github+json" };
}

export async function getToken() {
  return loadToken();
}