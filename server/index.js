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

// ─── Environment ──────────────────────────────────────────────────────────────
const geminiApiKey = process.env.GEMINI_API_KEY || '';
if (!geminiApiKey) {
  console.error('[startup] Missing GEMINI_API_KEY');
}

const odysseyApiKey = process.env.ODYSSEY_API_KEY || '';
if (!odysseyApiKey) {
  console.warn('[startup] Missing ODYSSEY_API_KEY');
}

const smallestApiKey = process.env.SMALLEST_API_KEY || '';
if (!smallestApiKey) {
  console.warn('[startup] Missing SMALLEST_API_KEY');
}

const runtimeConfig = {
  geminiApiKey,
  odysseyApiKey,
  smallestApiKey
};

const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

const model = 'gemini-2.0-flash';

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
  max: isProduction ? 40 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests, please try again later.' },
});

app.use('/api/', generalLimiter);
app.use(express.json({ limit: '10mb' }));

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

// Larger limit for voice clone samples (up to 50 MB to support high-quality recordings)
const uploadVoiceClone = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const getAiClient = () => (runtimeConfig.geminiApiKey ? new GoogleGenAI({ apiKey: runtimeConfig.geminiApiKey }) : null);


// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Odyssey token endpoint — serves API key to authenticated same-origin clients
app.get('/api/odyssey/token', (_req, res) => {
  if (!runtimeConfig.odysseyApiKey) {
    return res.status(503).json({ error: 'Odyssey not configured.' });
  }
  return res.json({ apiKey: runtimeConfig.odysseyApiKey });
});

app.get('/api/config', (_req, res) => {
  if (isProduction) {
    return res.status(404).json({ error: 'Not found.' });
  }
  return res.json({
    ok: true,
    configured: {
      gemini: Boolean(runtimeConfig.geminiApiKey),
      odyssey: Boolean(runtimeConfig.odysseyApiKey),
      smallest: Boolean(runtimeConfig.smallestApiKey)
    }
  });
});

