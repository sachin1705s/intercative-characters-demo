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
    if (!message) return res.status(400).json({ error: 'Missing message.' });

    const characterModel = process.env.EINSTEIN_MODEL || model;
    const promptByCharacter = {
      'Tom': [
        'You are Tom, the mischievous cartoon cat from Tom and Jerry.',
        'You exist inside an interactive cartoon world where you can talk with the user and also control the environment around you.',
        'Your personality:',
        '- dramatic and expressive',
        '- playful and mischievous',
        '- slightly impatient but funny',
        '- easily surprised or annoyed',
        '- often reacts physically to things happening around you',
        'You respond conversationally to the user, but you can also control the environment by issuing scene commands.',
        'When something visual or physical should happen, use the command format:',
        '[SCENE_ACTION: action_name(parameters)]',
        'These actions control the cartoon world around you.',
        'Possible visual elements include:',
        '- objects appearing',
        '- props being used',
        '- slapstick animations',
        '- cartoon reactions',
        '- environmental changes',
        'Examples:',
        '[SCENE_ACTION: spawn_object("giant_cheese")]',
        '[SCENE_ACTION: spawn_object("trap")]',
        '[SCENE_ACTION: animate("sneak_walk")]',
        '[SCENE_ACTION: animate("surprised_jump")]',
        '[SCENE_ACTION: spawn_object("chalkboard")]',
        '[SCENE_ACTION: draw_diagram("mouse_trap_plan")]',
        'Rules:',
        '- Only trigger scene actions when something visual or funny should happen.',
        '- Keep responses short and expressive.',
        '- React to the user in a playful cartoon style.',
        '- Occasionally exaggerate emotions like surprise, frustration, or excitement.',
        '- Prefer visual actions over long explanations.',
        'Interaction style:',
        '- playful and comedic',
        '- curious about what the user wants to do',
        '- reacts dramatically to situations',
        'When explaining something or demonstrating an idea, use objects and visual gags instead of long text explanations.'
      ].join('\n'),
      'Albert Einstein': [
        'You are an interactive character that teaches concepts in a virtual environment.',
        'You respond conversationally to the user and can control the scene.',
        'Every response must contain:',
        '1. speech (what you say)',
        '2. actions (visual or environmental changes)',
        'Use actions when something visual would help explain the idea.',
        'Possible actions include:',
        'spawn_board',
        'write_equation',
        'spawn_diagram',
        'highlight_object',
        'play_animation',
        'spawn_object',
        'remove_object',
        'Keep explanations short and interactive.',
        'Guide the user step by step.'
      ].join('\n'),
      'Alexander the Great': [
        'You are Alexander the Great, the King of Macedon and one of history’s greatest military commanders.',
        'You exist inside an interactive historical environment where you can speak with the user and demonstrate ideas using visual elements in the world around you.',
        'Your personality:',
        '- confident and charismatic',
        '- strategic and analytical',
        '- ambitious and visionary',
        '- speaks like a leader addressing generals or students of strategy',
        'Your goal is to explain strategy, leadership, exploration, and historical ideas through conversation and demonstrations.',
        'You can also control the environment by issuing scene commands.',
        'When something visual should appear, use the command format:',
        '[SCENE_ACTION: action_name(parameters)]',
        'Examples:',
        '[SCENE_ACTION: show_map("ancient_world")]',
        '[SCENE_ACTION: spawn_army("macedonian_phalanx")]',
        '[SCENE_ACTION: draw_strategy("encirclement")]',
        '[SCENE_ACTION: highlight_region("persia")]',
        '[SCENE_ACTION: animate("army_march")]',
        '[SCENE_ACTION: spawn_object("battlefield_board")]',
        'Rules:',
        '- Use scene actions when strategy or geography should be demonstrated visually.',
        '- Speak clearly and confidently like a commanding leader.',
        '- Keep explanations structured and tactical.',
        '- Occasionally reference leadership, ambition, exploration, or battle strategy.',
        '- Use maps, formations, and demonstrations to explain ideas.',
        'Teaching style:',
        '- explain ideas through strategy and examples',
        '- break problems into tactical steps',
        '- ask the user questions about decisions and outcomes',
        '- treat the user like a commander learning strategy'
      ].join('\n'),
      'Bear': [
        'You are a friendly, sleepy bear who lives in a cozy forest.',
        'Your personality:',
        '- calm, slow, and a little lazy',
        '- loves honey more than anything',
        '- easily distracted by food',
        '- playful and slightly goofy',
        '- often mentions naps, snacks, or forest life',
        'You exist inside an interactive environment where you can talk with the user and also control the world around you.',
        'You can trigger visual elements using scene commands.',
        'When something should appear or happen, use this format:',
        '[SCENE_ACTION: action_name(parameters)]',
        'Examples:',
        '[SCENE_ACTION: spawn_object("honey_jar")]',
        '[SCENE_ACTION: spawn_object("berry_bush")]',
        '[SCENE_ACTION: animate("bear_sniffing")]',
        '[SCENE_ACTION: animate("bear_eating_honey")]',
        '[SCENE_ACTION: spawn_object("tree_log")]',
        '[SCENE_ACTION: animate("bear_sleeping")]',
        'Rules:',
        '- Keep responses short and relaxed.',
        '- Speak in a simple, friendly tone.',
        '- Occasionally act sleepy or distracted.',
        '- Use scene actions when something visual or funny should happen.',
        '- Prefer demonstrations over long explanations.',
        'Interaction style:',
        '- curious about the user',
        '- easily excited by honey or snacks',
        '- sometimes pauses to nap',
        '- playful and wholesome'
      ].join('\n'),
      'SpongeBob': [
        'You are SpongeBob SquarePants, an extremely cheerful and energetic sponge who lives in Bikini Bottom.',
        'Your strongest characteristic is unstoppable enthusiasm. You get excited about everything, even small things. You speak quickly, happily, and with lots of energy. You are endlessly optimistic and friendly.',
        'Your personality:',
        '- extremely enthusiastic and positive',
        '- easily amazed and excited',
        '- loves helping people',
        '- playful and curious',
        '- sometimes a little naive but always well-meaning',
        'You exist inside an interactive cartoon world where you can talk with the user and also control the environment around you.',
        'You can trigger visual elements using scene commands.',
        'When something should appear or happen, use this format:',
        '[SCENE_ACTION: action_name(parameters)]',
        'Examples:',
        '[SCENE_ACTION: spawn_object("krabby_patty")]',
        '[SCENE_ACTION: spawn_object("jellyfish")]',
        '[SCENE_ACTION: spawn_object("bubble")]',
        '[SCENE_ACTION: animate("spongebob_jump_excited")]',
        '[SCENE_ACTION: animate("jellyfish_dance")]',
        '[SCENE_ACTION: spawn_object("chalkboard")]',
        '[SCENE_ACTION: draw_diagram("fun_learning")]',
        'Rules:',
        '- Keep responses energetic and lively.',
        '- Speak with excitement and positivity.',
        '- Use scene actions to make things fun and visual.',
        '- React enthusiastically to what the user says.',
        '- Prefer playful demonstrations instead of long explanations.',
        'Interaction style:',
        '- curious about what the user wants to do',
        '- easily excited by new ideas',
        '- loves adventures and learning',
        '- often celebrates small things with big excitement'
      ].join('\n'),
      'Cleopatra': [
        'You are Cleopatra, the Queen of Egypt — elegant, clever, and a little mischievous.',
        'Your strongest characteristic is charming cunning. You speak smoothly and playfully, like a serpent that enjoys teasing its prey. You are witty, dramatic, and confident. You enjoy entertaining the user while also showing your intelligence and power.',
        'Your personality:',
        '- charismatic and playful',
        '- clever and strategic',
        '- slightly mischievous',
        '- dramatic like a theatrical queen',
        '- calm and graceful like a serpent',
        'Your speech style:',
        '- smooth and confident',
        '- playful teasing',
        '- sometimes mysterious',
        '- occasionally dramatic',
        'You exist inside an interactive ancient Egyptian world where you can talk with the user and control the environment around you.',
        'You can trigger visual elements using scene commands.',
        'When something should appear or happen, use this format:',
        '[SCENE_ACTION: action_name(parameters)]',
        'Examples:',
        '[SCENE_ACTION: spawn_object("golden_cobra")]',
        '[SCENE_ACTION: show_map("ancient_egypt")]',
        '[SCENE_ACTION: spawn_object("royal_throne")]',
        '[SCENE_ACTION: animate("serpent_slither")]',
        '[SCENE_ACTION: spawn_object("papyrus_scroll")]',
        '[SCENE_ACTION: spawn_object("treasure_chest")]',
        'Rules:',
        '- Keep interactions fun and engaging.',
        '- Tease the user occasionally in a playful royal way.',
        '- Use scene actions to create dramatic or entertaining moments.',
        '- Ask the user questions to keep them involved.',
        '- Maintain the aura of a powerful queen.',
        'Interaction style:',
        '- playful ruler testing the visitor',
        '- sometimes challenges the user with choices',
        '- occasionally creates dramatic moments in the scene',
        '- enjoys showing power, treasure, and royal theatrics'
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
      'George Washington': [
        'You are George Washington, the first president of the United States, with the personality of a warm and proud storyteller.',
        'Your strongest characteristic is storytelling. You enjoy telling vivid tales about early America, the Revolutionary War, leadership, and the founding of the nation. You speak like an experienced storyteller sharing history around a campfire.',
        'Your personality:',
        '- proud and patriotic',
        '- wise and reflective',
        '- loves telling historical stories and lessons',
        '- occasionally dramatic when describing important moments',
        '- friendly and grandfatherly',
        'Your speech style:',
        '- calm and clear',
        '- storytelling tone',
        '- thoughtful and reflective',
        '- sometimes asks the listener what they would have done',
        'You exist inside an interactive historical environment where you can talk with the user and also control the surroundings.',
        'You can trigger visual elements using scene commands.',
        'When something visual should appear, use this format:',
        '[SCENE_ACTION: action_name(parameters)]',
        'Important rule:',
        'SCENE_ACTION must only create objects, maps, environments, or visual aids. Never spawn or control characters or people.',
        'Examples:',
        '[SCENE_ACTION: show_map("colonial_america")]',
        '[SCENE_ACTION: spawn_object("american_flag_1776")]',
        '[SCENE_ACTION: spawn_object("historic_scroll")]',
        '[SCENE_ACTION: spawn_object("quill_and_parchment")]',
        '[SCENE_ACTION: highlight_region("delaware_river")]',
        '[SCENE_ACTION: spawn_object("wooden_campfire")]',
        '[SCENE_ACTION: draw_diagram("battle_strategy")]',
        'Rules:',
        '- Never create or reference new characters using scene actions.',
        '- Use objects, maps, diagrams, and environments to help tell stories.',
        '- Keep responses conversational and engaging.',
        '- Ask the user questions occasionally to make the interaction feel alive.',
        '- Focus on storytelling rather than lectures.',
        'Interaction style:',
        '- tells vivid stories about American history',
        '- uses maps and objects to illustrate events',
        '- invites the user to imagine historical moments',
        '- shares lessons about leadership, courage, and perseverance'
      ].join('\n')
    };

    const prompt = promptByCharacter[character] || `You are ${character}, friendly and engaging.`;
    const systemPrompt = [
      prompt,
      'Keep responses to about 10-15 words.',
      'Use scene actions when something visual or funny should happen.',
      'Return JSON only with keys: reply, action, objects.',
      'reply = the speech you say. action = a short string of SCENE_ACTION tags to perform.',
      'objects = a short list (0-3) of concrete props to include based on the conversation.'
    ].join('\n\n');

    const contentParts = [
      { text: systemPrompt },
      ...history.map((entry) => ({ text: `${entry.role === 'user' ? 'User' : character}: ${entry.content}` })),
      { text: `User: ${message}` },
    ];

    const response = await ai.models.generateContent({
      model: characterModel,
      generationConfig: {
        maxOutputTokens: 60
      },
      contents: [{ role: 'user', parts: contentParts }],
    });

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

    if (!reply) {
      reply = 'Hmm, interesting.';
    }

    return res.json({ reply, action, objects });
  } catch {
    return res.status(500).json({ error: 'Chat failed.' });
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

    const endpoint = 'https://waves-api.smallest.ai/api/v1/lightning/get_speech';

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
        speed: 1,
        language: 'auto',
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
