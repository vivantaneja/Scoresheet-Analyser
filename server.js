const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '.env'),
  override: true
});
const express = require('express');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = !!process.env.VERCEL;
const WORK_DIR = IS_VERCEL ? '/tmp' : __dirname;
const DATA_FILE = path.join(WORK_DIR, 'data.json');
const EXTRACTION_DEBUG_FILE = path.join(WORK_DIR, 'last-extraction.json');
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

/** Groq vision chat API: raster images only (no PDF). */
const MIME_TO_CHAT_VISION = {
  'image/jpeg': true,
  'image/png': true,
  'image/gif': true,
  'image/webp': true
};

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_DEFAULT_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

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
  if (m && MIME_TO_CHAT_VISION[m]) return m;
  return 'application/octet-stream';
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

/** Map model output to A/B (L1=L2 roster labels and numeric variants). */
function normalizeRunningScoreTeam(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'number') {
    if (raw === 1) return 'A';
    if (raw === 2) return 'B';
  }
  const s = String(raw).trim().toUpperCase();
  if (s === 'A' || s === 'B') return s;
  if (s === '1' || s === 'L1' || s === 'LINE 1' || s === 'LINE1') return 'A';
  if (s === '2' || s === 'L2' || s === 'LINE 2' || s === 'LINE2') return 'B';
  if (s === 'LEFT') return 'A';
  if (s === 'RIGHT') return 'B';
  if (s === 'TEAM A' || s === 'TEAMA' || s === 'TEAM-A' || s === 'TEAM_A') return 'A';
  if (s === 'TEAM B' || s === 'TEAMB' || s === 'TEAM-B' || s === 'TEAM_B') return 'B';
  const n = parseInt(s, 10);
  if (n === 1) return 'A';
  if (n === 2) return 'B';
  return '';
}

const POINT_VALUE = { '1': 1, '2': 2, '3': 3 };

/** When the model assigns every basket to one team but finals need both teams, split events using final scores (subset-sum on 1/2/3 pt values). */
function repartitionRunningEventsByFinals(events, finalA, finalB) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const fa = Math.max(0, parseInt(String(finalA), 10) || 0);
  const fb = Math.max(0, parseInt(String(finalB), 10) || 0);
  if (fa + fb === 0) return events;
  const pts = (e) => POINT_VALUE[String(e.type)] || 0;
  const sorted = [...events].sort((a, b) => a.point - b.point);
  const vs = sorted.map(pts);
  const total = vs.reduce((a, b) => a + b, 0);
  if (total !== fa + fb) return events;

  const allA = sorted.every((e) => e.team === 'A');
  const allB = sorted.every((e) => e.team === 'B');
  if (!allA && !allB) return events;
  if (allA && fb === 0) return events;
  if (allB && fa === 0) return events;

  function subsetSumMaskForTeamA(targetForA) {
    const n = vs.length;
    const t = targetForA;
    if (t < 0 || t > total) return null;
    const dp = Array.from({ length: n + 1 }, () => new Array(t + 1).fill(false));
    dp[0][0] = true;
    for (let i = 0; i < n; i++) {
      for (let s = 0; s <= t; s++) {
        if (!dp[i][s]) continue;
        dp[i + 1][s] = true;
        const ns = s + vs[i];
        if (ns <= t) dp[i + 1][ns] = true;
      }
    }
    if (!dp[n][targetForA]) return null;
    let s = targetForA;
    const inA = new Array(n).fill(false);
    for (let i = n; i >= 1; i--) {
      if (dp[i - 1][s]) {
        continue;
      }
      if (s >= vs[i - 1] && dp[i - 1][s - vs[i - 1]]) {
        inA[i - 1] = true;
        s -= vs[i - 1];
      } else {
        return null;
      }
    }
    return s === 0 ? inA : null;
  }

  const inA = subsetSumMaskForTeamA(fa);
  if (!inA) return events;
  return sorted.map((e, i) => ({ ...e, team: inA[i] ? 'A' : 'B' }));
}

function normalizeRunningScoreEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const point = parseInt(String(e.point), 10);
  const team = normalizeRunningScoreTeam(e.team);
  let type =
    typeof e.type === 'number' && e.type >= 1 && e.type <= 3
      ? String(Math.trunc(e.type))
      : String(e.type != null ? e.type : '').trim();
  if (type !== '1' && type !== '2' && type !== '3') {
    const tn = parseInt(type, 10);
    if (!Number.isNaN(tn) && tn >= 1 && tn <= 3) type = String(tn);
  }
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
  out.runningScoreEvents = repartitionRunningEventsByFinals(out.runningScoreEvents, out.finalScoreTeamA, out.finalScoreTeamB);
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

/**
 * OpenAI-compatible chat.completions with one user message (text + image data URL). Groq.
 */
