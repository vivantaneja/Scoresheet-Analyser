const path = require('path');
const os = require('os');
const crypto = require('crypto');
require('dotenv').config({
  path: path.join(__dirname, '.env'),
  override: true
});
const express = require('express');
const fs = require('fs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
/** Bind to all interfaces so other devices on the same Wi‑Fi can reach the dev server. Set HOST=127.0.0.1 to disable. */
const HOST = process.env.HOST || '0.0.0.0';

function getLanIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const fam = net.family;
      if ((fam === 'IPv4' || fam === 4) && !net.internal) return net.address;
    }
  }
  return null;
}
const IS_VERCEL = !!process.env.VERCEL;
const WORK_DIR = IS_VERCEL ? '/tmp' : __dirname;
/** Per-user JSON files when not using Redis. On Vercel, only /tmp is writable  -  not __dirname. */
const USER_DATA_DIR = path.join(WORK_DIR, '.user-data');
const EXTRACTION_DEBUG_FILE = path.join(WORK_DIR, 'last-extraction.json');
const SCHEMA_FILE = path.join(__dirname, 'schema.json');
const SCHEMA_FILE_FIBA = path.join(__dirname, 'schema-fiba.json');
const PROMPT_FILE = path.join(__dirname, 'extraction-prompt.txt');
const PROMPT_FILE_FIBA = path.join(__dirname, 'extraction-prompt-fiba.txt');
const UPLOAD_DIR = path.join(WORK_DIR, 'uploads');

const DEFAULT_EXTRACTION_PROMPT = 'Extract basketball match header information and return a JSON object with keys: teamAName, teamBName, competitionName, date (YYYY-MM-DD), time (HH:MM), place, referee1, referee2. Use empty string if not found. Return only the JSON.';

const INTEGER_KEYS = [
  'teamATimeoutsFirstHalf', 'teamATimeoutsSecondHalf', 'teamATimeoutsExtraPeriods',
  'teamAFoulsPeriod1', 'teamAFoulsPeriod2', 'teamAFoulsPeriod3', 'teamAFoulsPeriod4',
  'teamBTimeoutsFirstHalf', 'teamBTimeoutsSecondHalf', 'teamBTimeoutsExtraPeriods',
  'teamBFoulsPeriod1', 'teamBFoulsPeriod2', 'teamBFoulsPeriod3', 'teamBFoulsPeriod4',
  'r2ExtraPeriodPointsTeamA',
  'r2ExtraPeriodPointsTeamB'
];

/** FIBA: four 40-point blocks (plays 1–160). Basketball Ireland sheets often use three blocks (1–120). */
const R1_MAX_SCORING_PLAY = 160;

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
  teamAColour: '',
  teamBColour: '',
  teamACoachName: '',
  teamACoachBipin: '',
  teamAAssistantCoachName: '',
  teamBCoachName: '',
  teamBCoachBipin: '',
  teamBAssistantCoachName: '',
  l3Officials: [],
  gameNumber: '',
  umpire2Name: '',
  assistantScorekeeperName: '',
  r2ExtraPeriodPointsTeamA: 0,
  r2ExtraPeriodPointsTeamB: 0,
  playerScoringOverrides: { A: {}, B: {} },
  /** Set at extraction time: `ireland` (Basketball Ireland / domestic) or `fiba` (international layout). */
  sheetVariant: 'ireland'
};

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });

if (!fs.existsSync(PROMPT_FILE)) {
  console.warn(
    'extraction-prompt.txt not found next to server.js; using built-in header-only prompt. Full scoresheet extraction will look empty. Ensure extraction-prompt.txt is deployed (e.g. Vercel includeFiles).'
  );
}
if (!fs.existsSync(PROMPT_FILE_FIBA)) {
  console.warn('extraction-prompt-fiba.txt missing  -  FIBA uploads will fall back to Ireland prompt until the file exists.');
}
if (!fs.existsSync(SCHEMA_FILE_FIBA)) {
  console.warn('schema-fiba.json missing  -  FIBA uploads will fall back to schema.json until the file exists.');
}

/** User-chosen layout: Ireland (default) vs FIBA international. Selects prompt + JSON schema files. */
function resolveSheetVariant(input) {
  const s = String(input ?? '')
    .trim()
    .toLowerCase();
  if (s === 'fiba' || s === 'international') return 'fiba';
  return 'ireland';
}

function getSheetPromptAndSchemaPaths(sheetVariant) {
  const v = resolveSheetVariant(sheetVariant);
  if (v === 'fiba') {
    const hasPrompt = fs.existsSync(PROMPT_FILE_FIBA);
    const hasSchema = fs.existsSync(SCHEMA_FILE_FIBA);
    if (!hasPrompt) {
      console.warn('extraction-prompt-fiba.txt missing; using Ireland prompt (extraction-prompt.txt).');
    }
    if (!hasSchema) {
      console.warn('schema-fiba.json missing; using schema.json.');
    }
    return {
      variant: 'fiba',
      promptPath: hasPrompt ? PROMPT_FILE_FIBA : PROMPT_FILE,
      schemaPath: hasSchema ? SCHEMA_FILE_FIBA : SCHEMA_FILE
    };
  }
  return { variant: 'ireland', promptPath: PROMPT_FILE, schemaPath: SCHEMA_FILE };
}

function parsePositiveMbEnv(name, fallbackMb) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallbackMb;
  const n = parseFloat(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : fallbackMb;
}

/** Vercel serverless: entire HTTP request body is ~4.5MB max (multipart includes boundaries). */
const VERCEL_REQUEST_BODY_CAP_BYTES = Math.floor(4.5 * 1024 * 1024);
/** Default upload cap: conservative on Vercel; larger on self-hosted. Override with UPLOAD_MAX_FILE_MB. */
const UPLOAD_MAX_FILE_MB = parsePositiveMbEnv('UPLOAD_MAX_FILE_MB', IS_VERCEL ? 4 : 20);
let UPLOAD_MAX_FILE_BYTES = Math.floor(UPLOAD_MAX_FILE_MB * 1024 * 1024);
if (IS_VERCEL) {
  const cap = VERCEL_REQUEST_BODY_CAP_BYTES - 256 * 1024;
  if (UPLOAD_MAX_FILE_BYTES > cap) {
    console.warn(
      `UPLOAD_MAX_FILE_MB: Vercel request body ~4.5MB max  -  capping file size to ${(cap / (1024 * 1024)).toFixed(2)} MB (use Docker/VPS or direct-to-storage upload for larger files).`
    );
    UPLOAD_MAX_FILE_BYTES = cap;
  }
} else {
  UPLOAD_MAX_FILE_BYTES = Math.min(UPLOAD_MAX_FILE_BYTES, 100 * 1024 * 1024);
}

/** Base64 data URL sent to the vision API. ~33% larger than raw file bytes. */
const VISION_MAX_DATA_URL_MB = parsePositiveMbEnv('VISION_MAX_DATA_URL_MB', 3.5);
const VISION_MAX_DATA_URL_BYTES = Math.floor(VISION_MAX_DATA_URL_MB * 1024 * 1024);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + (file.originalname || 'scoresheet').replace(/[^a-zA-Z0-9._-]/g, '_'))
  }),
  limits: { fileSize: UPLOAD_MAX_FILE_BYTES }
});

/** Vision chat API: raster images only (no PDF). */
const MIME_TO_CHAT_VISION = {
  'image/jpeg': true,
  'image/png': true,
  'image/gif': true,
  'image/webp': true
};

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_DEFAULT_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

