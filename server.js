import express from "express";

const app = express();
app.set("trust proxy", 1); // korrekte Client-IP hinter Hosting-Proxy (Render/Railway)

// Kugelsicheres CORS + Preflight — ganz vorne, damit auch Fehlerantworten die Header tragen
app.use((req, res, next) => {
  const allow = process.env.CORS_ORIGIN || "*";
  res.header("Access-Control-Allow-Origin", allow);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", req.get("Access-Control-Request-Headers") || "Content-Type, x-app-token");
  res.header("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Request-Logging — sichtbar in den Render-Logs
app.use((req, _res, next) => { console.log(new Date().toISOString(), req.method, req.url); next(); });

app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8787;
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";

// --- Sicherheit ohne Login ---
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);   // Anfragen/Minute je IP
const DAILY_CAP = Number(process.env.DAILY_CAP || 1000);        // Gesamtanfragen/Tag
const APP_TOKEN = process.env.APP_TOKEN || "";                  // optional: nur Anfragen mit passendem Header

// (CORS wird oben durch die explizite Middleware gesetzt)

// 1) Rate-Limit je IP — bremst Spam, mit Bordmitteln (kein Zusatzpaket nötig)
const hits = new Map(); // ip -> { count, resetAt }
function limiter(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + 60 * 1000 });
  } else {
    rec.count++;
    if (rec.count > PER_MIN) return res.status(429).json({ error: "Zu viele Anfragen — bitte kurz warten." });
  }
  if (hits.size > 5000) { for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k); }
  next();
}

// 2) Hartes Tageslimit — begrenzt den maximalen Schaden bei Missbrauch
let day = new Date().toISOString().slice(0, 10), used = 0;
function dailyGuard(_req, res, next) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; used = 0; }
  if (used >= DAILY_CAP) return res.status(429).json({ error: "Tageslimit erreicht." });
  used++; next();
}

// 3) Optionaler App-Token — wenn gesetzt, sind nur Anfragen mit passendem Header erlaubt
function tokenGuard(req, res, next) {
  if (APP_TOKEN && req.get("x-app-token") !== APP_TOKEN) return res.status(401).json({ error: "Nicht autorisiert." });
  next();
}

const CLAUDE_MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
};

async function callGemini(prompt) {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY fehlt");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30000);
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error("Gemini-Aufruf fehlgeschlagen (Timeout/Netz): " + String(e.message || e));
  } finally {
    clearTimeout(to);
  }
  if (!r.ok) throw new Error("Gemini " + r.status + " " + (await r.text()).slice(0, 300));
  const d = await r.json();
  return (d?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
}

async function callClaude(prompt, modelAlias) {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY fehlt");
  const model = CLAUDE_MODELS[modelAlias] || CLAUDE_MODELS.sonnet;
  console.log("Claude-Aufruf startet, model=" + model);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 45000);
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 8192, messages: [{ role: "user", content: prompt }] }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error("Claude-Aufruf fehlgeschlagen (Timeout/Netz): " + String(e.message || e));
  } finally {
    clearTimeout(to);
  }
  if (!r.ok) throw new Error("Claude " + r.status + " " + (await r.text()).slice(0, 300));
  const d = await r.json();
  console.log("Claude-Antwort erhalten");
  return (d.content || []).map((b) => (b.type === "text" ? b.text : "")).join("").trim();
}

app.get("/", (_req, res) => res.json({ ok: true, service: "influencer-os-backend", build: "cors-fix-jun6", geminiModel: GEMINI_MODEL, dailyUsed: used, dailyCap: DAILY_CAP }));

app.post("/api/text", limiter, tokenGuard, dailyGuard, async (req, res) => {
  try {
    const { prompt, provider, model } = req.body || {};
    if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "prompt fehlt" });
    if (prompt.length > 12000) return res.status(413).json({ error: "prompt zu lang" });
    const result = provider === "claude" ? await callClaude(prompt, model) : await callGemini(prompt);
    res.json({ provider: provider === "claude" ? "claude" : "gemini", result });
  } catch (e) {
    console.error("api/text Fehler:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("Influencer OS backend läuft auf Port " + PORT);
  if (CORS_ORIGIN === "*") console.log("Hinweis: CORS offen für alle — für mehr Schutz CORS_ORIGIN auf deine App-URL setzen.");
});