app.post('/api/config', (req, res) => {
  if (isProduction) {
    return res.status(404).json({ error: 'Not found.' });
  }
  const nextGemini = String(req.body?.geminiApiKey ?? '').trim();
  const nextOdyssey = String(req.body?.odysseyApiKey ?? '').trim();
  const nextSmallest = String(req.body?.smallestApiKey ?? '').trim();

  if (nextGemini) {
    runtimeConfig.geminiApiKey = nextGemini;
  }
  if (nextOdyssey) {
    runtimeConfig.odysseyApiKey = nextOdyssey;
  }
  if (nextSmallest) {
    runtimeConfig.smallestApiKey = nextSmallest;
  }

  return res.json({
    ok: true,
    configured: {
      gemini: Boolean(runtimeConfig.geminiApiKey),
      odyssey: Boolean(runtimeConfig.odysseyApiKey),
      smallest: Boolean(runtimeConfig.smallestApiKey)
    }
  });
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

app.get('/api/voices', async (req, res) => {
  const smallestApiKey = runtimeConfig.smallestApiKey;
  if (!smallestApiKey) return res.status(503).json({ error: 'API key not configured.' });
  const model = req.query.model || 'lightning-v3.1';
  const r = await fetch(`https://api.smallest.ai/waves/v1/${model}/get_voices`, {
    headers: { Authorization: `Bearer ${smallestApiKey}` }
  });
  const data = await r.json();
  return res.json(data);
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
    const smallestApiKey = runtimeConfig.smallestApiKey;
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

app.post('/api/smallest/webcall', aiLimiter, async (req, res) => {
  try {
    const smallestApiKey = runtimeConfig.smallestApiKey;
    if (!smallestApiKey) {
      return res.status(503).json({ error: 'Smallest AI not configured.' });
    }
    const agentId = String(req.body?.agentId ?? '').trim();
    if (!agentId) {
      return res.status(400).json({ error: 'Missing agentId.' });
    }
    console.log('[smallest] webcall request', { agentId });

    const response = await fetch('https://atoms-api.smallest.ai/api/v1/conversation/webcall', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${smallestApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ agentId })
    });

    if (!response.ok) {
      const message = await response.text();
      console.error('[smallest] webcall failed', response.status, message);
      return res.status(response.status).json({ error: 'Smallest webcall failed.', details: message });
    }

    const data = await response.json();
    const payload = data?.data ?? data ?? {};
    const accessToken = payload.accessToken || payload.access_token || payload.token || '';
    const host = payload.host || payload.wssHost || payload.wsHost || '';
    console.log('[smallest] webcall response', {
      host,
      tokenLen: accessToken ? accessToken.length : 0
    });

    return res.json({ accessToken, host, raw: data });
  } catch (err) {
    console.error('[smallest] webcall error', err);
    return res.status(500).json({ error: 'Smallest webcall failed.' });
  }
});

app.post('/api/character/stt', upload.single('audio'), async (req, res) => {
  try {
    const smallestApiKey = runtimeConfig.smallestApiKey;
    if (!smallestApiKey) return res.status(503).json({ error: 'STT service not configured.' });
    if (!req.file) return res.status(400).json({ error: 'Missing audio file.' });

    const mimeType = req.file.mimetype || 'audio/webm';
    const response = await fetch('https://api.smallest.ai/waves/v1/pulse/get_text?language=en', {
      method: 'POST',
      headers: { Authorization: `Bearer ${smallestApiKey}`, 'Content-Type': mimeType },
      body: req.file.buffer,
    });

    if (!response.ok) {
      const message = await response.text();
      return res.status(500).json({ error: 'Transcription failed.', details: message });
    }

    const data = await response.json();
    const text = (data?.text ?? data?.transcription ?? '').trim();
    return res.json({ text });
  } catch {
    return res.status(500).json({ error: 'Transcription failed.' });
  }
});

app.post('/api/character/chat', aiLimiter, async (req, res) => {
  try {
    const ai = getAiClient();
    if (!ai) return res.status(503).json({ error: 'AI service not configured.' });
    const message = String(req.body?.message ?? '').trim();
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const character = String(req.body?.character ?? 'Character').trim();
    const enableSearch = Boolean(req.body?.enableSearch);
    if (!message) return res.status(400).json({ error: 'Missing message.' });

    const characterModel = process.env.EINSTEIN_MODEL || model;
    const promptByCharacter = {
      'Albert Einstein': [
        'You are Albert Einstein, the theoretical physicist (1879–1955).',
        'You are one of the most influential scientists in history, best known for the theory of relativity and the mass-energy equivalence E=mc².',
        'Your areas of deep knowledge:',
        '- Special relativity: time dilation, length contraction, simultaneity, E=mc²',
        '- General relativity: spacetime curvature, gravity as geometry, black holes, gravitational waves',
        '- Photoelectric effect (for which you won the Nobel Prize in 1921)',
        '- Brownian motion and statistical mechanics',
        '- Quantum theory (though you were skeptical of its probabilistic nature — "God does not play dice")',
        '- Thought experiments (Gedankenexperiment) — riding a beam of light, the elevator in free fall',
        'Your speaking style:',
        '- Warm, curious, and humble despite your genius',
        '- Explain abstract ideas through vivid analogies and thought experiments',
        '- Occasionally reference your personal experiences (working at the patent office, fleeing Nazi Germany, Princeton)',
        '- Speak with gentle wonder about the universe',
        '- You can sprinkle in light German phrasing (e.g., "Ja, ja", "Wunderbar") but keep it subtle',
        'You exist inside an interactive virtual environment and can control the scene to help explain ideas visually.',
        'Possible scene actions:',
        'spawn_board — show a chalkboard',
        'write_equation — write a formula on the board',
        'spawn_diagram — show a diagram (e.g. spacetime, light cone)',
        'highlight_object — point attention to something',
        'play_animation — trigger an animation',
        'spawn_object — bring in a physical prop',
        'remove_object — clear something from the scene',
        'Use scene actions whenever a visual would make the concept click.',
        'Keep explanations short and interactive — guide the user step by step.'
      ].join('\n'),
      'Sudharshan Kamath': [
        'You are Sudharshan Kamath, co-founder and CEO of Smallest.ai.',
        'Smallest.ai builds ultra-fast, low-latency voice AI and conversational AI infrastructure.',
        'Your products include Waves (TTS), Pulse (STT), and Atoms (voice agents).',
        'Your personality:',
        '- sharp, direct, and thoughtful',
        '- deeply technical but explains things clearly',
        '- excited about the future of voice AI and real-time interaction',
        '- startup-minded: obsessed with speed, efficiency, and developer experience',
        '- friendly and approachable, not corporate',
        'You speak honestly about building a company, the challenges of real-time AI, and the vision for Smallest.ai.',
        'You enjoy talking about voice AI, latency, product design, startups, and the future of human-AI interaction.',
        "Keep responses concise and direct — like a founder who respects the other person's time."
      ].join('\n'),
      'Farza': [
        'You are Farza Majeed, founder of Buildspace and now makesomething — a free platform to learn AI alongside others through live sessions and building real things.',
        '',
        '## What you\'ve done:',
        '- Founded Buildspace (YC-backed): tens of thousands of builders shipped real projects in 6-week sprints called "seasons"',
        '- Now running makesomething (makesomething0 on Twitter): free live AI coding sessions, co-working in Discord',
        '- Last session: 2,500 people showed up. 70% had never touched a coding agent or built anything. By the end, people were deploying real apps to Vercel.',
        '- Next session focus: Replit + Codex, teaching total beginners to build their first ever AI app',
        '- Partners: OpenAI, Replit, Wispr Flow, Odysser — they gave away free tools (Codex, ChatGPT Plus, Replit Core, etc.) for attendees',
        '',
        '## What you believe (your core worldview):',
        '- The models are insane rn. But no one is showing beginners what\'s possible. That\'s the actual problem.',
        '- "Often, you are the market." — the best ideas come from making something for yourself, not from analyzing markets',
        '- When you over-intellectualize and look for "problems" and "market sizes", ideas sound good on paper but die in practice',
        '- The moment you stop over-thinking and build for yourself, ideas become genuinely interesting to others too',
        '- People are NOT lazy. They just don\'t know where to start. The appetite is there. The scaffolding and education are missing.',
        '- Millions of people are unemployed, sending 1,000 resumes on LinkedIn, can\'t find jobs. AI isn\'t saving them — they don\'t know how to use it beyond writing emails.',
        '- "Just because you invent the hammer doesn\'t mean everyone magically knows how to build a house with it."',
        '- The industrial revolution analogy: it only worked out because we built an entire education system from scratch. The tools didn\'t save anyone on their own.',
        '- It\'s never been a better time to start an education company. Millions want to learn. Many tools are free. The only thing missing is someone showing them the way.',
        '',
        '## Your speaking and writing style (CRITICAL — mimic this closely):',
        '- Casual, internet-native, lowercase-heavy: "rn", "rlly", "ppl", "ty", "fav", "fr", "ngl", "tbh"',
        '- Short paragraphs. One or two sentences max. Then a line break.',
        '- You don\'t shout or hype. You make a real point, back it with a real example, land the insight.',
        '- Warm and relatable — says "my buddies" not "people in the market"',
        '- Honest about hard stuff — acknowledges real unemployment, real struggle — doesn\'t gaslight people',
        '- Makes concrete arguments with real numbers (2,500 people, 70%, etc.)',
        '- Ends things graciously. Says thank you to the people who helped.',
        '- Example tweet style: "The appetite is there, but nearly all of the scaffolding + education is missing." — clean, direct, punchy.',
        '- Does NOT sound like LinkedIn or a startup podcast. Sounds like a smart friend who gets it.',
        '',
        '## How to talk to people:',
        '- If someone wants to build something: validate the impulse, push them to start small and ship ugly first',
        '- If someone is stuck: ask what they\'re actually making, then help them see the next small step',
        '- If someone is over-thinking: remind them that often they ARE the market',
        '- If someone doubts whether to learn AI: "the models are insane rn and everyone who learns this stuff now is going to be way ahead"',
        '- Never lecture. Never moralize. Talk like a friend.',
      ].join('\n'),
      'Dan Shipper': [
        'You are Dan Shipper, co-founder and CEO of Every (every.to) — a media company at the intersection of writing, software products, and AI consulting.',
        'Every has 15 employees, 100,000 newsletter subscribers, and a consulting practice generating ~$1M/year.',
        'Your products include Cora (AI email management), Sparkle, and Spiral.',
        '',
        '## What you know deeply:',
        '',
        '### The Allocation Economy',
        'You coined the term "allocation economy" — the successor to the knowledge economy.',
        'In the knowledge economy, the scarce resource was knowing things. AI collapses that.',
        'In the allocation economy, what matters is: vision-setting, evaluating AI outputs, knowing when to delegate vs. dive in, taste, and communication.',
        'AI is an abstraction layer over lower-level thinking — just like management is an abstraction layer over individual work.',
        'The skills that make a great manager are now the skills that make a great AI user.',
        '',
        '### AI as Reasoning Engine, not Knowledge Database',
        'LLMs are primarily reasoning engines, not knowledge stores. Their training enhances reasoning more than raw knowledge.',
        'This means AI is only as good as the knowledge you give it. Personal knowledge repositories become enormously valuable.',
        'Vector databases and retrieval are just as important as model improvements — they solve the knowledge problem.',
        'Percival Lowell thought he saw canals on Mars — confident reasoning on bad data produces confident wrong answers. Same with LLMs without the right context.',
        '',
        '### How Every Operates (AI-native company)',
        '"No one is manually coding anymore." Engineers use Claude Code to build products end-to-end.',
        'Every built Cora (an email AI) with 2 engineers and ~$300K total — possible only through AI leverage.',
        'You employ a Head of AI Operations who builds prompts and workflows for the whole team.',
        '"Compounding engineering": each project makes the next easier via shared prompt libraries and automation templates.',
        'Strongest predictor of org-wide AI adoption: does the CEO use ChatGPT daily? If yes, the org follows.',
        '',
        '### Funding Philosophy',
        'You pioneered the "sip seed" — $2M available but drawn incrementally. Preserves optionality and creative freedom.',
        'Companies using AI effectively need far less capital than traditional startups.',
        '',
        '### Generalists and AI',
        'Generalists thrive in "wicked" environments — unclear rules, novel problems — where AI still struggles.',
        'AI excels in "kind" environments (clear feedback, repetitive patterns). Specialists in those areas face displacement.',
        'The ability to adapt is the generalist\'s edge — it\'s what LLMs cannot do well yet.',
        '',
        '## Writing and thinking style:',
        'You open with a concrete story or historical anecdote that reveals an unexpected insight.',
        'You state your thesis directly and early — no burying the lede.',
        'You think out loud: "I find this very exciting because...", "For my part...", "Here\'s what I think is going on..."',
        'You reference specific companies, valuations, and real products to make arguments concrete.',
        'Conversational but intellectually precise.',
        'Use analogies to make technical concepts click.',
        'Genuinely curious and honest about uncertainty — not performatively confident.',
        'Self-deprecating when relevant.',
        '',
        '## How to talk:',
        'Engage like you\'re talking to a smart founder or operator who wants the real picture, not platitudes.',
        'Have a point of view. Don\'t hedge excessively.',
        'Reference your experience building Every when relevant.',
        'Keep it tight — you respect their time.',
      ].join('\n'),
      'Circus Lion': [
        'You are Leo the Circus Lion, a playful circus performer who loves toys and entertaining people.',
        'Your strongest characteristic is playful showmanship. You act like a circus star who loves performing tricks, juggling toys, and making the audience laugh. You are energetic, dramatic, and proud of your circus talents.',
        'Your personality:',
        '- playful and energetic',
        '- loves toys and circus tricks',
        '- dramatic like a performer on stage',
        '- friendly and encouraging',
        '- sometimes a little goofy',
        'You exist inside an interactive circus world where you can talk with the user and control the environment around you.',
        'You can trigger visual elements using scene commands.',
        'When something should appear or happen, use this format:',
        '[SCENE_ACTION: action_name(parameters)]',
        'Examples:',
        '[SCENE_ACTION: spawn_object("circus_ball")]',
        '[SCENE_ACTION: spawn_object("toy_box")]',
        '[SCENE_ACTION: spawn_object("juggling_pins")]',
        '[SCENE_ACTION: spawn_object("rubber_chicken")]',
        '[SCENE_ACTION: animate("lion_juggle")]',
        '[SCENE_ACTION: animate("lion_roar_proud")]',
        '[SCENE_ACTION: spawn_object("circus_ring")]',
        'Rules:',
        '- Keep interactions playful and entertaining.',
        '- Use toys and circus tricks to demonstrate things.',
        '- Be expressive and energetic like a performer.',
        '- Use scene actions to create fun circus moments.',
        '- Encourage the user to play along or try tricks.',
        'Interaction style:',
        '- treats the user like part of the circus audience',
        '- loves showing new toys and tricks',
        '- sometimes challenges the user to games',
        '- celebrates successful tricks dramatically'
      ].join('\n'),
    };

    const prompt = promptByCharacter[character] || `You are ${character}, friendly and engaging.`;
    const searchInstruction = enableSearch
      ? 'You have access to live Google Search. Use it for current events, facts, and recent data. Still return JSON with keys: reply, action, objects.'
      : '';
    const systemPrompt = [
      prompt,
      'IMPORTANT: Keep every reply under 25 words. Short punchy sentences only.',
      'If explaining something, use at most 25 words. If just reacting, use under 10 words.',
      'Use scene actions when something visual or funny should happen.',
      'Return JSON only with keys: reply, action, objects.',
      'reply = the speech you say. action = a short string of SCENE_ACTION tags to perform.',
      'objects = a short list (0-3) of concrete props to include based on the conversation.',
      searchInstruction,
    ].filter(Boolean).join('\n\n');

    const contentParts = [
      { text: systemPrompt },
      ...history.map((entry) => ({ text: `${entry.role === 'user' ? 'User' : character}: ${entry.content}` })),
      { text: `User: ${message}` },
    ];

    const generateParams = {
      model: characterModel,
      generationConfig: { maxOutputTokens: enableSearch ? 400 : 160 },
      contents: [{ role: 'user', parts: contentParts }],
    };
    if (enableSearch) {
      generateParams.tools = [{ googleSearch: {} }];
    }
    const response = await ai.models.generateContent(generateParams);

    const raw = response.text?.trim() || '';
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          parsed = null;
        }
      }
    }

    let reply = '';
    let action = '';
    let objects = [];

    if (parsed && typeof parsed === 'object') {
      reply = String(parsed.reply ?? '').trim();
      action = String(parsed.action ?? '').trim();
      objects = Array.isArray(parsed.objects) ? parsed.objects.slice(0, 3) : [];
    } else {
      const sceneTags = raw.match(/\[SCENE_ACTION:[^\]]+\]/g) || [];
      action = sceneTags.join(' ').trim();
      reply = raw.replace(/\[SCENE_ACTION:[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
    }

    const embeddedSceneTags = reply.match(/\[SCENE_ACTION:[^\]]+\]/g) || [];
    if (embeddedSceneTags.length) {
      if (!action) {
        action = embeddedSceneTags.join(' ').trim();
      }
      reply = reply.replace(/\[SCENE_ACTION:[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
    }

    if (!reply) {
      reply = 'Hmm, interesting.';
    }

    let sources = [];
    if (enableSearch) {
      try {
        const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        sources = chunks
          .filter((c) => c.web?.uri)
          .map((c) => ({ title: c.web.title || c.web.uri, url: c.web.uri }))
          .slice(0, 3);
      } catch { /* non-fatal */ }
    }

    return res.json({ reply, action, objects, sources, searchUsed: enableSearch });
  } catch {
    return res.status(500).json({ error: 'Chat failed.' });
  }
});

// ─── Voice cloning ────────────────────────────────────────────────────────────
app.post('/api/voice-clone', uploadVoiceClone.single('audio'), async (req, res) => {
  try {
    const smallestApiKey = runtimeConfig.smallestApiKey;
    if (!smallestApiKey) return res.status(503).json({ error: 'TTS service not configured.' });
    if (!req.file) return res.status(400).json({ error: 'No audio file provided.' });

    const name = String(req.body?.name ?? `clone-${Date.now()}`).trim().slice(0, 64) || `clone-${Date.now()}`;
    const mime = req.file.mimetype || 'audio/webm';
    const filename = req.file.originalname || `voice_sample.webm`;
    console.log('[voice-clone] size:', req.file.size, 'bytes | name:', name, '| mime:', mime, '| filename:', filename);

    // Build multipart body manually to avoid Node.js Blob/FormData issues on Windows
    const boundary = `----FormBoundary${Date.now().toString(16)}`;
    const CRLF = '\r\n';
    const bodyParts = [
      `--${boundary}${CRLF}`,
      `Content-Disposition: form-data; name="displayName"${CRLF}${CRLF}`,
      `${name}${CRLF}`,
      `--${boundary}${CRLF}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}`,
      `Content-Type: ${mime}${CRLF}${CRLF}`,
    ];
    const bodyEnd = `${CRLF}--${boundary}--${CRLF}`;
    const bodyBuffer = Buffer.concat([
      Buffer.from(bodyParts.join('')),
      req.file.buffer,
      Buffer.from(bodyEnd),
    ]);

    console.log('[voice-clone] POSTing to Smallest AI... body size:', bodyBuffer.length);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      console.error('[voice-clone] Request timed out after 60s, aborting.');
      controller.abort();
    }, 60000);
    let response;
    try {
      response = await fetch('https://api.smallest.ai/waves/v1/lightning-large/add_voice', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${smallestApiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(bodyBuffer.length),
        },
        body: bodyBuffer,
        signal: controller.signal,
      });
    } catch (fetchErr) {
      console.error('[voice-clone] fetch error name:', fetchErr.name, '| message:', fetchErr.message, '| cause:', fetchErr.cause);
      throw fetchErr;
    } finally {
      clearTimeout(timeout);
    }

    console.log('[voice-clone] Smallest AI status:', response.status, response.statusText);

    if (!response.ok) {
      const message = await response.text();
      console.error('[voice-clone] error body:', message);
      let userMessage = 'Voice cloning failed.';
      try {
        const parsed = JSON.parse(message);
        if (parsed.error_code === 'voice_clone_timeout') userMessage = 'Voice cloning timed out on the server. Please try again.';
        else if (parsed.error) userMessage = parsed.error;
      } catch {}
      return res.status(500).json({ error: userMessage, details: message });
    }

    const data = await response.json();
    console.log('[voice-clone] response:', JSON.stringify(data));
    const voiceId = data.id ?? data.voice_id ?? data.voiceId ?? data.data?.voiceId ?? data.data?.id ?? data.data?.voice_id;
    if (!voiceId) {
      return res.status(500).json({ error: 'Voice cloning response missing voice ID.', raw: data });
    }
    return res.json({ voiceId, name });
  } catch (err) {
    console.error('[voice-clone] exception:', err);
    return res.status(500).json({ error: 'Voice cloning failed.' });
  }
});

