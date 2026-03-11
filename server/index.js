import express from 'express';
import multer from 'multer';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI } from '@google/genai';
import Database from 'better-sqlite3';
import 'dotenv/config';

const app = express();
app.set('trust proxy', 1);

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'wss:', 'https:'],
        mediaSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, // WebRTC needs this off
  })
);

// ─── CORS ─────────────────────────────────────────────────────────────────────
const rawOrigins = process.env.ALLOWED_ORIGINS || '';
const allowedOrigins = rawOrigins
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin / server-to-server requests (no Origin header)
      if (!origin) return callback(null, true);
      // In dev, allow any localhost origin
      if (process.env.NODE_ENV !== 'production' && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
  })
);

// ─── Rate limiting ────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests, please try again later.' },
});

app.use('/api/', generalLimiter);
app.use(express.json({ limit: '10mb' }));

// ─── Environment ──────────────────────────────────────────────────────────────
const geminiApiKey = process.env.GEMINI_API_KEY || '';
if (!geminiApiKey) {
  console.error('[startup] Missing GEMINI_API_KEY');
}

const odysseyApiKey = process.env.ODYSSEY_API_KEY || '';
if (!odysseyApiKey) {
  console.warn('[startup] Missing ODYSSEY_API_KEY');
}

const model = 'gemini-2.0-flash';

// ─── Database (graceful fallback) ─────────────────────────────────────────────
const DB_PATH = process.env.DATABASE_PATH || (process.env.VERCEL ? '/tmp/data.sqlite' : 'data.sqlite');
let db = null;
let insertLog;

try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      data_json TEXT,
      timestamp TEXT NOT NULL
    );
  `);
  insertLog = db.prepare(`
    INSERT INTO logs (event, data_json, timestamp)
    VALUES (@event, @data_json, @timestamp)
  `);
} catch (err) {
  console.warn('[db] SQLite unavailable, persistence disabled:', err.message);
}

// ─── Multer (audio only) ──────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

const getAiClient = () => (geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null);

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Odyssey token endpoint — serves API key to authenticated same-origin clients
app.get('/api/odyssey/token', (_req, res) => {
  if (!odysseyApiKey) {
    return res.status(503).json({ error: 'Odyssey not configured.' });
  }
  return res.json({ apiKey: odysseyApiKey });
});

app.post('/api/log', (req, res) => {
  try {
    const event = String(req.body?.event || '').trim();
    if (!event) return res.status(400).json({ error: 'Missing event.' });
    const timestamp = String(req.body?.timestamp || new Date().toISOString());
    const data = req.body?.data ?? {};
    if (insertLog) {
      insertLog.run({ event, data_json: JSON.stringify(data), timestamp });
    }
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'Log failed.' });
  }
});

app.get('/api/logs', (req, res) => {
  if (!db) return res.json({ data: [] });
  try {
    const event = req.query.event ? String(req.query.event) : null;
    const limit = Math.min(Number(req.query.limit || 500), 1000);
    const rows = event
      ? db.prepare('SELECT * FROM logs WHERE event = ? ORDER BY id DESC LIMIT ?').all(event, limit)
      : db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
    const data = rows.map((row) => ({ ...row, data: row.data_json ? JSON.parse(row.data_json) : {} }));
    return res.json({ data });
  } catch {
    return res.status(500).json({ error: 'Query failed.' });
  }
});

app.post('/api/stt', upload.single('audio'), async (req, res) => {
  try {
    const smallestApiKey = process.env.SMALLEST_API_KEY;
    if (!smallestApiKey) return res.status(503).json({ error: 'STT service not configured.' });
    if (!req.file) return res.status(400).json({ error: 'Missing audio file.' });

    const mimeType = req.file.mimetype || 'audio/webm';
    const response = await fetch('https://api.smallest.ai/waves/v1/pulse/get_text?language=en', {
      method: 'POST',
      headers: { Authorization: `Bearer ${smallestApiKey}`, 'Content-Type': mimeType },
      body: req.file.buffer,
    });

    if (!response.ok) {
      return res.status(500).json({ error: 'Transcription failed.' });
    }

    const data = await response.json();
    const text = (data.transcription ?? '').trim();
    return res.json({ text });
  } catch {
    return res.status(500).json({ error: 'Transcription failed.' });
  }
});

app.post('/api/gesture', aiLimiter, async (req, res) => {
  try {
    const ai = getAiClient();
    if (!ai) return res.status(503).json({ error: 'AI service not configured.' });
    const features = String(req.body?.features ?? '').trim();
    if (!features) return res.status(400).json({ error: 'Missing features.' });

    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [
        { text: 'Classify the gesture from the feature summary. Only return one of: hello, thumbs_up, victory, namaste, none. No extra words.' },
        { text: features },
      ]}],
    });

    const text = response.text?.trim().toLowerCase() || 'none';
    const label = ['hello', 'thumbs_up', 'victory', 'namaste', 'none'].includes(text) ? text : 'none';
    return res.json({ label });
  } catch {
    return res.status(500).json({ error: 'Gesture classification failed.' });
  }
});

app.post('/api/gesture-vision', aiLimiter, async (req, res) => {
  try {
    const ai = getAiClient();
    if (!ai) return res.status(503).json({ error: 'AI service not configured.' });
    const image = String(req.body?.image ?? '').trim();
    const mimeType = String(req.body?.mimeType ?? 'image/jpeg').trim();
    if (!image) return res.status(400).json({ error: 'Missing image.' });

    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [
        { text: 'Classify the hand gesture in this image. Only return one of: hello, thumbs_up, victory, namaste, none. No extra words.' },
        { inlineData: { mimeType, data: image } },
      ]}],
    });

    const text = response.text?.trim().toLowerCase() || 'none';
    const label = ['hello', 'thumbs_up', 'victory', 'namaste', 'none'].includes(text) ? text : 'none';
    return res.json({ label });
  } catch (error) {
    if (error?.status === 429) {
      return res.status(429).json({ error: 'Rate limited', retryAfterMs: 10000 });
    }
    return res.status(500).json({ error: 'Gesture classification failed.' });
  }
});

app.post('/api/chat', aiLimiter, async (req, res) => {
  try {
    const ai = getAiClient();
    if (!ai) return res.status(503).json({ error: 'AI service not configured.' });
    const message = String(req.body?.message ?? '').trim();
    const character = String(req.body?.character ?? 'character').trim().slice(0, 100);
    if (!message) return res.status(400).json({ error: 'Missing message.' });

    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [
        { text: `Imagine yourself as ${character}. You are friendly, short and playful. Reply in 1-2 sentences. Also suggest one short action for the live scene. Output JSON: {"reply":"...","action":"..."}` },
        { text: message },
      ]}],
    });

    const text = response.text?.trim() || '';
    return res.json({ text });
  } catch (error) {
    if (error?.status === 429) {
      return res.status(429).json({ error: 'Rate limited', retryAfterMs: 10000 });
    }
    return res.status(500).json({ error: 'Chat failed.' });
  }
});

// ─── Start (local dev only) ───────────────────────────────────────────────────
if (!process.env.VERCEL) {
  const port = process.env.PORT || 8787;
  const server = app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[server] Port ${port} is already in use. Kill the existing process and try again.`);
    } else {
      console.error('[server] Failed to start:', err.message);
    }
    process.exit(1);
  });
}

export default app;
