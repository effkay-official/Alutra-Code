import { useEffect, useRef, useState } from "react";

const API = import.meta.env.VITE_API_URL || "";
const keyNames = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini", deepseek: "DeepSeek", perplexity: "Perplexity" };
const initialKeys = () => JSON.parse(localStorage.getItem("alutra-api-keys") || "{}");

function GitHubPanel({ api, onNotice, onClose }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const refreshStatus = () => fetch(`${api}/api/github/status`).then((r) => r.json()).then(setStatus).catch(() => setStatus({ configured: false }));
  useEffect(() => { refreshStatus(); }, [api]);
  useEffect(() => { const params = new URLSearchParams(window.location.search); if (params.get("github") === "connected") { refreshStatus(); window.history.replaceState({}, "", window.location.pathname); } }, [api]);
  const connect = async () => {
    const response = await fetch(`${api}/api/github/connect`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) return onNotice(data.error || "GitHub connect failed.");
    const width = 900, height = 700, left = (window.screen.width - width) / 2, top = (window.screen.height - height) / 2;
    const popup = window.open(data.authorizeUrl, "github-oauth", `width=${width},height=${height},left=${left},top=${top}`);
    let finished = false;
    const timer = setInterval(async () => {
      if (popup?.closed && !finished) {
        finished = true; clearInterval(timer);
        const st = await fetch(`${api}/api/github/status`).then((r) => r.json()).catch(() => null);
        if (st) setStatus(st);
      }
    }, 500);
  };
  const disconnect = async () => { await fetch(`${api}/api/github/disconnect`, { method: "POST" }); setStatus({ configured: status?.configured, user: null }); };
  const configured = status?.configured;
  return <section className="github modal"><div className="modal-head"><div><p className="eyebrow">Third-party</p><h2>GitHub</h2></div><button className="icon" onClick={onClose}>x</button></div>{status === null ? <p>Checking…</p> : !configured ? <div><p>Add <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> to <code>server/.env</code> to enable Sign in with GitHub — then the agent can pull and publish repositories.</p><button className="primary" disabled>Not configured in server/.env</button></div> : status.user ? <div><p>Connected as <b>{status.user.login}</b></p><button className="danger" onClick={disconnect}>Disconnect GitHub</button></div> : <div><p>Sign in to link your repositories to Alutra Code.</p><button className="primary" onClick={connect}>{busy ? "Working…" : "Sign in with GitHub"}</button></div>}</section>;
}

function KeyDialog({ onClose }) {
  const [keys, setKeys] = useState(initialKeys);
  const save = () => { localStorage.setItem("alutra-api-keys", JSON.stringify(keys)); onClose(keys); };
  return <div className="scrim"><section className="keys modal"><div className="modal-head"><div><p className="eyebrow">Local only</p><h2>Provider API keys</h2></div><button className="icon" onClick={() => onClose(null)}>x</button></div><p>Keys remain in this browser's local storage. They are sent only to your local Alutra server for the active request. Prefer `server/.env` for server-side storage.</p>{Object.entries(keyNames).map(([id, label]) => <label key={id}>{label}<input type="password" value={keys[id] || ""} placeholder={`${label} API key`} onChange={(event) => setKeys({ ...keys, [id]: event.target.value })} /></label>)}<button className="primary" onClick={save}>Save local keys</button></section></div>;
}

function ProviderSelect({ providers, value, onChange }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Active language model"><option value="auto">Auto (best available)</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}{provider.configured ? "" : " (local key)"}</option>)}</select>;
}