app.post('/api/character/tts', async (req, res) => {
  try {
    const smallestApiKey = runtimeConfig.smallestApiKey;
    if (!smallestApiKey) return res.status(503).json({ error: 'TTS service not configured.' });
    // Expand internet abbreviations so TTS pronounces them correctly
    const abbrevMap = {
      '\\brn\\b': 'right now',
      '\\bngl\\b': 'not gonna lie',
      '\\bfr\\b': 'for real',
      '\\btbh\\b': 'to be honest',
      '\\bppl\\b': 'people',
      '\\brlly\\b': 'really',
      '\\bty\\b': 'thank you',
      '\\bidk\\b': 'I don\'t know',
      '\\bidc\\b': 'I don\'t care',
      '\\bimo\\b': 'in my opinion',
      '\\bsmh\\b': 'shaking my head',
      '\\bbtw\\b': 'by the way',
      '\\biykyk\\b': 'if you know you know',
      '\\bfwiw\\b': 'for what it\'s worth',
      '\\baf\\b': 'as heck',
      '\\bw\\b': 'win',
      '\\blmao\\b': 'ha',
      '\\blol\\b': 'ha',
    };
    const rawText = Object.entries(abbrevMap).reduce(
      (t, [pattern, replacement]) => t.replace(new RegExp(pattern, 'gi'), replacement),
      String(req.body?.text ?? '')
        .replace(/\*+/g, '')
        // Lowercase all-caps words (2+ letters) so TTS doesn't spell them out
        .replace(/\b([A-Z]{2,})\b/g, (m) => m.charAt(0) + m.slice(1).toLowerCase())
    ).trim();
    if (!rawText) return res.status(400).json({ error: 'Missing text.' });
    // lightning-v3.1 has a 140-char limit — truncate at last sentence boundary before limit
    const TTS_LIMIT = 140;
    let text = rawText;
    if (text.length > TTS_LIMIT) {
      const cut = text.slice(0, TTS_LIMIT);
      const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf(', '));
      text = lastBreak > 20 ? text.slice(0, lastBreak + 1) : cut.trimEnd();
      console.log('[character/tts] text truncated from', rawText.length, 'to', text.length, 'chars');
    }

    const clonedVoiceId = String(req.body?.voiceId ?? '').trim();
    const isClonedVoice = clonedVoiceId.startsWith('voice_');
    const model = isClonedVoice ? 'lightning-large' : 'lightning-v3.1';
    const voiceId = clonedVoiceId || 'magnus';
    const endpoint = `https://api.smallest.ai/waves/v1/${model}/get_speech`;

    console.log('[character/tts] voice_id:', voiceId, '| model:', model);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${smallestApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        voice_id: voiceId,
        sample_rate: 24000,
        output_format: 'wav',
      })
    });

    console.log('[character/tts] Smallest AI status:', response.status, response.statusText);
    console.log('[character/tts] response headers:', Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      const message = await response.text();
      console.error('[character/tts] Smallest AI error body:', message);
      return res.status(500).json({ error: 'TTS failed.', details: message, voiceIdUsed: voiceId });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    console.log('[character/tts] audio buffer size:', buffer.length, 'bytes');
    console.log('[character/tts] first 16 bytes (hex):', buffer.slice(0, 16).toString('hex'));
    console.log('[character/tts] first 16 bytes (ascii):', buffer.slice(0, 16).toString('ascii').replace(/[^\x20-\x7E]/g, '.'));
    if (buffer.length < 100) {
      console.error('[character/tts] suspiciously small buffer — full content:', buffer.toString());
    }
    res.setHeader('Content-Type', 'audio/wav');
    return res.send(buffer);
  } catch (err) {
    console.error('[character/tts] exception:', err);
    return res.status(500).json({ error: 'TTS failed.' });
  }
});

// Backwards compatibility
app.post('/api/einstein/stt', upload.single('audio'), (req, res) => {
  req.url = '/api/character/stt';
  return app._router.handle(req, res);
});
app.post('/api/einstein/chat', aiLimiter, (req, res) => {
  req.url = '/api/character/chat';
  return app._router.handle(req, res);
});

app.post('/api/einstein/tts', async (req, res) => {
  try {
    const smallestApiKey = runtimeConfig.smallestApiKey;
    if (!smallestApiKey) return res.status(503).json({ error: 'TTS service not configured.' });
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'Missing text.' });

    const voiceModel = 'lightning-v3.1';
    const voiceId = 'jordan';

    const endpoint = 'https://api.smallest.ai/waves/v1/lightning-v3.1/get_speech';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${smallestApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        model: voiceModel,
        voice_id: voiceId,
        sample_rate: 24000,
        speed: 1,
        language: 'en',
        output_format: 'wav'
      })
    });

    if (!response.ok) {
      const message = await response.text();
      return res.status(500).json({ error: 'TTS failed.', details: message });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', 'audio/wav');
    return res.send(buffer);
  } catch {
    return res.status(500).json({ error: 'TTS failed.' });
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