/**
 * Upper bound for `max_completion_tokens` (Groq often documents 8192; some models allow more).
 * Override with GROQ_MAX_COMPLETION_TOKENS_CAP if the provider supports a higher ceiling.
 */
function getGroqMaxCompletionTokensCap() {
  const raw = process.env.GROQ_MAX_COMPLETION_TOKENS_CAP;
  if (raw == null || String(raw).trim() === '') return 8192;
  const n = parseInt(String(raw).trim(), 10);
  if (Number.isNaN(n)) return 8192;
  return Math.min(16384, Math.max(256, n));
}
/**
 * Default completion budget for full-sheet JSON (rosters + many runningScoreEvents).
 * With `response_format: json_object`, truncated output fails with json_validate_failed  -  prefer headroom.
 * If a model rejects max output, set CHAT_VISION_MAX_TOKENS lower (e.g. 4096).
 */
const GROQ_DEFAULT_COMPLETION_TOKENS = 8192;

function groqMaxCompletionTokensFromEnv() {
  const cap = getGroqMaxCompletionTokensCap();
  const raw = process.env.CHAT_VISION_MAX_TOKENS;
  if (raw == null || String(raw).trim() === '') {
    return Math.min(cap, GROQ_DEFAULT_COMPLETION_TOKENS);
  }
  const n = parseInt(String(raw).trim(), 10);
  if (Number.isNaN(n)) {
    return Math.min(cap, GROQ_DEFAULT_COMPLETION_TOKENS);
  }
  return Math.min(cap, Math.max(256, n));
}

/** JSON mode requires a complete JSON object; hitting max_completion_tokens mid-stream yields json_validate_failed. */
function isGroqJsonOutputTruncation(rawText) {
  const s = String(rawText || '');
  return (
    /json_validate_failed/i.test(s) &&
    /max completion tokens reached|failed_generation|valid document/i.test(s)
  );
}

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

/**
 * @param {string} [sheetVariant] - `ireland` (default) or `fiba`  -  uses `extraction-prompt.txt`+`schema.json` vs `extraction-prompt-fiba.txt`+`schema-fiba.json`.
 */
function getMinimalImagePrompt(sheetVariant) {
  const { promptPath, schemaPath } = getSheetPromptAndSchemaPaths(sheetVariant);
  let prompt = DEFAULT_EXTRACTION_PROMPT;
  try {
    if (fs.existsSync(promptPath)) {
      prompt = fs.readFileSync(promptPath, 'utf8').trim();
    }
  } catch (e) {}
  let schemaBlock = '';
  try {
    schemaBlock = '\n\nSchema:\n' + fs.readFileSync(schemaPath, 'utf8').trim();
  } catch (e) {}
  const fibaFlatJsonNote =
    resolveSheetVariant(sheetVariant) === 'fiba'
      ? '\n\nFIBA  -  flat JSON: **teamAPlayers**, **teamBPlayers**, and **runningScoreEvents** must be **root-level arrays** in your JSON. Never nest them under keys named L1, L2, R1, or similar (those are layout labels on the sheet only).'
      : '';
  return (
    prompt +
    schemaBlock +
    '\n\nReturn a single JSON object matching the schema. Use empty string "" for any value not visible. No other text.' +
    '\n\nInclude every top-level key from the schema in your JSON. Use [] only for teamAPlayers, teamBPlayers, or runningScoreEvents when those sections are missing or unreadable; if you can read marks or rows, you must populate them. Use 0 for numeric fields only when the value is not shown on the sheet.' +
    '\n\nRosters: teamAPlayers and teamBPlayers must include every visible player row in each printed table (often 12 per team on FIBA), not only the first two. When building JSON, output teamAPlayers and teamBPlayers before runningScoreEvents if possible.' +
    fibaFlatJsonNote
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

/** Vision models often emit snake_case or alternate names; map them into our schema. */
const PLAYER_FIELD_ALIASES = {
  bipinNo: [
    'bipinNo',
    'bipin_no',
    'bipin',
    'pin',
    'BIPIN',
    'licenceNo',
    'licence_no',
    'licenseNo',
    'license_no'
  ],
  playerInQuarter1: ['playerInQuarter1', 'player_in_quarter_1', 'in_q1', 'q1'],
  playerInQuarter2: ['playerInQuarter2', 'player_in_quarter_2', 'in_q2', 'q2'],
  playerInQuarter3: ['playerInQuarter3', 'player_in_quarter_3', 'in_q3', 'q3'],
  playerInQuarter4: ['playerInQuarter4', 'player_in_quarter_4', 'in_q4', 'q4'],
  playerName: ['playerName', 'player_name', 'name', 'player'],
  kitNo: [
    'kitNo',
    'kit_no',
    'kitNumber',
    'kit_number',
    'jersey',
    'jerseyNumber',
    'jersey_number',
    'jerseyNo',
    'jersey_no',
    'shirtNo',
    'shirt_no',
    'number',
    'playerNumber',
    'player_no',
    'no'
  ],
  foul1: ['foul1', 'foul_1'],
  foul2: ['foul2', 'foul_2'],
  foul3: ['foul3', 'foul_3'],
  foul4: ['foul4', 'foul_4'],
  foul5: ['foul5', 'foul_5']
};

function defaultPlayer() {
  const o = {};
  PLAYER_KEYS.forEach((k) => (o[k] = ''));
  return o;
}

function pickPlayerField(p, canonicalKey) {
  const aliases = PLAYER_FIELD_ALIASES[canonicalKey] || [canonicalKey];
  for (const ak of aliases) {
    if (!Object.prototype.hasOwnProperty.call(p, ak)) continue;
    const v = p[ak];
    if (v == null) continue;
    const s = String(v).trim();
    if (s !== '') return s;
  }
  return null;
}

function normalizePlayer(p) {
  const d = defaultPlayer();
  if (!p || typeof p !== 'object') return d;
  PLAYER_KEYS.forEach((k) => {
    const v = pickPlayerField(p, k);
    if (v != null) d[k] = v;
  });
  return d;
}

const MAX_PLAYERS_PER_TEAM = 12;

function normalizePlayerArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, MAX_PLAYERS_PER_TEAM).map(normalizePlayer);
}

function normalizeL3OfficialsArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 10).map((o) => {
    if (!o || typeof o !== 'object') return { role: '', bipinNo: '', name: '', initials: '' };
    return {
      role: String(o.role ?? '').trim(),
      bipinNo: String(o.bipinNo ?? o.bipin_no ?? '').trim(),
      name: String(o.name ?? '').trim(),
      initials: String(o.initials ?? '').trim()
    };
  });
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
  if (s === 'HOME' || s === 'H') return 'A';
  if (s === 'AWAY' || s === 'VISITOR' || s === 'VISITORS') return 'B';
  const n = parseInt(s, 10);
  if (n === 1) return 'A';
  if (n === 2) return 'B';
  return '';
}

const POINT_VALUE = { '1': 1, '2': 2, '3': 3 };

function sumRunningEventPoints(events) {
  let teamA = 0;
  let teamB = 0;
  if (!Array.isArray(events)) return { teamA, teamB };
  for (const e of events) {
    const v = POINT_VALUE[String(e.type)] || 0;
    if (e.team === 'A') teamA += v;
    else if (e.team === 'B') teamB += v;
  }
  return { teamA, teamB };
}

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

/**
 * Vision models often label every field goal as type "1". If every event for a team shares one type
 * and printed final equals a uniform multiple (all 1s but final = 2×count, etc.), adjust types in lockstep.
 */
