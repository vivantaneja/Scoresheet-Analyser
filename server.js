require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = !!process.env.VERCEL;
const WORK_DIR = IS_VERCEL ? '/tmp' : __dirname;
const DATA_FILE = path.join(WORK_DIR, 'data.json');
const GEMINI_RESPONSE_FILE = path.join(WORK_DIR, 'gemini-response.json');
const SCHEMA_FILE = path.join(__dirname, 'schema.json');
const PROMPT_FILE = path.join(__dirname, 'extraction-prompt.txt');
const UPLOAD_DIR = path.join(WORK_DIR, 'uploads');

const DEFAULT_EXTRACTION_PROMPT = 'Extract basketball match header information and return a JSON object with keys: teamAName, teamBName, competitionName, date (YYYY-MM-DD), time (HH:MM), place, referee1, referee2. Use empty string if not found. Return only the JSON.';

const INTEGER_KEYS = [
  'teamATimeoutsFirstHalf', 'teamATimeoutsSecondHalf', 'teamATimeoutsExtraPeriods',
  'teamAFoulsPeriod1', 'teamAFoulsPeriod2', 'teamAFoulsPeriod3', 'teamAFoulsPeriod4',
  'teamBTimeoutsFirstHalf', 'teamBTimeoutsSecondHalf', 'teamBTimeoutsExtraPeriods',
  'teamBFoulsPeriod1', 'teamBFoulsPeriod2', 'teamBFoulsPeriod3', 'teamBFoulsPeriod4'
];

const DEFAULT_DATA = {
  teamAName: '',
  teamBName: '',
  competitionName: '',
  date: '',
  time: '',
  place: '',
  referee1: '',
  referee2: '',
  teamATimeoutsFirstHalf: 0,
  teamATimeoutsSecondHalf: 0,
  teamATimeoutsExtraPeriods: 0,
  teamAFoulsPeriod1: 0,
  teamAFoulsPeriod2: 0,
  teamAFoulsPeriod3: 0,
  teamAFoulsPeriod4: 0,
  teamBTimeoutsFirstHalf: 0,
  teamBTimeoutsSecondHalf: 0,
  teamBTimeoutsExtraPeriods: 0,
  teamBFoulsPeriod1: 0,
  teamBFoulsPeriod2: 0,
  teamBFoulsPeriod3: 0,
  teamBFoulsPeriod4: 0,
  teamAPlayers: [],
  teamBPlayers: [],
  runningScoreEvents: [],
  periodScoresTeamA: [0, 0, 0, 0],
  periodScoresTeamB: [0, 0, 0, 0],
  finalScoreTeamA: 0,
  finalScoreTeamB: 0,
  pointsPerColumn: 40,
  r2PeriodScoresTeamA: [0, 0, 0, 0],
  r2PeriodScoresTeamB: [0, 0, 0, 0],
  r3FinalScoreTeamA: 0,
  r3FinalScoreTeamB: 0,
  r3WinningTeamName: '',
  playerScoringOverrides: { A: {}, B: {} }
};

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!fs.existsSync(PROMPT_FILE)) {
  console.warn(
    'extraction-prompt.txt not found next to server.js; using built-in header-only prompt. Full scoresheet extraction will look empty. Ensure extraction-prompt.txt is deployed (e.g. Vercel includeFiles).'
  );
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + (file.originalname || 'scoresheet').replace(/[^a-zA-Z0-9._-]/g, '_'))
  }),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const MIME_TO_GEMINI = {
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
  'image/heic': 'image/heic',
  'image/heif': 'image/heif',
  'application/pdf': 'application/pdf'
};

function getMimeType(filePath, originalName, multerMime) {
  const ext = path.extname(originalName || filePath).toLowerCase().replace(/^\./, '');
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
    pdf: 'application/pdf'
  };
  const fromExt = map[ext];
  if (fromExt) return fromExt;
  const m = String(multerMime || '').split(';')[0].trim().toLowerCase();
  if (m && MIME_TO_GEMINI[m]) return m;
  return 'application/octet-stream';
}