async function extractWithChatCompletionsVision(filePath, originalName, multerMime, options) {
  const { url, apiKey, model, extraHeaders = {} } = options;
  const mimeType = getMimeType(filePath, originalName, multerMime);
  if (!MIME_TO_CHAT_VISION[mimeType]) {
    throw new Error(
      `Extraction supports images only (${Object.keys(MIME_TO_CHAT_VISION).join(', ')}), not ${mimeType}. Export the scoresheet as JPEG or PNG and retry.`
    );
  }

  const buffer = fs.readFileSync(filePath);
  const b64 = buffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${b64}`;
  if (Buffer.byteLength(dataUrl, 'utf8') > 3.5 * 1024 * 1024) {
    throw new Error(
      'Image is too large as a base64 data URL (~4MB API limit for Groq). Export a smaller JPEG/PNG (e.g. under 2.5MB file size) and retry.'
    );
  }

  const userText =
    getMinimalImagePrompt() +
    '\n\nYou must respond with a single JSON object only (no markdown code fences).';

  const maxTok = parseInt(String(process.env.CHAT_VISION_MAX_TOKENS || '8192'), 10);
  const maxCompletionTokens = Number.isNaN(maxTok) ? 8192 : Math.min(16384, Math.max(1024, maxTok));

  const body = {
    model,
    temperature: 0,
    max_completion_tokens: maxCompletionTokens,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ]
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });

  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`Vision chat API HTTP ${res.status}: ${rawText.slice(0, 800)}`);
  }
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Vision chat API returned invalid JSON body: ${rawText.slice(0, 300)}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (content == null || typeof content !== 'string') {
    throw new Error('Vision chat API returned no message content.');
  }
  const parsed = parseJsonFromResponse(content.trim().replace(/^```json?\s*|\s*```$/g, ''));
  try {
    fs.writeFileSync(EXTRACTION_DEBUG_FILE, JSON.stringify(parsed, null, 2), 'utf8');
  } catch (e) {}
  return normalizeExtracted(parsed);
}

async function extractWithGroq(filePath, originalName, multerMime) {
  const apiKey = String(process.env.GROQ_API_KEY || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!apiKey) {
    throw new Error(
      'GROQ_API_KEY not set. Create a free key at https://console.groq.com/keys and add it to .env, then restart the server.'
    );
  }
  const model = (process.env.GROQ_MODEL || GROQ_DEFAULT_VISION_MODEL).trim();
  return extractWithChatCompletionsVision(filePath, originalName, multerMime, {
    url: GROQ_CHAT_COMPLETIONS_URL,
    apiKey,
    model
  });
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

function unlinkUploadSilently(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {}
}

app.post('/api/upload', upload.single('scoresheet'), async (req, res) => {
  const filePath = req.file && req.file.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const originalName = req.file.originalname || '';
    let extracted = null;
    try {
      extracted = await extractWithGroq(filePath, originalName, req.file.mimetype);
      fs.writeFileSync(DATA_FILE, JSON.stringify(extracted, null, 2), 'utf8');
    } catch (extractErr) {
      unlinkUploadSilently(filePath);
      const msg = extractErr?.message || extractErr?.toString?.() || 'Extraction failed';
      console.error('Extraction error:', msg);
      const isTemporary503 =
        /\b503\b/.test(msg) &&
        /(service unavailable|high demand|try again later|overloaded)/i.test(msg);
      const isQuota429 =
        /\b429\b/.test(msg) &&
        /(too many requests|quota exceeded|rate limit|retry in)/i.test(msg);
      const retryDelayMs = parseRetryDelayMs(extractErr);
      const userMessage = isTemporary503
        ? 'Temporary service issue (503). Please retry in 1-2 minutes or try a smaller image.'
        : isQuota429
        ? `Rate limit (429).${retryDelayMs ? ` Retry in about ${Math.max(1, Math.ceil(retryDelayMs / 1000))} seconds.` : ' Retry in a minute or check your Groq console.'}`
        : msg;
      return res.status(500).json({
        error: userMessage,
        uploaded: true,
        filename: originalName
      });
    }

    unlinkUploadSilently(filePath);
    res.json({
      ok: true,
      filename: originalName,
      path: req.file.filename,
      extracted: true,
      data: extracted
    });
  } catch (err) {
    unlinkUploadSilently(filePath);
    res.status(500).json({ error: err.message });
  }
});

if (!IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server at http://localhost:${PORT}`);
    console.log('Extraction: Groq (vision + JSON)');
    console.log('GROQ_API_KEY:', process.env.GROQ_API_KEY ? 'set' : 'NOT SET');
    console.log('GROQ_MODEL:', (process.env.GROQ_MODEL || GROQ_DEFAULT_VISION_MODEL).trim());
  });
}

module.exports = app;