function recalibrateUniformBasketTypes(events, finalA, finalB) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const fa = Math.max(0, parseInt(String(finalA), 10) || 0);
  const fb = Math.max(0, parseInt(String(finalB), 10) || 0);
  const out = events.map((e) => ({ ...e }));

  function applyUniform(teamKey, finalT) {
    if (finalT <= 0) return;
    const idx = [];
    for (let i = 0; i < out.length; i++) {
      if (out[i].team === teamKey) idx.push(i);
    }
    if (idx.length === 0) return;
    const t0 = String(out[idx[0]].type);
    if (!idx.every((i) => String(out[i].type) === t0)) return;
    const n = idx.length;
    const sumNow = idx.reduce((s, i) => s + (POINT_VALUE[String(out[i].type)] || 0), 0);
    if (sumNow === finalT) return;

    if (t0 === '1' && n * 2 === finalT) {
      idx.forEach((i) => {
        out[i] = { ...out[i], type: '2' };
      });
      return;
    }
    if (t0 === '1' && n * 3 === finalT) {
      idx.forEach((i) => {
        out[i] = { ...out[i], type: '3' };
      });
      return;
    }
    if (t0 === '2' && sumNow === n * 2 && finalT === n) {
      idx.forEach((i) => {
        out[i] = { ...out[i], type: '1' };
      });
    }
  }

  applyUniform('A', fa);
  applyUniform('B', fb);
  return out;
}

function mapVisionShotTypeToSchema(typeRaw) {
  const s = String(typeRaw != null ? typeRaw : '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
  if (s === '1' || s === 'FT' || s === 'FREE_THROW' || s === 'FREE' || s === '1PT') return '1';
  if (s === '2' || s === '2PT' || s === '2PM' || s === 'FG' || s === 'FG2' || s === 'TWO') return '2';
  if (s === '3' || s === '3PT' || s === '3PM' || s === 'FG3' || s === 'THREE') return '3';
  return '';
}

function normalizeRunningScoreEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const pointRaw =
    e.point ?? e.score ?? e.playNumber ?? e.order ?? e.seq ?? e.n ?? e.play ?? e.index ?? e.i;
  const point = parseInt(String(pointRaw), 10);
  const team = normalizeRunningScoreTeam(e.team != null ? e.team : e.side);
  let type =
    typeof e.type === 'number' && e.type >= 1 && e.type <= 3
      ? String(Math.trunc(e.type))
      : String(e.type != null ? e.type : '').trim();
  if (type !== '1' && type !== '2' && type !== '3') {
    const tn = parseInt(type, 10);
    if (!Number.isNaN(tn) && tn >= 1 && tn <= 3) type = String(tn);
  }
  if (type !== '1' && type !== '2' && type !== '3') {
    const mapped = mapVisionShotTypeToSchema(e.type);
    if (mapped) type = mapped;
  }
  let jersey = '';
  for (const k of [
    'jersey',
    'jersey_number',
    'jerseyNumber',
    'kit_no',
    'kitNo',
    'player',
    'playerNo',
    'player_no',
    'shirt',
    'scorer',
    'number',
    'no',
    'kit'
  ]) {
    if (e[k] == null) continue;
    const s = String(e[k]).trim();
    if (s !== '') {
      jersey = s;
      break;
    }
  }
  if (/^\d+$/.test(jersey)) jersey = String(parseInt(jersey, 10));
  if (Number.isNaN(point) || point < 1 || point > R1_MAX_SCORING_PLAY) return null;
  if (team !== 'A' && team !== 'B') return null;
  if (type !== '1' && type !== '2' && type !== '3') return null;
  return { point, team, type, jersey };
}

