import { useEffect, useRef, useState } from "react";

const API = import.meta.env.VITE_API_URL || "";
const keyNames = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini", deepseek: "DeepSeek", perplexity: "Perplexity", copilot: "Copilot" };
const initialKeys = () => JSON.parse(localStorage.getItem("alutra-api-keys") || "{}");

async function readStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try { onEvent(JSON.parse(data)); } catch {}
      }
    }
  }
}

function GitHubPanel({ onNotice, onClose }) {
  const [status, setStatus] = useState(null);
  const refreshStatus = () => fetch(`${API}/api/github/status`).then((r) => r.json()).then(setStatus).catch(() => setStatus({ configured: false }));
  useEffect(() => { refreshStatus(); }, []);
  useEffect(() => { const params = new URLSearchParams(window.location.search); if (params.get("github") === "connected") { refreshStatus(); window.history.replaceState({}, "", window.location.pathname); } }, []);
  const connect = async () => {
    const response = await fetch(`${API}/api/github/connect`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) return onNotice(data.error || "GitHub connect failed.");
    const width = 900, height = 700, left = (window.screen.width - width) / 2, top = (window.screen.height - height) / 2;
    const popup = window.open(data.authorizeUrl, "github-oauth", `width=${width},height=${height},left=${left},top=${top}`);
    let finished = false;
    const timer = setInterval(async () => {
      if (popup?.closed && !finished) { finished = true; clearInterval(timer); const st = await fetch(`${API}/api/github/status`).then((r) => r.json()).catch(() => null); if (st) setStatus(st); }
    }, 500);
  };
  const disconnect = async () => { await fetch(`${API}/api/github/disconnect`, { method: "POST" }); setStatus({ configured: status?.configured, user: null }); };
  const configured = status?.configured;
  return <section className="github modal"><div className="modal-head"><div><p className="eyebrow">Third-party</p><h2>GitHub</h2></div><button className="icon" onClick={onClose}>x</button></div>{status === null ? <p>Checking…</p> : !configured ? <div><p>Add <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> to <code>server/.env</code> to enable Sign in with GitHub — then the agent can pull and publish repositories, and Copilot can be used as a model.</p><button className="primary" disabled>Not configured in server/.env</button></div> : status.user ? <div><p>Connected as <b>{status.user.login}</b></p><button className="danger" onClick={disconnect}>Disconnect GitHub</button></div> : <div><p>Sign in to link your repositories to Alutra Code.</p><button className="primary" onClick={connect}>Sign in with GitHub</button></div>}</section>;
}

function KeyDialog({ onClose }) {
  const [keys, setKeys] = useState(initialKeys);
  const save = () => { localStorage.setItem("alutra-api-keys", JSON.stringify(keys)); onClose(keys); };
  return <div className="scrim"><section className="keys modal"><div className="modal-head"><div><p className="eyebrow">Local only</p><h2>Provider API keys</h2></div><button className="icon" onClick={() => onClose(null)}>x</button></div><p>Keys remain in this browser's local storage. They are sent only to your local Alutra server for the active request. Prefer `server/.env` for server-side storage. Copilot uses your GitHub connection instead of a key.</p>{Object.entries(keyNames).filter(([id]) => id !== "copilot").map(([id, label]) => <label key={id}>{label}<input type="password" value={keys[id] || ""} placeholder={`${label} API key`} onChange={(event) => setKeys({ ...keys, [id]: event.target.value })} /></label>)}<button className="primary" onClick={save}>Save local keys</button></section></div>;
}

function ProviderSelect({ providers, value, onChange }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Active language model"><option value="auto">Auto (best available)</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}{provider.configured ? "" : " (local key)"}</option>)}</select>;
}