/** Convert JSON Schema (schema.json) to Gemini ResponseSchema format (type, description, properties, items, required only). */
function getExtractionResponseSchema() {
  try {
    const raw = fs.readFileSync(SCHEMA_FILE, 'utf8');
    const json = JSON.parse(raw);
    return jsonSchemaToGeminiSchema(json);
  } catch (e) {
    return null;
  }
}

function jsonSchemaToGeminiSchema(node) {
  if (!node || typeof node !== 'object') return undefined;
  const out = {};
  if (node.type != null) out.type = node.type;
  if (node.format != null) out.format = node.format;
  if (node.description != null) out.description = node.description;
  if (node.nullable != null) out.nullable = node.nullable;
  if (node.enum != null) out.enum = node.enum;
  if (node.required != null) out.required = node.required;
  if (node.properties != null) {
    out.properties = {};
    for (const k of Object.keys(node.properties)) {
      const v = jsonSchemaToGeminiSchema(node.properties[k]);
      if (v != null) out.properties[k] = v;
    }
  }
  if (node.items != null) {
    const items = jsonSchemaToGeminiSchema(node.items);
    if (items != null) out.items = items;
  }
  return Object.keys(out).length ? out : undefined;
}

const EXTRACTION_KEYS = 'teamAName, teamBName, competitionName, date, time, place, referee1, referee2, teamATimeoutsFirstHalf, teamATimeoutsSecondHalf, teamATimeoutsExtraPeriods, teamAFoulsPeriod1, teamAFoulsPeriod2, teamAFoulsPeriod3, teamAFoulsPeriod4, teamBTimeoutsFirstHalf, teamBTimeoutsSecondHalf, teamBTimeoutsExtraPeriods, teamBFoulsPeriod1, teamBFoulsPeriod2, teamBFoulsPeriod3, teamBFoulsPeriod4';

function getExtractionPrompt() {
  let prompt = DEFAULT_EXTRACTION_PROMPT;
  try {
    if (fs.existsSync(PROMPT_FILE)) {
      prompt = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
    }
  } catch (e) {}
  prompt = prompt + '\n\nOutput a JSON object with exactly these keys (and no others): ' + EXTRACTION_KEYS + '.';
  return prompt + '\n\nReturn only the JSON object, no markdown or other text. Use empty string "" only when the value is not visible in the document.';
}

function getMinimalImagePrompt() {
  let prompt = DEFAULT_EXTRACTION_PROMPT;
  try {
    if (fs.existsSync(PROMPT_FILE)) {
      prompt = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
    }
  } catch (e) {}
  let schemaBlock = '';
  try {
    schemaBlock = '\n\nSchema:\n' + fs.readFileSync(SCHEMA_FILE, 'utf8').trim();
  } catch (e) {}
  return (
    prompt +
    schemaBlock +
    '\n\nReturn a single JSON object matching the schema. Use empty string "" for any value not visible. No other text.' +
    '\n\nInclude every top-level key from the schema in your JSON. Use [] only for teamAPlayers, teamBPlayers, or runningScoreEvents when those sections are missing or unreadable; if you can read marks or rows, you must populate them. Use 0 for numeric fields only when the value is not shown on the sheet.'
  );
}

function parseJsonFromResponse(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {}
    }
  }
  return {};
}

/** Prefer SDK text(); fall back to candidate parts if text() throws (e.g. some finish reasons). */
function getGenerativeText(response) {
  try {
    const t = response.text();
    if (t) return t;
  } catch (e) {
    const msg = e?.message || '';
    if (!/candidates|finish|safety|block/i.test(msg)) console.warn('Gemini response.text() failed:', msg.slice(0, 200));
  }
  const parts = response.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
}

function isKeyEcho(key, value) {
  if (value == null || value === '') return true;
  const s = String(value).trim().toLowerCase();
  const camel = key.toLowerCase();
  const snake = key.replace(/([A-Z])/g, (m) => '_' + m.toLowerCase()).replace(/^_/, '');
  return s === camel || s === snake;
}

const PLAYER_KEYS = ['bipinNo', 'playerInQuarter1', 'playerInQuarter2', 'playerInQuarter3', 'playerInQuarter4', 'playerName', 'kitNo', 'foul1', 'foul2', 'foul3', 'foul4', 'foul5'];

