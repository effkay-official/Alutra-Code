export const PROVIDERS = {
  openai: { label: "ChatGPT", key: "OPENAI_API_KEY", modelEnv: "OPENAI_MODEL", model: "gpt-4o-mini" },
  anthropic: { label: "Claude", key: "ANTHROPIC_API_KEY", modelEnv: "ANTHROPIC_MODEL", model: "claude-3-5-haiku-latest" },
  gemini: { label: "Gemini", key: "GEMINI_API_KEY", modelEnv: "GEMINI_MODEL", model: "gemini-1.5-flash" },
  deepseek: { label: "DeepSeek", key: "DEEPSEEK_API_KEY", modelEnv: "DEEPSEEK_MODEL", model: "deepseek-chat" },
  perplexity: { label: "Perplexity", key: "PERPLEXITY_API_KEY", modelEnv: "PERPLEXITY_MODEL", model: "llama-3.1-sonar-small-128k-online" }
};

export const providerOptions = Object.entries(PROVIDERS).map(([id, provider]) => ({ id, label: provider.label, model: provider.model }));