function PermissionBanner({ request, onAnswer }) {
  const prettyArgs = (args) => {
    if (request.tool === "bash") return args.command;
    if (request.tool === "write") return `${args.path}\n${String(args.content || "").slice(0, 400)}`;
    if (request.tool === "edit") return `${args.path}\n${args.old_string || args.oldString} → ${args.new_string || args.newString}`;
    return JSON.stringify(args, null, 2).slice(0, 500);
  };
  return <div className="perm-banner"><b>Permission required</b><p>The agent wants to <code>{request.tool}</code>.{request.reason ? ` Reason: ${request.reason}` : ""}</p><pre>{prettyArgs(request.args)}</pre><div className="perm-actions"><button className="allow" onClick={() => onAnswer(false, true)}>Allow once</button><button className="always" onClick={() => onAnswer(true, true)}>Always allow</button><button className="deny" onClick={() => onAnswer(false, false)}>Deny</button></div></div>;
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
  const [sessions, setSessions] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState([]);
  const [notice, setNotice] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [pendingPermission, setPendingPermission] = useState(null);
  const chatEnd = useRef(null);
  const textareaRef = useRef(null);

  const refreshSessions = () => fetch(`${API}/api/sessions`).then((r) => r.json()).then((d) => setSessions(d.sessions || [])).catch(() => {});
  useEffect(() => { fetch(`${API}/api/providers`).then((response) => response.json()).then((data) => setProviders(data.providers || [])).catch(() => setNotice("Alutra server is offline. Start it with npm run dev.")); refreshSessions(); }, []);
  useEffect(() => chatEnd.current?.scrollIntoView({ behavior: "smooth" }), [messages, events]);
  useEffect(() => { const el = textareaRef.current; if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 56)}px`; }, [input]);

  async function submit(event) {
    event.preventDefault(); if (!input.trim() || busy) return;
    const text = input.trim(); setInput(""); setNotice(""); setBusy(true); setStreaming(true);
    if (mode === "daily") {
      setMessages((current) => [...current, { role: "user", content: text }, { role: "assistant", content: "", streaming: true, thinking: true }]);
      try {
        const response = await fetch(`${API}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text, conversationId, provider, keys }) });
        if (!response.ok || !response.body) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `Chat failed (${response.status}).`); }
        let acc = "";
        let newId = conversationId;
        await readStream(response, (event) => {
          if (event.type === "token") { acc += event.text; setMessages((current) => { const copy = [...current]; copy[copy.length - 1] = { role: "assistant", content: acc, streaming: true }; return copy; }); }
          else if (event.type === "done") { newId = event.conversationId; setConversationId(newId); }
          else if (event.type === "error") { setNotice(event.message); }
        });
        setMessages((current) => { const copy = [...current]; copy[copy.length - 1] = { role: "assistant", content: acc, streaming: false }; return copy; });
        setConversationId(newId);
        refreshSessions();
      } catch (error) { setNotice(error.message); setMessages((current) => current.filter((m) => !(m.role === "assistant" && m.streaming))); }
    } else {
      setEvents([{ type: "execution", message: "Building" }]);
      try {
        const response = await fetch(`${API}/api/agent/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: text, provider, keys }) });
        if (!response.ok || !response.body) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `Agent failed (${response.status}).`); }
        await readStream(response, (event) => {
          if (event.type === "permission") { setPendingPermission(event); }
          else if (event.type === "error") { setNotice(event.message); setEvents((current) => [...current, event]); }
          else if (event.type === "done") { setNotice(event.summary); setEvents((current) => [...current, { type: "done", message: event.summary }]); }
          else setEvents((current) => [...current, event]);
        });
      } catch (error) { setNotice(error.message); }
    }
    setBusy(false); setStreaming(false);
  }

  const answerPermission = async (always, allow) => {
    const req = pendingPermission; if (!req) return;
    setPendingPermission(null);
    try { await fetch(`${API}/api/agent/permission`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: req.id, allow, always }) }); }
    catch (error) { setNotice(error.message); }
  };

  const loadSession = async (id) => {
    try { const data = await fetch(`${API}/api/sessions/${id}`).then((r) => r.json()); if (data.messages) { setConversationId(id); setMessages(data.messages); setMode("daily"); setEvents([]); setNotice(""); } } catch (error) { setNotice(error.message); }
  };

  const deleteSession = async (id) => {
    try { await fetch(`${API}/api/sessions/${id}`, { method: "DELETE" }); if (conversationId === id) { setConversationId(null); setMessages([]); } refreshSessions(); } catch (error) { setNotice(error.message); }
  };

  const compactSession = async () => {
    if (!conversationId || busy) return;
    setBusy(true);
    try { const data = await fetch(`${API}/api/sessions/compact`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, provider, keys }) }).then((r) => r.json()); if (data.conversationId) { setConversationId(data.conversationId); setMessages([{ role: "user", content: "Summary of previous session:\n" + data.summary }]); setNotice("Session compacted. Continuing from the summary."); refreshSessions(); } } catch (error) { setNotice(error.message); }
    setBusy(false);
  };

  const reset = () => { setMessages([]); setConversationId(null); setEvents([]); setNotice(""); setPendingPermission(null); };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !busy) { event.preventDefault(); event.currentTarget.form.requestSubmit(); }
  };

  return <main><aside><div className="brand"><span className="mark">A</span><div>ALUTRA <b>CODE</b></div></div><p className="section-label">WORKSPACE</p><button className={mode === "daily" ? "nav active" : "nav"} onClick={() => { setMode("daily"); reset(); }}><span>01</span> Daily Questions</button><button className={mode === "agent" ? "nav active" : "nav"} onClick={() => { setMode("agent"); reset(); }}><span>02</span> Agent Mode</button><p className="section-label" style={{ marginTop: "26px" }}>SESSIONS</p><div className="sessions">{sessions.slice(0, 8).map((session) => <div className="session-row" key={session.id}><button className="session" onClick={() => loadSession(session.id)}><b>{session.title}</b><span>{session.count} messages · {new Date(session.updatedAt).toLocaleDateString()}</span></button><button className="del" title="Delete" onClick={() => deleteSession(session.id)}>×</button></div>)}</div><div className="aside-bottom"><button className="nav" onClick={reset}>New thread</button><button className="key-button" onClick={() => setShowGithub(true)}><span>⬢</span> Linked apps<span>{}</span></button><button className="key-button" onClick={() => setShowKeys(true)}>API key vault <span>{Object.keys(keys).length}</span></button></div></aside>
    <section className="workspace"><header><div><p className="eyebrow">{mode === "daily" ? "CONVERSATIONAL ASSISTANT" : "AUTONOMOUS BUILD LOOP"}</p><h1>{mode === "daily" ? "Build clarity, one question at a time." : "Give a task. Review the work."}</h1></div><ProviderSelect providers={providers} value={provider} onChange={setProvider} /></header>
      {mode === "daily" ? <div className="chat">{messages.length === 0 && <div className="empty"><span className="mark large">A</span><h2>What are you building?</h2><p>Ask for debugging help, a concise explanation, or production-ready code — streamed live to you. Press Enter to send, Shift + Enter for a new line.</p><div className="suggestions"><button onClick={() => setInput("Explain this TypeScript error and show the minimal fix")}>Explain a TypeScript error</button><button onClick={() => setInput("Review this API design for security issues")}>Review an API design</button></div></div>}{messages.map((message, index) => <article className={`message ${message.role}`} key={index}><div className="avatar">{message.role === "user" ? "YOU" : "A"}</div><div className="body"><div className="message-meta">{message.role === "assistant" ? `ALUTRA · ${message.provider || "AI"}` : "YOU"}</div><pre className="bubble">{message.thinking && !message.content ? <span className="thinking">Thinking<span className="dots"><span/><span/><span/></span></span> : message.content}{message.streaming && !message.thinking ? <span className="stream-cursor" /> : ""}</pre></div></article>)}<div ref={chatEnd} /></div> : <div className="agent"><div className="agent-intro"><p className="eyebrow">GUARDED EXECUTION</p><h2>A plan before every file.</h2><p>Alutra plans first, then uses opencode-style tools — write, edit, read, ls, glob, grep, and guarded bash. Mutating or network actions ask for your approval.</p></div><div className="timeline">{events.length === 0 ? <p className="muted">The task plan and execution log will appear here.</p> : events.map((item, index) => <div className={`event ${item.type}`} key={index}><span className="event-dot"/><div><b>{item.type === "plan" ? "Task plan" : item.type === "execution" && item.message === "Building" ? <span className="thinking">Building<span className="dots"><span/><span/><span/></span></span> : item.type === "file" ? item.path || "File" : item.type === "command" ? item.command : item.type === "permission" ? "Waiting for approval…" : item.type === "done" ? "Complete" : item.type}</b>{item.plan && <ol>{item.plan.map((step) => <li key={step}>{step}</li>)}</ol>}<p>{item.message}</p></div></div>)}</div></div>}
      {pendingPermission && <PermissionBanner request={pendingPermission} onAnswer={answerPermission} />}
      {notice && <div className="notice">{notice}</div>}<form onSubmit={submit}><textarea ref={textareaRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown} placeholder={mode === "daily" ? "Ask a coding question..." : "Describe the software you want built..."} rows="1" /><button className="send" disabled={busy}>{busy ? "Working..." : mode === "daily" ? "Send" : "Start agent"}</button></form>
      {mode === "daily" && conversationId && !busy && <button className="compact" onClick={compactSession}>Summarize &amp; compact this session</button>}
    </section>{showKeys && <KeyDialog onClose={(saved) => { if (saved) setKeys(saved); setShowKeys(false); }} />}{showGithub && <GitHubPanel onNotice={setNotice} onClose={() => setShowGithub(false)} />}</main>;
}