function normalizeRunningScoreEvents(arr) {
  if (!Array.isArray(arr)) return [];
  const raw = arr.map(normalizeRunningScoreEvent).filter(Boolean);
  if (raw.length === 0) return [];
  const dupKey = (e) => `${e.point}-${e.team}`;
  const seenDup = new Set();
  let hasDup = false;
  for (const e of raw) {
    if (seenDup.has(dupKey(e))) {
      hasDup = true;
      break;
    }
    seenDup.add(dupKey(e));
  }
  /** Models often label each R1 block 1–40; duplicate (point, team) would drop most baskets without this. */
  const working = hasDup ? raw.map((e, i) => ({ ...e, point: i + 1 })) : raw;
  const seen = new Set();
  return working
    .filter((e) => {
      const key = dupKey(e);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.point - b.point);
}

function normalizePeriodScores(arr) {
  if (!Array.isArray(arr)) return [0, 0, 0, 0];
  return [0, 1, 2, 3].map((i) => {
    const n = parseInt(String(arr[i]), 10);
    return Number.isNaN(n) || n < 0 ? 0 : n;
  });
}

function normalizeCumulativeArray(arr, maxLen = R1_MAX_SCORING_PLAY) {
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

/**
 * Vision models sometimes nest rosters under L1/L2 or running score under R1 despite a flat schema.
 */
function pickTeamPlayersArrayFromParsed(parsed, team) {
  if (!parsed || typeof parsed !== 'object') return [];
  const camel = team === 'A' ? 'teamAPlayers' : 'teamBPlayers';
  const snake = team === 'A' ? 'team_a_players' : 'team_b_players';
  if (Array.isArray(parsed[camel])) return parsed[camel];
  if (Array.isArray(parsed[snake])) return parsed[snake];
  if (team === 'A') {
    if (Array.isArray(parsed.homePlayers)) return parsed.homePlayers;
    if (parsed.L1 && Array.isArray(parsed.L1.players)) return parsed.L1.players;
    if (parsed.l1 && Array.isArray(parsed.l1.players)) return parsed.l1.players;
    if (parsed.teamA && Array.isArray(parsed.teamA.players)) return parsed.teamA.players;
  } else {
    if (Array.isArray(parsed.awayPlayers)) return parsed.awayPlayers;
    if (parsed.L2 && Array.isArray(parsed.L2.players)) return parsed.L2.players;
    if (parsed.l2 && Array.isArray(parsed.l2.players)) return parsed.l2.players;
    if (parsed.teamB && Array.isArray(parsed.teamB.players)) return parsed.teamB.players;
  }
  return [];
}

function pickRunningScoreEventsFromParsed(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  if (Array.isArray(parsed.runningScoreEvents)) return parsed.runningScoreEvents;
  if (Array.isArray(parsed.running_score_events)) return parsed.running_score_events;
  if (Array.isArray(parsed.r1Events)) return parsed.r1Events;
  if (Array.isArray(parsed.runningScore)) return parsed.runningScore;
  if (Array.isArray(parsed.baskets)) return parsed.baskets;
  if (Array.isArray(parsed.scoringEvents)) return parsed.scoringEvents;
  if (Array.isArray(parsed.scoringPlays)) return parsed.scoringPlays;
  if (Array.isArray(parsed.playByPlay)) return parsed.playByPlay;
  if (Array.isArray(parsed.plays)) return parsed.plays;
  if (parsed.scoring && Array.isArray(parsed.scoring.events)) return parsed.scoring.events;
  if (parsed.scoring && Array.isArray(parsed.scoring.plays)) return parsed.scoring.plays;
  if (parsed.R1 && Array.isArray(parsed.R1.events)) return parsed.R1.events;
  if (parsed.r1 && Array.isArray(parsed.r1.events)) return parsed.r1.events;
  if (parsed.R1 && Array.isArray(parsed.R1.runningScoreEvents)) return parsed.R1.runningScoreEvents;
  if (parsed.r1 && Array.isArray(parsed.r1.runningScoreEvents)) return parsed.r1.runningScoreEvents;
  if (parsed.runningScore && Array.isArray(parsed.runningScore.events)) return parsed.runningScore.events;
  if (Array.isArray(parsed.r1)) return parsed.r1;
  if (Array.isArray(parsed.R1)) return parsed.R1;
  return [];
}

function normalizeExtracted(parsed, sheetVariant) {
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
    teamBFoulsPeriod4: ['teamBFoulsPeriod4', 'team_b_fouls_period_4'],
    teamAColour: ['teamAColour', 'team_a_colour', 'teamAColor', 'team_a_color'],
    teamBColour: ['teamBColour', 'team_b_colour', 'teamBColor', 'team_b_color'],
    teamACoachName: ['teamACoachName', 'team_a_coach_name'],
    teamAAssistantCoachName: ['teamAAssistantCoachName', 'team_a_assistant_coach_name'],
    teamBCoachName: ['teamBCoachName', 'team_b_coach_name'],
    teamBCoachBipin: ['teamBCoachBipin', 'team_b_coach_bipin', 'teamBCoachLicenceNo', 'team_b_coach_licence'],
    teamBAssistantCoachName: ['teamBAssistantCoachName', 'team_b_assistant_coach_name'],
    teamACoachBipin: [
      'teamACoachBipin',
      'team_a_coach_bipin',
      'teamACoachLicenceNo',
      'team_a_coach_licence'
    ],
    gameNumber: ['gameNumber', 'game_no', 'gameNo', 'game_number'],
    umpire2Name: ['umpire2Name', 'umpire_2', 'umpire2', 'umpire_2_name'],
    assistantScorekeeperName: [
      'assistantScorekeeperName',
      'assistant_scorekeeper_name',
      'assistantScorekeeper'
    ]
  };
  for (const k of Object.keys(DEFAULT_DATA)) {
    if (
      k === 'sheetVariant' ||
      k === 'teamAPlayers' ||
      k === 'teamBPlayers' ||
      k === 'runningScoreEvents' ||
      k === 'periodScoresTeamA' ||
      k === 'periodScoresTeamB' ||
      k === 'finalScoreTeamA' ||
      k === 'finalScoreTeamB' ||
      k === 'pointsPerColumn' ||
      k === 'r2PeriodScoresTeamA' ||
      k === 'r2PeriodScoresTeamB' ||
      k === 'r3FinalScoreTeamA' ||
      k === 'r3FinalScoreTeamB' ||
      k === 'r3WinningTeamName' ||
      k === 'l3Officials' ||
      k === 'playerScoringOverrides'
    ) {
      continue;
    }
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
  out.teamAPlayers = normalizePlayerArray(pickTeamPlayersArrayFromParsed(parsed, 'A'));
  out.teamBPlayers = normalizePlayerArray(pickTeamPlayersArrayFromParsed(parsed, 'B'));
  const l3Raw =
    parsed.l3Officials ||
    parsed.l3_officials ||
    (parsed.L3 && Array.isArray(parsed.L3.officials) ? parsed.L3.officials : null) ||
    (parsed.l3 && Array.isArray(parsed.l3.officials) ? parsed.l3.officials : null);
  out.l3Officials = normalizeL3OfficialsArray(l3Raw);
  out.runningScoreEvents = normalizeRunningScoreEvents(pickRunningScoreEventsFromParsed(parsed));
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
  if (out.finalScoreTeamA === 0 && out.finalScoreTeamB === 0 && (out.r3FinalScoreTeamA > 0 || out.r3FinalScoreTeamB > 0)) {
    out.finalScoreTeamA = out.r3FinalScoreTeamA;
    out.finalScoreTeamB = out.r3FinalScoreTeamB;
  }
  out.runningScoreEvents = recalibrateUniformBasketTypes(out.runningScoreEvents, out.finalScoreTeamA, out.finalScoreTeamB);
  out.runningScoreEvents = repartitionRunningEventsByFinals(out.runningScoreEvents, out.finalScoreTeamA, out.finalScoreTeamB);
  out.sheetVariant = resolveSheetVariant(sheetVariant);
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
 * Maps vision extraction failures to a short, user-safe message (no raw API dumps).
 */
function formatExtractionErrorForClient(err) {
  const msg = getErrorMessage(err);
  const lower = msg.toLowerCase();

  if (/groq_api_key not set|extraction api key not set/i.test(msg)) {
    return 'Extraction is not configured on this server. Ask the site administrator to set the extraction API key.';
  }
  if (/extraction supports images only/i.test(msg)) return msg;
  if (/image is still too large|after encoding/i.test(msg)) return msg;

  if (/extract_json_output_limit/i.test(msg)) {
    return (
      'This scoresheet needed more space than the AI is allowed to write in one step (JSON was cut off). ' +
      'Try a smaller or lower-resolution photo, crop closer to the table and lines, or a more compressed JPEG. ' +
      'If it keeps happening, the host may need to raise the vision output token limit (CHAT_VISION_MAX_TOKENS / GROQ_MAX_COMPLETION_TOKENS_CAP).'
    );
  }

  if (/json_validate_failed|max completion tokens|failed_generation|valid document/i.test(lower)) {
    return (
      'The AI ran out of room while building the structured result for this image (output was cut off before JSON finished). ' +
      'Try a smaller or clearer crop of the scoresheet, or ask the host to allow a larger output budget if the sheet is very busy.'
    );
  }

  if (/\b401\b|invalid.?api.?key|invalid_api_key/i.test(lower)) {
    return 'The AI service rejected the server configuration (401). Contact the site administrator.';
  }

  if (/\b403\b|forbidden|permission denied/i.test(lower)) {
    return 'The AI service denied this request (403). Check API key permissions or model access.';
  }

  if (/\b429\b|rate limit|too many requests|quota exceeded/i.test(lower)) {
    const retryMs = parseRetryDelayMs(err);
    return retryMs
      ? `The AI service rate limit was reached. Try again in about ${Math.max(1, Math.ceil(retryMs / 1000))} seconds.`
      : 'The AI service rate limit was reached. Wait a minute and try again.';
  }

  if (/\b503\b|service unavailable|overloaded|high demand|try again later/i.test(lower)) {
    return 'The AI service is temporarily busy (503). Please retry in a minute.';
  }

  if (/\b502\b|bad gateway/i.test(lower)) {
    return 'The AI service returned a gateway error (502). Please retry shortly.';
  }

  if (/invalid json body|returned invalid json/i.test(lower)) {
    return 'The AI returned an unexpected response. Try again, or use a smaller image.';
  }

  if (/no message content/i.test(lower)) {
    return 'The AI returned an empty response. Try again or use a different image.';
  }

  if (/fetch failed|econnrefused|enotfound|getaddrinfo|network/i.test(lower)) {
    return 'Could not reach the AI service from this server. Check network connectivity and try again.';
  }

  if (/vision chat api http 400/i.test(lower)) {
    return 'The AI service rejected the request (400). Use a JPEG, PNG, GIF, or WebP image.';
  }

  if (/vision chat api http 5\d\d/i.test(lower)) {
    return 'The AI service had a server error. Please try again in a few minutes.';
  }

  const safe = msg.replace(/\s+/g, ' ').trim();
  if (safe.length > 280) return safe.slice(0, 277) + '…';
  return safe || 'Extraction failed. Please try again.';
}

function formatGenericServerError(err) {
  const msg = getErrorMessage(err);
  if (/session_secret/i.test(msg)) {
    return 'Server misconfiguration: SESSION_SECRET must be set (32+ random characters) in production.';
  }
  if (/enoent|eacces|eperm|enospc|emfile/i.test(msg.toLowerCase())) {
    return 'Could not read or write data on the server. Check disk space and file permissions.';
  }
  return 'Something went wrong on the server. Please try again.';
}

/**
 * OpenAI-compatible chat.completions with one user message (text + image data URL).
 */
function getFibaPhase1Prompt() {
  return (
    getMinimalImagePrompt('fiba') +
    '\n\n**FIBA pass 1 of 2:** Set **runningScoreEvents** to [] (empty array). Do not extract the R1 running-score play-by-play in this pass. Prioritize complete **teamAPlayers** and **teamBPlayers** (every roster row, up to 12). Fill all other non-R1 fields when visible.'
  );
}

function getFibaPhase2Prompt() {
  let schemaBlock = '';
  try {
    schemaBlock = fs.readFileSync(SCHEMA_FILE_FIBA, 'utf8').trim();
  } catch (e) {
    try {
      schemaBlock = fs.readFileSync(SCHEMA_FILE, 'utf8').trim();
    } catch (e2) {}
  }
  return (
    'FIBA scoresheet  -  **pass 2 of 2 (scoring only)**. Rosters were already extracted in pass 1. Output **one flat JSON object**.\n\n' +
    '**Must do:**\n' +
    '- Set **teamAPlayers** and **teamBPlayers** to [].\n' +
    '- **runningScoreEvents**: one object per scoring mark, chronological. Each: `point` (global 1…N), `team` "A"|"B", `type` "1"|"2"|"3", `jersey` (scorer kit). ' +
    '`type` "1" = dot in inner point column; "2" = slash through play number; "3" = three-pointer (circle).\n' +
    '- Fill **periodScoresTeamA/B**, **finalScoreTeamA/B**, **r2PeriodScoresTeamA/B**, **r2ExtraPeriodPointsTeamA/B**, **r3FinalScoreTeamA/B**, **r3WinningTeamName**, **pointsPerColumn** from the sheet.\n' +
    '- Root keys only; never nest under L1, L2, or R1.\n\n' +
    'FIBA flat JSON note: **teamAPlayers**, **teamBPlayers**, **runningScoreEvents** must be **root-level arrays**.\n\n' +
    'Schema:\n' +
    schemaBlock +
    '\n\nReturn a single JSON object only (no markdown). Use 0 only when a number is not printed on the sheet.'
  );
}

function sumQuarterScoresArray(arr) {
  const n = normalizePeriodScores(arr);
  return n[0] + n[1] + n[2] + n[3];
}

/** When finals are still 0, derive from R3 row or quarter lines + extra (OT). */
function deriveFibaFinalsFromSubscores(out) {
  const fa = out.finalScoreTeamA ?? 0;
  const fb = out.finalScoreTeamB ?? 0;
  if (fa > 0 || fb > 0) return;
  const r3a = out.r3FinalScoreTeamA ?? 0;
  const r3b = out.r3FinalScoreTeamB ?? 0;
  if (r3a > 0 || r3b > 0) {
    out.finalScoreTeamA = r3a;
    out.finalScoreTeamB = r3b;
    return;
  }
  const perA = sumQuarterScoresArray(out.periodScoresTeamA);
  const perB = sumQuarterScoresArray(out.periodScoresTeamB);
  const r2A = sumQuarterScoresArray(out.r2PeriodScoresTeamA);
  const r2B = sumQuarterScoresArray(out.r2PeriodScoresTeamB);
  const baseA = perA > 0 ? perA : r2A;
  const baseB = perB > 0 ? perB : r2B;
  const exA = out.r2ExtraPeriodPointsTeamA ?? 0;
  const exB = out.r2ExtraPeriodPointsTeamB ?? 0;
  const ta = baseA + exA;
  const tb = baseB + exB;
  if (ta > 0 || tb > 0) {
    out.finalScoreTeamA = ta;
    out.finalScoreTeamB = tb;
    out.r3FinalScoreTeamA = ta;
    out.r3FinalScoreTeamB = tb;
  }
}

/**
 * Merge roster pass (phase 1) with scoring pass (phase 2). Prefer phase 2 for R1/R2/R3 when it returned data.
 */
function mergeFibaPhaseResults(rosterNorm, scoreNorm) {
  const out = { ...rosterNorm };
  const ev = scoreNorm.runningScoreEvents;
  if (Array.isArray(ev) && ev.length > 0) {
    out.runningScoreEvents = normalizeRunningScoreEvents(ev);
  }
  const fsA = scoreNorm.finalScoreTeamA ?? 0;
  const fsB = scoreNorm.finalScoreTeamB ?? 0;
  const r3a = scoreNorm.r3FinalScoreTeamA ?? 0;
  const r3b = scoreNorm.r3FinalScoreTeamB ?? 0;
  const perSum =
    (Array.isArray(scoreNorm.periodScoresTeamA) ? scoreNorm.periodScoresTeamA.reduce((s, x) => s + (x || 0), 0) : 0) +
    (Array.isArray(scoreNorm.periodScoresTeamB) ? scoreNorm.periodScoresTeamB.reduce((s, x) => s + (x || 0), 0) : 0);
  const r2Sum =
    (Array.isArray(scoreNorm.r2PeriodScoresTeamA) ? scoreNorm.r2PeriodScoresTeamA.reduce((s, x) => s + (x || 0), 0) : 0) +
    (Array.isArray(scoreNorm.r2PeriodScoresTeamB) ? scoreNorm.r2PeriodScoresTeamB.reduce((s, x) => s + (x || 0), 0) : 0);
  const score2HasTotals =
    fsA + fsB > 0 ||
    r3a + r3b > 0 ||
    perSum > 0 ||
    r2Sum > 0 ||
    (scoreNorm.r3WinningTeamName != null && String(scoreNorm.r3WinningTeamName).trim() !== '');
  if (score2HasTotals) {
    out.pointsPerColumn = scoreNorm.pointsPerColumn === 60 ? 60 : 40;
    out.periodScoresTeamA = normalizePeriodScores(scoreNorm.periodScoresTeamA);
    out.periodScoresTeamB = normalizePeriodScores(scoreNorm.periodScoresTeamB);
    out.finalScoreTeamA = fsA;
    out.finalScoreTeamB = fsB;
    out.r2PeriodScoresTeamA = normalizePeriodScores(scoreNorm.r2PeriodScoresTeamA);
    out.r2PeriodScoresTeamB = normalizePeriodScores(scoreNorm.r2PeriodScoresTeamB);
    out.r2ExtraPeriodPointsTeamA = scoreNorm.r2ExtraPeriodPointsTeamA ?? 0;
    out.r2ExtraPeriodPointsTeamB = scoreNorm.r2ExtraPeriodPointsTeamB ?? 0;
    out.r3FinalScoreTeamA = r3a;
    out.r3FinalScoreTeamB = r3b;
    out.r3WinningTeamName =
      scoreNorm.r3WinningTeamName != null ? String(scoreNorm.r3WinningTeamName).trim() : '';
  }
  if (out.finalScoreTeamA === 0 && out.finalScoreTeamB === 0 && (out.r3FinalScoreTeamA > 0 || out.r3FinalScoreTeamB > 0)) {
    out.finalScoreTeamA = out.r3FinalScoreTeamA;
    out.finalScoreTeamB = out.r3FinalScoreTeamB;
  }
  deriveFibaFinalsFromSubscores(out);
  const inferred = sumRunningEventPoints(out.runningScoreEvents);
  if (
    out.finalScoreTeamA === 0 &&
    out.finalScoreTeamB === 0 &&
    out.runningScoreEvents.length > 0 &&
    inferred.teamA + inferred.teamB > 0
  ) {
    out.finalScoreTeamA = inferred.teamA;
    out.finalScoreTeamB = inferred.teamB;
    out.r3FinalScoreTeamA = inferred.teamA;
    out.r3FinalScoreTeamB = inferred.teamB;
  }
  out.runningScoreEvents = recalibrateUniformBasketTypes(out.runningScoreEvents, out.finalScoreTeamA, out.finalScoreTeamB);
  out.runningScoreEvents = repartitionRunningEventsByFinals(out.runningScoreEvents, out.finalScoreTeamA, out.finalScoreTeamB);
  out.sheetVariant = 'fiba';
  return out;
}

async function extractWithChatCompletionsVision(filePath, originalName, multerMime, options) {
  const {
    url,
    apiKey,
    model,
    extraHeaders = {},
    sheetVariant: variantOpt,
    userTextOverride,
    maxCompletionTokens: maxTokOpt
  } = options;
  const sheetVariant = resolveSheetVariant(variantOpt);
  const mimeType = getMimeType(filePath, originalName, multerMime);
  if (!MIME_TO_CHAT_VISION[mimeType]) {
    throw new Error(
      `Extraction supports images only (${Object.keys(MIME_TO_CHAT_VISION).join(', ')}), not ${mimeType}. Export the scoresheet as JPEG or PNG and retry.`
    );
  }

  const buffer = fs.readFileSync(filePath);
  const b64 = buffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${b64}`;
  const dataUrlBytes = Buffer.byteLength(dataUrl, 'utf8');
  if (dataUrlBytes > VISION_MAX_DATA_URL_BYTES) {
    const maxMb = (VISION_MAX_DATA_URL_BYTES / (1024 * 1024)).toFixed(1);
    const gotMb = (dataUrlBytes / (1024 * 1024)).toFixed(1);
    throw new Error(
      `This image is still too large for analysis (${gotMb} MB; the server allows up to ${maxMb} MB after encoding). Try a smaller or more compressed JPEG/PNG, or take a new photo at lower resolution.`
    );
  }

  const userText =
    (userTextOverride || getMinimalImagePrompt(sheetVariant)) +
    '\n\nYou must respond with a single JSON object only (no markdown code fences).';

  let maxCompletionTokens =
    typeof maxTokOpt === 'number' && maxTokOpt > 0
      ? Math.min(getGroqMaxCompletionTokensCap(), Math.max(256, Math.floor(maxTokOpt)))
      : groqMaxCompletionTokensFromEnv();
  let res;
  let rawText = '';
  for (let attempt = 0; attempt < 6; attempt++) {
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

    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders
      },
      body: JSON.stringify(body)
    });

    rawText = await res.text();
    if (res.ok) break;
    const completionCap = getGroqMaxCompletionTokensCap();
    const raiseForTruncatedJson =
      res.status === 400 &&
      isGroqJsonOutputTruncation(rawText) &&
      maxCompletionTokens < completionCap;
    if (raiseForTruncatedJson) {
      const prev = maxCompletionTokens;
      maxCompletionTokens = Math.min(
        completionCap,
        Math.max(prev * 2, 8192)
      );
      if (maxCompletionTokens > prev) continue;
    }
    if (res.status === 400 && isGroqJsonOutputTruncation(rawText)) {
      throw new Error('EXTRACT_JSON_OUTPUT_LIMIT');
    }
    const retryable400Lower =
      res.status === 400 &&
      /max_completion_tokens|max_tokens/i.test(rawText) &&
      maxCompletionTokens > 256;
    if (retryable400Lower) {
      maxCompletionTokens = Math.max(256, Math.floor(maxCompletionTokens / 2));
      continue;
    }
    throw new Error(`Vision chat API HTTP ${res.status}: ${rawText.slice(0, 800)}`);
  }
  if (!res.ok) {
    throw new Error(`Vision chat API HTTP ${res.status} (after retries): ${rawText.slice(0, 800)}`);
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
  if (process.env.EXTRACTION_DEBUG === '1' && !IS_VERCEL) {
    try {
      fs.writeFileSync(EXTRACTION_DEBUG_FILE, JSON.stringify(parsed, null, 2), 'utf8');
    } catch (e) {}
  }
  return normalizeExtracted(parsed, sheetVariant);
}

async function extractWithGroq(filePath, originalName, multerMime, sheetVariant) {
  const apiKey = String(process.env.GROQ_API_KEY || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!apiKey) {
    throw new Error('Extraction API key not set. Add it to .env and restart the server.');
  }
  const model = (process.env.GROQ_MODEL || GROQ_DEFAULT_VISION_MODEL).trim();
  const baseOpts = {
    url: GROQ_CHAT_COMPLETIONS_URL,
    apiKey,
    model,
    sheetVariant
  };
  const twoPhaseOff = String(process.env.FIBA_TWO_PHASE || '').trim().toLowerCase() === '0';
  if (resolveSheetVariant(sheetVariant) === 'fiba' && !twoPhaseOff) {
    const rosterNorm = await extractWithChatCompletionsVision(filePath, originalName, multerMime, {
      ...baseOpts,
      userTextOverride: getFibaPhase1Prompt()
    });
    try {
      const scoreNorm = await extractWithChatCompletionsVision(filePath, originalName, multerMime, {
        ...baseOpts,
        userTextOverride: getFibaPhase2Prompt(),
        maxCompletionTokens: Math.min(
          getGroqMaxCompletionTokensCap(),
          Math.max(groqMaxCompletionTokensFromEnv(), 8192)
        )
      });
      return mergeFibaPhaseResults(rosterNorm, scoreNorm);
    } catch (e) {
      if (/extract_json_output_limit/i.test(getErrorMessage(e))) throw e;
      console.warn('FIBA scoring pass (2/2) failed; using roster pass only:', getErrorMessage(e));
      return rosterNorm;
    }
  }
  return extractWithChatCompletionsVision(filePath, originalName, multerMime, baseOpts);
}

let redis = null;
try {
  const rUrl = process.env.UPSTASH_REDIS_REST_URL && String(process.env.UPSTASH_REDIS_REST_URL).trim();
  const rTok = process.env.UPSTASH_REDIS_REST_TOKEN && String(process.env.UPSTASH_REDIS_REST_TOKEN).trim();
  if (rUrl && rTok) {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({ url: rUrl, token: rTok });
  }
} catch (e) {
  console.warn('Upstash Redis init failed:', e.message);
}

/** Distributed upload caps (requires Redis). Env: UPLOAD_RATELIMIT_MAX (default 20), UPLOAD_RATELIMIT_WINDOW (default "1 h"). */
let uploadRatelimit = null;
if (redis) {
  try {
    const { Ratelimit } = require('@upstash/ratelimit');
    const max = Math.max(1, parseInt(String(process.env.UPLOAD_RATELIMIT_MAX || '20').trim(), 10) || 20);
    const windowStr = (process.env.UPLOAD_RATELIMIT_WINDOW || '1 h').trim();
    uploadRatelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(max, windowStr),
      analytics: true,
      prefix: 'ratelimit:upload'
    });
  } catch (e) {
    console.warn('@upstash/ratelimit init failed:', e.message);
  }
}

const SESSION_COOKIE_NAME = 'sa_session';
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 400;
/** Accepts UUID v4 from crypto.randomUUID() */
const SESSION_USER_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCORESHEET_KEY = (userId) => 'scoresheet:' + userId;

function getSessionSecret() {
  const s = process.env.SESSION_SECRET && String(process.env.SESSION_SECRET).trim();
  if (s && s.length >= 32) return s;
  if (IS_VERCEL || process.env.NODE_ENV === 'production') {
    throw new Error(
      'SESSION_SECRET must be set to a random string of at least 32 characters (required for public multi-user sessions).'
    );
  }
  return 'dev-unsafe-session-secret-min-32-chars!!';
}

function signUserId(userId, secret) {
  return crypto.createHmac('sha256', secret).update(userId).digest('base64url');
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const userId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!SESSION_USER_RE.test(userId) || !sig) return null;
  let expected;
  try {
    expected = signUserId(userId, getSessionSecret());
  } catch (e) {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return userId;
}

function readCookie(header, name) {
  if (!header) return null;
  const parts = String(header).split(';');
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    if (k !== name) continue;
    return decodeURIComponent(p.slice(idx + 1).trim());
  }
  return null;
}

function buildSessionCookie(tokenValue) {
  const bits = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(tokenValue)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${SESSION_MAX_AGE_SEC}`,
    'SameSite=Lax'
  ];
  if (IS_VERCEL || process.env.NODE_ENV === 'production') bits.push('Secure');
  return bits.join('; ');
}

function sessionMiddleware(req, res, next) {
  try {
    const secret = getSessionSecret();
    const raw = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    let userId = raw && verifySessionToken(raw);
    if (!userId) {
      userId = crypto.randomUUID();
      const token = userId + '.' + signUserId(userId, secret);
      res.append('Set-Cookie', buildSessionCookie(token));
    }
    req.userId = userId;
    next();
  } catch (e) {
    const msg = getErrorMessage(e);
    const userMsg = /SESSION_SECRET/i.test(msg)
      ? 'Server misconfiguration: SESSION_SECRET must be set to a random string of at least 32 characters in production.'
      : 'Could not start your session. Refresh the page or try again.';
    res.status(500).type('json').send(JSON.stringify({ error: userMsg, errorCode: 'SESSION_ERROR' }));
  }
}

function persistenceAvailable() {
  return !!(redis || !IS_VERCEL);
}

function persistenceErrorResponse() {
  if (IS_VERCEL && !redis) {
    return {
      error:
        'Saving data is not configured on this host. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the project environment, then redeploy.',
      errorCode: 'STORAGE_NOT_CONFIGURED'
    };
  }
  return {
    error: 'Storage is temporarily unavailable. Please try again in a moment.',
    errorCode: 'STORAGE_UNAVAILABLE'
  };
}

async function loadUserData(userId) {
  if (redis) {
    const raw = await redis.get(SCORESHEET_KEY(userId));
    if (raw == null) return null;
    const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return JSON.parse(str);
  }
  const fp = path.join(USER_DATA_DIR, userId + '.json');
  try {
    const raw = fs.readFileSync(fp, 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function saveUserData(userId, data) {
  if (redis) {
    await redis.set(SCORESHEET_KEY(userId), JSON.stringify(data));
    return;
  }
  const fp = path.join(USER_DATA_DIR, userId + '.json');
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
}

async function verifyTurnstileToken(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY && String(process.env.TURNSTILE_SECRET_KEY).trim();
  if (!secret) return true;
  if (!token || typeof token !== 'string' || !token.trim()) return false;
  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token.trim());
  if (remoteIp) body.set('remoteip', String(remoteIp).slice(0, 45));
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  let data;
  try {
    data = await res.json();
  } catch (e) {
    return false;
  }
  return data && data.success === true;
}

async function uploadRatelimitMiddleware(req, res, next) {
  if (!uploadRatelimit) return next();
  try {
    const id = String(req.ip || 'unknown') + ':' + String(req.userId || '');
    const { success, reset, pending } = await uploadRatelimit.limit(id);
    if (pending && typeof pending.then === 'function') {
      void pending.catch(() => {});
    }
    if (success) return next();
    const resetMs = typeof reset === 'number' ? reset : Date.now() + 60 * 1000;
    const retrySec = Math.max(1, Math.ceil((resetMs - Date.now()) / 1000));
    res.set('Retry-After', String(retrySec));
    return res.status(429).json({
      error: `Too many uploads. Please try again in about ${retrySec} seconds.`,
      errorCode: 'UPLOAD_SESSION_RATE_LIMIT',
      retryAfterSeconds: retrySec
    });
  } catch (e) {
    console.error('uploadRatelimit:', e.message);
    return next();
  }
}

function buildScoresheetFromRequestBody(body) {
  const b = body || {};
  const data = { ...DEFAULT_DATA };
  for (const k of Object.keys(DEFAULT_DATA)) {
    if (b[k] == null) continue;
    if (k === 'teamAPlayers' || k === 'teamBPlayers') {
      data[k] = Array.isArray(b[k]) ? b[k].slice(0, MAX_PLAYERS_PER_TEAM).map(normalizePlayer) : [];
    } else if (k === 'runningScoreEvents') {
      data[k] = normalizeRunningScoreEvents(b[k] || []);
    } else if (k === 'periodScoresTeamA' || k === 'periodScoresTeamB') {
      data[k] = normalizePeriodScores(b[k]);
    } else if (k === 'finalScoreTeamA' || k === 'finalScoreTeamB') {
      const n = parseInt(String(b[k]), 10);
      data[k] = Number.isNaN(n) || n < 0 ? 0 : n;
    } else if (k === 'pointsPerColumn') {
      const n = parseInt(String(b[k]), 10);
      data[k] = n === 60 ? 60 : 40;
    } else if (k === 'r2PeriodScoresTeamA' || k === 'r2PeriodScoresTeamB') {
      data[k] = normalizePeriodScores(b[k]);
    } else if (k === 'r3FinalScoreTeamA' || k === 'r3FinalScoreTeamB') {
      const n = parseInt(String(b[k]), 10);
      data[k] = Number.isNaN(n) || n < 0 ? 0 : n;
    } else if (k === 'r3WinningTeamName') {
      data[k] = (b[k] != null ? String(b[k]) : '').trim();
    } else if (k === 'playerScoringOverrides') {
      data[k] = normalizePlayerScoringOverrides(b[k]);
    } else if (k === 'l3Officials') {
      data[k] = normalizeL3OfficialsArray(b[k]);
    } else if (k === 'sheetVariant') {
      data[k] = resolveSheetVariant(b[k]);
    } else if (INTEGER_KEYS.includes(k)) {
      const n = parseInt(String(b[k]), 10);
      data[k] = Number.isNaN(n) ? 0 : n;
    } else {
      data[k] = String(b[k]);
    }
  }
  return data;
}

const apiReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 400,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many data requests. Please wait a few minutes and try again.',
    errorCode: 'API_READ_RATE_LIMIT'
  }
});

const apiWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many save requests. Please wait a few minutes and try again.',
    errorCode: 'API_WRITE_RATE_LIMIT'
  }
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many uploads from this IP in the last hour. Try again in a while.',
    errorCode: 'UPLOAD_IP_RATE_LIMIT'
  }
});

