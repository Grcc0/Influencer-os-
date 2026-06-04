import express from "express";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));

const PORT = process.env.PORT || 8787;
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";

// alias -> aktuelle Claude-Modellstrings
const CLAUDE_MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
};

async function callGemini(prompt) {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY fehlt");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!r.ok) throw new Error("Gemini " + r.status + " " + (await r.text()).slice(0, 300));
  const d = await r.json();
  const parts = d?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("").trim();
}

async function callClaude(prompt, modelAlias) {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY fehlt");
  const model = CLAUDE_MODELS[modelAlias] || CLAUDE_MODELS.sonnet;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error("Claude " + r.status + " " + (await r.text()).slice(0, 300));
  const d = await r.json();
  return (d.content || []).map((b) => (b.type === "text" ? b.text : "")).join("").trim();
}

app.get("/", (_req, res) => res.json({ ok: true, service: "influencer-os-backend", geminiModel: GEMINI_MODEL }));

app.post("/api/text", async (req, res) => {
  try {
    const { prompt, provider, model } = req.body || {};
    if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "prompt fehlt" });
    const result = provider === "claude" ? await callClaude(prompt, model) : await callGemini(prompt);
    res.json({ provider: provider === "claude" ? "claude" : "gemini", result });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log("Influencer OS backend läuft auf Port " + PORT));