export default function App() {
  const [mode, setMode] = useState("daily");
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState("auto");
  const [keys, setKeys] = useState(initialKeys);
  const [showKeys, setShowKeys] = useState(false);
  const [showGithub, setShowGithub] = useState(false);
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState([]);
  const [notice, setNotice] = useState("");
  const chatEnd = useRef(null);
  useEffect(() => { fetch(`${API}/api/providers`).then((response) => response.json()).then((data) => setProviders(data.providers || [])).catch(() => setNotice("Alutra server is offline. Start it with npm run dev.")); }, []);
  useEffect(() => chatEnd.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

  async function submit(event) {
    event.preventDefault(); if (!input.trim() || busy) return;
    const text = input.trim(); setInput(""); setNotice(""); setBusy(true);
    if (mode === "daily") {
      setMessages((current) => [...current, { role: "user", content: text }]);
      try { const response = await fetch(`${API}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text, conversationId, provider, keys }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setConversationId(data.conversationId); setMessages((current) => [...current, { role: "assistant", content: data.content, provider: data.provider }]); } catch (error) { setNotice(error.message); }
    } else {
      setEvents([{ type: "execution", message: "Planning your task..." }]);
      try { const response = await fetch(`${API}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: text, provider, keys }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setEvents(data.events || []); setNotice(`${data.summary} Workspace: ${data.workspace}`); } catch (error) { setNotice(error.message); }
    }
    setBusy(false);
  }

  const reset = () => { setMessages([]); setConversationId(null); setEvents([]); setNotice(""); };
  return <main><aside><div className="brand"><span className="mark">A</span><div>ALUTRA <b>CODE</b></div></div><p className="section-label">WORKSPACE</p><button className={mode === "daily" ? "nav active" : "nav"} onClick={() => { setMode("daily"); reset(); }}><span>01</span> Daily Questions</button><button className={mode === "agent" ? "nav active" : "nav"} onClick={() => { setMode("agent"); reset(); }}><span>02</span> Agent Mode</button><div className="aside-bottom"><button className="nav" onClick={reset}>New thread</button><button className="key-button" onClick={() => setShowGithub(true)}><span>⬢</span> Linked apps<span>{}</span></button><button className="key-button" onClick={() => setShowKeys(true)}>API key vault <span>{Object.keys(keys).length}</span></button></div></aside>
    <section className="workspace"><header><div><p className="eyebrow">{mode === "daily" ? "CONVERSATIONAL ASSISTANT" : "AUTONOMOUS BUILD LOOP"}</p><h1>{mode === "daily" ? "Build clarity, one question at a time." : "Give a task. Review the work."}</h1></div><ProviderSelect providers={providers} value={provider} onChange={setProvider} /></header>
      {mode === "daily" ? <div className="chat">{messages.length === 0 && <div className="empty"><span className="mark large">A</span><h2>What are you building?</h2><p>Ask for debugging help, a concise explanation, or production-ready code.</p><div className="suggestions"><button onClick={() => setInput("Explain this TypeScript error and show the minimal fix")}>Explain a TypeScript error</button><button onClick={() => setInput("Review this API design for security issues")}>Review an API design</button></div></div>}{messages.map((message, index) => <article className={`message ${message.role}`} key={index}><div className="avatar">{message.role === "user" ? "YOU" : "A"}</div><div><div className="message-meta">{message.role === "assistant" ? `ALUTRA · ${message.provider || "AI"}` : "YOU"}</div><pre>{message.content}</pre></div></article>)}<div ref={chatEnd} /></div> : <div className="agent"><div className="agent-intro"><p className="eyebrow">GUARDED EXECUTION</p><h2>A plan before every file.</h2><p>Alutra creates a fresh, isolated workspace per task. It can write files and run only allow-listed `npm`, `npx`, or `node` commands.</p></div><div className="timeline">{events.length === 0 ? <p className="muted">The task plan and execution log will appear here.</p> : events.map((item, index) => <div className={`event ${item.type}`} key={index}><span className="event-dot"/><div><b>{item.type === "plan" ? "Task plan" : item.type === "file" ? item.path : item.type === "command" ? item.command : item.type}</b>{item.plan && <ol>{item.plan.map((step) => <li key={step}>{step}</li>)}</ol>}<p>{item.message}</p></div></div>)}</div></div>}
      {notice && <div className="notice">{notice}</div>}<form onSubmit={submit}><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={mode === "daily" ? "Ask a coding question..." : "Describe the software you want built..."} rows="3" /><button className="send" disabled={busy}>{busy ? "Working..." : mode === "daily" ? "Send" : "Start agent"}</button></form></section>{showKeys && <KeyDialog onClose={(saved) => { if (saved) setKeys(saved); setShowKeys(false); }} />}{showGithub && <GitHubPanel api={API} onNotice={setNotice} onClose={() => setShowGithub(false)} />}</main>;
}