app.set('trust proxy', 1);
app.use(sessionMiddleware);
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
app.get('/privacy', (req, res) => sendHtml('privacy.html', req, res));
app.get('/privacy.html', (req, res) => sendHtml('privacy.html', req, res));

app.get('/api/config', (req, res) => {
  const siteKey = process.env.TURNSTILE_SITE_KEY && String(process.env.TURNSTILE_SITE_KEY).trim();
  res.json({
    turnstileSiteKey: siteKey || ''
  });
});

const demoPath = path.join(__dirname, 'assets', 'demo-scoresheet.png');
app.get('/assets/demo-scoresheet.png', (req, res) => {
  const p = fs.existsSync(demoPath) ? demoPath : path.join(process.cwd(), 'assets', 'demo-scoresheet.png');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(404).send('Not found');
});
app.use(express.static(__dirname));

app.get('/api/data', apiReadLimiter, async (req, res) => {
  if (!persistenceAvailable()) {
    return res.status(503).json(persistenceErrorResponse());
  }
  try {
    const stored = await loadUserData(req.userId);
    if (!stored) return res.json(DEFAULT_DATA);
    if (stored.$schema) return res.json(DEFAULT_DATA);
    const merged = { ...DEFAULT_DATA, ...stored };
    res.json(merged);
  } catch (err) {
    console.error('GET /api/data:', err);
    res.status(500).json({
      error: 'Could not load your saved data. Please try again.',
      errorCode: 'LOAD_FAILED'
    });
  }
});