function defaultPlayer() {
  const o = {};
  PLAYER_KEYS.forEach((k) => (o[k] = ''));
  return o;
}

function normalizePlayer(p) {
  const d = defaultPlayer();
  if (!p || typeof p !== 'object') return d;
  PLAYER_KEYS.forEach((k) => {
    const v = p[k];
    if (v != null && String(v).trim() !== '') d[k] = String(v).trim();
  });
  return d;
}

const MAX_PLAYERS_PER_TEAM = 12;

function normalizePlayerArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, MAX_PLAYERS_PER_TEAM).map(normalizePlayer);
}

function normalizeRunningScoreEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const point = parseInt(String(e.point), 10);
  const team = String(e.team || '').toUpperCase().trim();
  const type = String(e.type || '').trim();
  const jersey = String(e.jersey != null ? e.jersey : '').trim();
  if (Number.isNaN(point) || point < 1 || point > 120) return null;
  if (team !== 'A' && team !== 'B') return null;
  if (type !== '1' && type !== '2' && type !== '3') return null;
  return { point, team, type, jersey };
}

function normalizeRunningScoreEvents(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const events = arr
    .map(normalizeRunningScoreEvent)
    .filter(Boolean)
    .filter((e) => {
      const key = `${e.point}-${e.team}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.point - b.point);
  return events;
}

function normalizePeriodScores(arr) {
  if (!Array.isArray(arr)) return [0, 0, 0, 0];
  return [0, 1, 2, 3].map((i) => {
    const n = parseInt(String(arr[i]), 10);
    return Number.isNaN(n) || n < 0 ? 0 : n;
  });
}

function normalizeCumulativeArray(arr, maxLen = 120) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, maxLen).map((v) => {
    const n = parseInt(String(v), 10);
    return Number.isNaN(n) || n < 0 ? 0 : n;
  });
}

function normalizePlayerScoringOverrides(obj) {
  const out = { A: {}, B: {} };
  if (!obj || typeof obj !== 'object') return out;
  ['A', 'B'].forEach((team) => {
    const t = obj[team];
    if (!t || typeof t !== 'object') return;
    Object.keys(t).forEach((jersey) => {
      const j = String(jersey).trim();
      if (!j) return;
      const v = t[jersey];
      if (!v || typeof v !== 'object') return;
      const p1 = parseInt(String(v.p1), 10);
      const p2 = parseInt(String(v.p2), 10);
      const p3 = parseInt(String(v.p3), 10);
      out[team][j] = {
        p1: Number.isNaN(p1) || p1 < 0 ? 0 : p1,
        p2: Number.isNaN(p2) || p2 < 0 ? 0 : p2,
        p3: Number.isNaN(p3) || p3 < 0 ? 0 : p3
      };
    });
  });
  return out;
}

function normalizeExtracted(parsed) {
  const out = { ...DEFAULT_DATA };
  const keyAliases = {
    teamAName: ['teamAName', 'team_a_name', 'teamA', 'team_a'],
    teamBName: ['teamBName', 'team_b_name', 'teamB', 'team_b'],
    competitionName: ['competitionName', 'competition_name', 'competition'],
    date: ['date'],
    time: ['time'],
    place: ['place', 'venue', 'location'],
    referee1: ['referee1', 'referee_1', 'refereeOne'],
    referee2: ['referee2', 'referee_2', 'refereeTwo'],
    teamATimeoutsFirstHalf: ['teamATimeoutsFirstHalf', 'team_a_timeouts_first_half'],
    teamATimeoutsSecondHalf: ['teamATimeoutsSecondHalf', 'team_a_timeouts_second_half'],
    teamATimeoutsExtraPeriods: ['teamATimeoutsExtraPeriods', 'team_a_timeouts_extra_periods'],
    teamAFoulsPeriod1: ['teamAFoulsPeriod1', 'team_a_fouls_period_1'],
    teamAFoulsPeriod2: ['teamAFoulsPeriod2', 'team_a_fouls_period_2'],
    teamAFoulsPeriod3: ['teamAFoulsPeriod3', 'team_a_fouls_period_3'],
    teamAFoulsPeriod4: ['teamAFoulsPeriod4', 'team_a_fouls_period_4'],
    teamBTimeoutsFirstHalf: ['teamBTimeoutsFirstHalf', 'team_b_timeouts_first_half'],
    teamBTimeoutsSecondHalf: ['teamBTimeoutsSecondHalf', 'team_b_timeouts_second_half'],
    teamBTimeoutsExtraPeriods: ['teamBTimeoutsExtraPeriods', 'team_b_timeouts_extra_periods'],
    teamBFoulsPeriod1: ['teamBFoulsPeriod1', 'team_b_fouls_period_1'],
    teamBFoulsPeriod2: ['teamBFoulsPeriod2', 'team_b_fouls_period_2'],
    teamBFoulsPeriod3: ['teamBFoulsPeriod3', 'team_b_fouls_period_3'],
    teamBFoulsPeriod4: ['teamBFoulsPeriod4', 'team_b_fouls_period_4']
  };
  for (const k of Object.keys(DEFAULT_DATA)) {
    if (k === 'teamAPlayers' || k === 'teamBPlayers' || k === 'runningScoreEvents' || k === 'periodScoresTeamA' || k === 'periodScoresTeamB' || k === 'finalScoreTeamA' || k === 'finalScoreTeamB' || k === 'pointsPerColumn' || k === 'r2PeriodScoresTeamA' || k === 'r2PeriodScoresTeamB' || k === 'r3FinalScoreTeamA' || k === 'r3FinalScoreTeamB' || k === 'r3WinningTeamName' || k === 'playerScoringOverrides') continue;
    const isInt = INTEGER_KEYS.includes(k);
    const aliases = keyAliases[k] || [k];
    for (const key of aliases) {
      const v = parsed[key];
      if (v != null && v !== '') {
        if (isInt) {
          const n = parseInt(String(v), 10);
          out[k] = Number.isNaN(n) ? 0 : n;
        } else {
          const val = String(v).trim();
          if (!isKeyEcho(k, val)) out[k] = val;
        }
        break;
      }
    }
  }
  out.teamAPlayers = normalizePlayerArray(parsed.teamAPlayers || parsed.team_a_players);
  out.teamBPlayers = normalizePlayerArray(parsed.teamBPlayers || parsed.team_b_players);
  out.runningScoreEvents = normalizeRunningScoreEvents(parsed.runningScoreEvents || parsed.running_score_events || []);
  out.periodScoresTeamA = normalizePeriodScores(parsed.periodScoresTeamA || parsed.period_scores_team_a);
  out.periodScoresTeamB = normalizePeriodScores(parsed.periodScoresTeamB || parsed.period_scores_team_b);
  const finalA = parseInt(String(parsed.finalScoreTeamA ?? parsed.final_score_team_a ?? 0), 10);
  const finalB = parseInt(String(parsed.finalScoreTeamB ?? parsed.final_score_team_b ?? 0), 10);
  out.finalScoreTeamA = Number.isNaN(finalA) || finalA < 0 ? 0 : finalA;
  out.finalScoreTeamB = Number.isNaN(finalB) || finalB < 0 ? 0 : finalB;
  const ppc = parseInt(String(parsed.pointsPerColumn ?? parsed.points_per_column ?? 40), 10);
  out.pointsPerColumn = ppc === 60 ? 60 : 40;
  out.r2PeriodScoresTeamA = normalizePeriodScores(parsed.r2PeriodScoresTeamA || parsed.r2_period_scores_team_a);
  out.r2PeriodScoresTeamB = normalizePeriodScores(parsed.r2PeriodScoresTeamB || parsed.r2_period_scores_team_b);
  const r3A = parseInt(String(parsed.r3FinalScoreTeamA ?? parsed.r3_final_score_team_a ?? 0), 10);
  const r3B = parseInt(String(parsed.r3FinalScoreTeamB ?? parsed.r3_final_score_team_b ?? 0), 10);
  out.r3FinalScoreTeamA = Number.isNaN(r3A) || r3A < 0 ? 0 : r3A;
  out.r3FinalScoreTeamB = Number.isNaN(r3B) || r3B < 0 ? 0 : r3B;
  out.r3WinningTeamName = (parsed.r3WinningTeamName != null && String(parsed.r3WinningTeamName).trim() !== '') ? String(parsed.r3WinningTeamName).trim() : (parsed.r3_winning_team_name != null && String(parsed.r3_winning_team_name).trim() !== '') ? String(parsed.r3_winning_team_name).trim() : '';
  return out;
}

function getErrorMessage(err) {
  return String(err?.message || err?.toString?.() || '');
}

function parseRetryDelayMs(err) {
  const msg = getErrorMessage(err);
  const secondsMatch = msg.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)s/i);
  if (secondsMatch) {
    const sec = parseFloat(secondsMatch[1]);
    if (!Number.isNaN(sec) && sec > 0) return Math.ceil(sec * 1000);
  }
  const durationMatch = msg.match(/"retryDelay"\s*:\s*"([0-9]+)s"/i);
  if (durationMatch) {
    const sec = parseInt(durationMatch[1], 10);
    if (!Number.isNaN(sec) && sec > 0) return sec * 1000;
  }
  return null;
}

function isTransientGeminiError(err) {
  const msg = getErrorMessage(err);
  const is429 = /\b429\b/.test(msg) || /(too many requests|quota exceeded|rate limit)/i.test(msg);
  const is503 = /\b503\b/.test(msg) || /(service unavailable|high demand|overloaded|try again later)/i.test(msg);
  return is429 || is503;
}

function isModelUnavailableError(err) {
  const msg = getErrorMessage(err);
  return /\b404\b/.test(msg) && /(is not found|not supported for generatecontent)/i.test(msg);
}

function normalizeModelName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  return raw.replace(/^models\//i, '');
}

function getCandidateModels() {
  const primary = normalizeModelName(process.env.GEMINI_MODEL || 'gemini-2.5-flash');
  const envFallbacks = (process.env.GEMINI_MODEL_FALLBACKS || '')
    .split(',')
    .map((s) => normalizeModelName(s))
    .filter(Boolean);
  // Keep defaults to generally-available v1beta generateContent models.
  const defaults = ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-2.5-flash'];
  const ordered = [primary, ...envFallbacks, ...defaults];
  const seen = new Set();
  return ordered.filter((m) => {
    if (seen.has(m)) return false;
    seen.add(m);
    return true;
  });
}

async function extractWithGemini(filePath, originalName, multerMime) {
  const rawKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const apiKey = rawKey ? String(rawKey).trim().replace(/^["']|["']$/g, '') : '';
  if (!apiKey) throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) not set. Add it to your .env file and restart the server.');

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelNames = getCandidateModels();
  const seed = process.env.GEMINI_SEED != null ? parseInt(String(process.env.GEMINI_SEED), 10) : 42;
  const responseSchema = getExtractionResponseSchema();
  const useResponseSchema = /^1|true|yes$/i.test(String(process.env.GEMINI_RESPONSE_SCHEMA || '').trim());
  const maxOutParsed = parseInt(String(process.env.GEMINI_MAX_OUTPUT_TOKENS || '16384'), 10);
  const maxOutputTokens = Number.isNaN(maxOutParsed) ? 16384 : Math.min(65536, Math.max(2048, maxOutParsed));
  const generationConfig = {
    temperature: 0,
    topP: 0.2,
    topK: 1,
    seed: Number.isNaN(seed) ? 42 : seed,
    maxOutputTokens,
    responseMimeType: 'application/json'
  };
  if (responseSchema && useResponseSchema) {
    generationConfig.responseSchema = responseSchema;
  }
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString('base64');
  const mimeType = getMimeType(filePath, originalName, multerMime);

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function doExtract(model) {
    if (!MIME_TO_GEMINI[mimeType]) {
      const text = buffer.toString('utf8', 0, Math.min(buffer.length, 50000));
      const fullPrompt =
        getMinimalImagePrompt() +
        '\n\nThe scoresheet content may be plain text or OCR-like text below. Extract the full JSON described above from it.\n\n---\n' +
        text;
      const result = await model.generateContent(fullPrompt);
      const response = result.response;
      const raw = getGenerativeText(response).trim().replace(/^```json?\s*|\s*```$/g, '');
      const parsed = parseJsonFromResponse(raw);
      try { fs.writeFileSync(GEMINI_RESPONSE_FILE, JSON.stringify(parsed, null, 2), 'utf8'); } catch (e) {}
      const out = normalizeExtracted(parsed);
      const isEmpty = Object.keys(DEFAULT_DATA).every((k) => !out[k]);
      if (isEmpty && raw) console.warn('Gemini returned empty extraction (text). Raw:', raw.slice(0, 500));
      return out;
    }
    const textSent = getMinimalImagePrompt();
    const imagePart = { inlineData: { mimeType, data: base64 } };
    const result = await model.generateContent([textSent, imagePart]);
    const response = result.response;
    const raw = getGenerativeText(response).trim().replace(/^```json?\s*|\s*```$/g, '');
    const parsed = parseJsonFromResponse(raw);
    try { fs.writeFileSync(GEMINI_RESPONSE_FILE, JSON.stringify(parsed, null, 2), 'utf8'); } catch (e) {}
    const out = normalizeExtracted(parsed);
    const isEmpty = Object.keys(DEFAULT_DATA).every((k) => !out[k]);
    if (isEmpty && raw) console.warn('Gemini returned empty extraction. Raw response:', raw.slice(0, 500));
    return out;
  }

  const maxAttemptsPerModel = 2;
  let lastErr = null;
  for (let modelIdx = 0; modelIdx < modelNames.length; modelIdx++) {
    const modelName = modelNames[modelIdx];
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig
    });
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      try {
        if (modelIdx > 0 && attempt === 1) {
          console.warn(`Gemini fallback: trying model ${modelName}`);
        }
        return await doExtract(model);
      } catch (err) {
        lastErr = err;
        if (isModelUnavailableError(err)) {
          const hasAnotherModel = modelIdx < modelNames.length - 1;
          if (hasAnotherModel) break;
          throw err;
        }
        if (!isTransientGeminiError(err)) throw err;
        const isLastTryForModel = attempt === maxAttemptsPerModel;
        const hasAnotherModel = modelIdx < modelNames.length - 1;
        if (isLastTryForModel && hasAnotherModel) break;
        if (isLastTryForModel && !hasAnotherModel) throw err;
        const parsedDelay = parseRetryDelayMs(err);
        const backoffMs = Math.min(120000, Math.round(5000 * Math.pow(2, attempt - 1)));
        const waitMs = parsedDelay != null ? Math.min(parsedDelay + 500, 120000) : backoffMs;
        await delay(waitMs);
      }
    }
  }
  throw lastErr || new Error('Gemini extraction failed across all configured models.');
}

app.use(express.json({ limit: '1mb' }));

// Explicit routes so Vercel/serverless serves HTML (static may not see project root)
const sendHtml = (filename, req, res) => {
  const dir = IS_VERCEL ? process.cwd() : __dirname;
  const p = path.join(dir, filename);
  if (fs.existsSync(p)) return res.sendFile(p);
  const fallback = path.join(IS_VERCEL ? __dirname : process.cwd(), filename);
  res.sendFile(fallback, (err) => {
    if (err) res.status(404).send('Not found');
  });
};
app.get('/', (req, res) => sendHtml('index.html', req, res));
app.get('/index.html', (req, res) => sendHtml('index.html', req, res));
app.get('/review.html', (req, res) => sendHtml('review.html', req, res));
const demoPath = path.join(__dirname, 'assets', 'demo-scoresheet.png');
app.get('/assets/demo-scoresheet.png', (req, res) => {
  const p = fs.existsSync(demoPath) ? demoPath : path.join(process.cwd(), 'assets', 'demo-scoresheet.png');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(404).send('Not found');
});
app.use(express.static(__dirname));

app.get('/api/data', (req, res) => {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8').trim();
    if (!raw) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf8');
      return res.json(DEFAULT_DATA);
    }
    const data = JSON.parse(raw);
    if (data.$schema) return res.json(DEFAULT_DATA);
    const merged = { ...DEFAULT_DATA, ...data };
    res.json(merged);
  } catch (err) {
    if (err.code === 'ENOENT') {
      fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf8');
      return res.json(DEFAULT_DATA);
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/data', (req, res) => {
  try {
    const body = req.body || {};
    const data = { ...DEFAULT_DATA };
    for (const k of Object.keys(DEFAULT_DATA)) {
      if (body[k] == null) continue;
      if (k === 'teamAPlayers' || k === 'teamBPlayers') {
        data[k] = Array.isArray(body[k]) ? body[k].slice(0, MAX_PLAYERS_PER_TEAM).map(normalizePlayer) : [];
      } else if (k === 'runningScoreEvents') {
        data[k] = normalizeRunningScoreEvents(body[k] || []);
      } else if (k === 'periodScoresTeamA' || k === 'periodScoresTeamB') {
        data[k] = normalizePeriodScores(body[k]);
      } else if (k === 'finalScoreTeamA' || k === 'finalScoreTeamB') {
        const n = parseInt(String(body[k]), 10);
        data[k] = Number.isNaN(n) || n < 0 ? 0 : n;
      } else if (k === 'pointsPerColumn') {
        const n = parseInt(String(body[k]), 10);
        data[k] = n === 60 ? 60 : 40;
      } else if (k === 'r2PeriodScoresTeamA' || k === 'r2PeriodScoresTeamB') {
        data[k] = normalizePeriodScores(body[k]);
      } else if (k === 'r3FinalScoreTeamA' || k === 'r3FinalScoreTeamB') {
        const n = parseInt(String(body[k]), 10);
        data[k] = Number.isNaN(n) || n < 0 ? 0 : n;
      } else if (k === 'r3WinningTeamName') {
        data[k] = (body[k] != null ? String(body[k]) : '').trim();
      } else if (k === 'playerScoringOverrides') {
        data[k] = normalizePlayerScoringOverrides(body[k]);
      } else if (INTEGER_KEYS.includes(k)) {
        const n = parseInt(String(body[k]), 10);
        data[k] = Number.isNaN(n) ? 0 : n;
      } else {
        data[k] = String(body[k]);
      }
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload', upload.single('scoresheet'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filePath = req.file.path;
    const originalName = req.file.originalname || '';
    let extracted = null;
    try {
      extracted = await extractWithGemini(filePath, originalName, req.file.mimetype);
      fs.writeFileSync(DATA_FILE, JSON.stringify(extracted, null, 2), 'utf8');
    } catch (geminiErr) {
      const msg = geminiErr?.message || geminiErr?.toString?.() || 'Extraction failed';
      console.error('Gemini extraction error:', msg);
      const isTemporaryGemini503 =
        /\b503\b/.test(msg) &&
        /(service unavailable|high demand|try again later)/i.test(msg);
      const isGeminiQuota429 =
        /\b429\b/.test(msg) &&
        /(too many requests|quota exceeded|rate limit|retry in)/i.test(msg);
      const retryDelayMs = parseRetryDelayMs(geminiErr);
      const userMessage = isTemporaryGemini503
        ? 'Temporary service issue (503). The AI extraction service is currently overloaded. Please retry in 1-2 minutes. If this keeps happening, try a smaller file or try again later.'
        : isGeminiQuota429
        ? `Gemini API quota/rate limit reached (429).${retryDelayMs ? ` Please retry in about ${Math.max(1, Math.ceil(retryDelayMs / 1000))} seconds.` : ' Please retry in about a minute or use a new API key/project with available quota.'}`
        : msg;
      return res.status(500).json({
        error: userMessage,
        uploaded: true,
        filename: originalName
      });
    }

    res.json({
      ok: true,
      filename: originalName,
      path: req.file.filename,
      extracted: true,
      data: extracted
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (!IS_VERCEL) {
  app.listen(PORT, () => {
    const keySet = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
    console.log(`Server at http://localhost:${PORT}`);
    console.log('Gemini API key:', keySet ? 'set' : 'NOT SET (set GEMINI_API_KEY in .env)');
  });
}

module.exports = app;
