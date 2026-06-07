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

app.use(express.json({ limit: "10mb" })); // Bilder (Base64) brauchen mehr Platz

const PORT = process.env.PORT || 8787;
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image-preview";
const IMAGE_DAILY_CAP = Number(process.env.IMAGE_DAILY_CAP || 60); // Kostenbremse: max. erzeugte Bilder/Tag
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

// Bild-Generierung via Gemini (Nano Banana). Optionales Anchor-Bild fuer Charakter-Konsistenz.
async function callGeminiImage(prompt, anchor, opts = {}) {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY fehlt");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;
  const parts = [{ text: prompt }];
  if (anchor && anchor.data) parts.push({ inline_data: { mime_type: anchor.media_type || "image/jpeg", data: anchor.data } });
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { imageSize: opts.size || "1K", aspectRatio: opts.aspectRatio || "1:1" },
    },
  };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 90000); // Bilder dauern laenger
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error("Gemini-Bild fehlgeschlagen (Timeout/Netz): " + String(e.message || e));
  } finally {
    clearTimeout(to);
  }
  if (!r.ok) {
    const t = (await r.text()).slice(0, 400);
    if (r.status === 403 || /billing|quota|permission/i.test(t)) {
      throw new Error("Gemini 403 — vermutlich ist fuer den API-Key noch kein Billing aktiviert (Bild-Generierung hat kein Gratis-Kontingent). " + t);
    }
    throw new Error("Gemini-Bild " + r.status + " " + t);
  }
  const d = await r.json();
  const ps = d?.candidates?.[0]?.content?.parts || [];
  for (const p of ps) {
    const inl = p.inlineData || p.inline_data;
    if (inl && inl.data) return { data: inl.data, mime: inl.mimeType || inl.mime_type || "image/png" };
  }
  const txt = ps.map((p) => p.text || "").join(" ").trim();
  throw new Error("Kein Bild erhalten" + (txt ? (": " + txt.slice(0, 200)) : " (evtl. durch Sicherheitsfilter blockiert)."));
}

async function callClaude(prompt, modelAlias, images) {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY fehlt");
  const model = CLAUDE_MODELS[modelAlias] || CLAUDE_MODELS.sonnet;
  // Bilder (optional) als Content-Bloecke VOR dem Text — empfohlen fuer beste Ergebnisse
  const blocks = [];
  for (const img of Array.isArray(images) ? images.slice(0, 4) : []) {
    if (!img || typeof img.data !== "string" || !img.data) continue;
    if (img.data.length > 6_500_000) throw new Error("Bild zu gross (max ~5MB)");
    blocks.push({ type: "image", source: { type: "base64", media_type: img.media_type || "image/jpeg", data: img.data } });
  }
  blocks.push({ type: "text", text: prompt });
  console.log("Claude-Aufruf startet, model=" + model + (blocks.length > 1 ? ", bilder=" + (blocks.length - 1) : ""));
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 45000);
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 8192, messages: [{ role: "user", content: blocks }] }),
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

app.get("/", (_req, res) => res.json({ ok: true, service: "influencer-os-backend", build: "img-jun7", geminiModel: GEMINI_MODEL, imageModel: GEMINI_IMAGE_MODEL, dailyUsed: used, dailyCap: DAILY_CAP, imageUsed: imgUsed, imageCap: IMAGE_DAILY_CAP }));

// Hartes Bild-Tageslimit (separat vom Text-Limit) als Kostenschutz
let imgDay = new Date().toISOString().slice(0, 10), imgUsed = 0;
function imageDailyGuard(_req, res, next) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== imgDay) { imgDay = today; imgUsed = 0; }
  if (imgUsed >= IMAGE_DAILY_CAP) return res.status(429).json({ error: "Bild-Tageslimit erreicht (Kostenschutz). Morgen wieder oder Limit in den Render-Variablen erhoehen." });
  imgUsed++; next();
}

app.post("/api/image", limiter, tokenGuard, imageDailyGuard, async (req, res) => {
  try {
    const { prompt, image, aspectRatio, size } = req.body || {};
    if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "prompt fehlt" });
    if (prompt.length > 8000) return res.status(413).json({ error: "prompt zu lang" });
    let anchor = null;
    if (image && typeof image.data === "string" && image.data) {
      if (image.data.length > 8_000_000) return res.status(413).json({ error: "Anchor-Bild zu gross" });
      anchor = { data: image.data, media_type: image.media_type || "image/jpeg" };
    }
    const out = await callGeminiImage(prompt, anchor, { aspectRatio, size });
    res.json(out);
  } catch (e) {
    console.error("api/image Fehler:", e);
    imgUsed = Math.max(0, imgUsed - 1); // fehlgeschlagene Generierung nicht aufs Limit anrechnen
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/text", limiter, tokenGuard, dailyGuard, async (req, res) => {
  try {
    const { prompt, provider, model, images } = req.body || {};
    if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "prompt fehlt" });
    if (prompt.length > 12000) return res.status(413).json({ error: "prompt zu lang" });
    const hasImages = Array.isArray(images) && images.length > 0;
    // Bild-Analyse laeuft immer ueber Claude (Vision)
    const result = (provider === "claude" || hasImages) ? await callClaude(prompt, model, images) : await callGemini(prompt);
    res.json({ provider: (provider === "claude" || hasImages) ? "claude" : "gemini", result });
  } catch (e) {
    console.error("api/text Fehler:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("Influencer OS backend läuft auf Port " + PORT);
  if (CORS_ORIGIN === "*") console.log("Hinweis: CORS offen für alle — für mehr Schutz CORS_ORIGIN auf deine App-URL setzen.");
});