app.put('/api/data', apiWriteLimiter, async (req, res) => {
  if (!persistenceAvailable()) {
    return res.status(503).json(persistenceErrorResponse());
  }
  try {
    const data = buildScoresheetFromRequestBody(req.body);
    await saveUserData(req.userId, data);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/data:', err);
    res.status(500).json({
      error: 'Could not save your changes. Please try again.',
      errorCode: 'SAVE_FAILED'
    });
  }
});

function unlinkUploadSilently(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {}
}

app.post(
  '/api/upload',
  uploadLimiter,
  uploadRatelimitMiddleware,
  upload.single('scoresheet'),
  async (req, res) => {
  const filePath = req.file && req.file.path;
  try {
    if (!persistenceAvailable()) {
      return res.status(503).json(persistenceErrorResponse());
    }
    if (!req.file) {
      return res.status(400).json({
        error: 'No file was attached. Choose an image (JPEG, PNG, GIF, or WebP) and try again.',
        errorCode: 'NO_FILE'
      });
    }

    const turnstileSecret = process.env.TURNSTILE_SECRET_KEY && String(process.env.TURNSTILE_SECRET_KEY).trim();
    if (turnstileSecret) {
      const token =
        (req.body && (req.body['cf-turnstile-response'] || req.body['cf_turnstile_response'])) || '';
      const ok = await verifyTurnstileToken(token, req.ip).catch(() => false);
      if (!ok) {
        unlinkUploadSilently(filePath);
        return res.status(400).json({
          error:
            'Human verification failed or expired. Complete the verification widget again, then upload.',
          errorCode: 'TURNSTILE_FAILED'
        });
      }
    }

    const originalName = req.file.originalname || '';
    let extracted = null;
    try {
      const fromBody = req.body && (req.body.sheetVariant || req.body.sheet_style);
      const trimmed = String(fromBody ?? '').trim();
      const envDefault = String(process.env.SHEET_DEFAULT_VARIANT ?? '').trim();
      if (!trimmed && !envDefault) {
        unlinkUploadSilently(filePath);
        return res.status(400).json({
          error:
            'No scoresheet layout was sent. On the home page, choose Basketball Ireland or FIBA before uploading.',
          errorCode: 'SHEET_VARIANT_REQUIRED'
        });
      }
      const sheetVariant = trimmed || envDefault;
      extracted = await extractWithGroq(filePath, originalName, req.file.mimetype, sheetVariant);
      await saveUserData(req.userId, extracted);
    } catch (extractErr) {
      unlinkUploadSilently(filePath);
      const msg = extractErr?.message || extractErr?.toString?.() || 'Extraction failed';
      console.error('Extraction error:', msg);
      return res.status(500).json({
        error: formatExtractionErrorForClient(extractErr),
        errorCode: 'EXTRACTION_FAILED',
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
    console.error('POST /api/upload:', err);
    res.status(500).json({ error: formatGenericServerError(err), errorCode: 'UPLOAD_FAILED' });
  }
  }
);

/** Multer and upload errors  -  return JSON with clear messages. */
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    const maxMb = (UPLOAD_MAX_FILE_BYTES / (1024 * 1024)).toFixed(1);
    return res.status(413).json({
      error: `That file is too large for this app (maximum ${maxMb} MB per upload). Try a smaller photo - the page usually compresses images in your browser first; if you still see this, export a smaller JPEG or use a lower camera resolution.`,
      errorCode: 'FILE_TOO_LARGE'
    });
  }
  if (err && err.name === 'MulterError') {
    const byCode = {
      LIMIT_FILE_COUNT: 'Only one file can be uploaded at a time.',
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field. Use the upload area on this page.',
      LIMIT_UNEXPECTED_FIELD: 'Unexpected form field. Use the upload form on this page.'
    };
    const m =
      byCode[err.code] ||
      'Upload could not be processed. Use a single JPEG, PNG, GIF, or WebP image and try again.';
    return res.status(400).json({ error: m, errorCode: err.code || 'MULTER_ERROR' });
  }
  next(err);
});

/** JSON body too large (e.g. huge PUT /api/data). */
app.use((err, req, res, next) => {
  if (err && (err.status === 413 || err.type === 'entity.too.large')) {
    return res.status(413).json({
      error: 'Request body is too large. Try saving again with fewer changes, or contact the host.',
      errorCode: 'BODY_TOO_LARGE'
    });
  }
  next(err);
});

/** Fallback for unhandled errors (after routes). */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.', errorCode: 'INTERNAL_ERROR' });
});

if (!IS_VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`Server at http://localhost:${PORT}`);
    const lan = getLanIPv4();
    if (lan && HOST !== '127.0.0.1') {
      console.log(`On your phone (same Wi‑Fi): http://${lan}:${PORT}`);
    }
    console.log('Extraction: vision + JSON');
    console.log('Extraction API key:', process.env.GROQ_API_KEY ? 'set' : 'NOT SET');
    console.log('GROQ_MODEL:', (process.env.GROQ_MODEL || GROQ_DEFAULT_VISION_MODEL).trim());
    console.log('Per-user store:', redis ? 'Upstash Redis' : 'local .user-data/*.json');
    console.log('Upload ratelimit (Upstash):', uploadRatelimit ? 'on' : 'off (set UPSTASH_REDIS_* for distributed limits)');
    const tsSec = !!(process.env.TURNSTILE_SECRET_KEY && String(process.env.TURNSTILE_SECRET_KEY).trim());
    const tsSite = !!(process.env.TURNSTILE_SITE_KEY && String(process.env.TURNSTILE_SITE_KEY).trim());
    console.log('Turnstile:', tsSec ? 'verify on' : 'off', tsSite ? '(site key set)' : '');
    if (tsSec && !tsSite) {
      console.warn('Turnstile: TURNSTILE_SECRET_KEY is set but TURNSTILE_SITE_KEY is missing  -  uploads will fail until both are set.');
    }
    try {
      getSessionSecret();
      console.log('SESSION_SECRET: ok');
    } catch (e) {
      console.error('SESSION_SECRET:', e.message);
    }
    console.log(
      `Upload max file: ${(UPLOAD_MAX_FILE_BYTES / (1024 * 1024)).toFixed(2)} MB (UPLOAD_MAX_FILE_MB); vision data URL max: ${VISION_MAX_DATA_URL_MB} MB (VISION_MAX_DATA_URL_MB)`
    );
  });
}

module.exports = app;
