const path = require('path');
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
const IS_VERCEL = !!process.env.VERCEL;
const WORK_DIR = IS_VERCEL ? '/tmp' : __dirname;
/** Local-only per-user JSON files; dot-prefixed so express.static does not serve them. */
const USER_DATA_DIR = path.join(__dirname, '.user-data');
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
if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });

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
/** Groq hard cap for `max_completion_tokens` on many models (API message references 8192). */
const GROQ_MAX_COMPLETION_TOKENS_CAP = 8192;
/** Default below cap: vision + long schema/prompt use input tokens, so requesting 8192 can still 400. */
const GROQ_DEFAULT_COMPLETION_TOKENS = 4096;

function groqMaxCompletionTokensFromEnv() {
  const raw = process.env.CHAT_VISION_MAX_TOKENS;
  if (raw == null || String(raw).trim() === '') {
    return Math.min(GROQ_MAX_COMPLETION_TOKENS_CAP, GROQ_DEFAULT_COMPLETION_TOKENS);
  }
  const n = parseInt(String(raw).trim(), 10);
  if (Number.isNaN(n)) {
    return Math.min(GROQ_MAX_COMPLETION_TOKENS_CAP, GROQ_DEFAULT_COMPLETION_TOKENS);
  }
  return Math.min(GROQ_MAX_COMPLETION_TOKENS_CAP, Math.max(256, n));
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
  let jersey = String(e.jersey != null ? e.jersey : '').trim();
  if (/^\d+$/.test(jersey)) jersey = String(parseInt(jersey, 10));
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
  if (out.finalScoreTeamA === 0 && out.finalScoreTeamB === 0 && (out.r3FinalScoreTeamA > 0 || out.r3FinalScoreTeamB > 0)) {
    out.finalScoreTeamA = out.r3FinalScoreTeamA;
    out.finalScoreTeamB = out.r3FinalScoreTeamB;
  }
  out.runningScoreEvents = recalibrateUniformBasketTypes(out.runningScoreEvents, out.finalScoreTeamA, out.finalScoreTeamB);
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

  let maxCompletionTokens = groqMaxCompletionTokensFromEnv();
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
    const retryable400 =
      res.status === 400 &&
      /max_completion_tokens|max_tokens/i.test(rawText) &&
      maxCompletionTokens > 256;
    if (retryable400) {
      maxCompletionTokens = Math.max(256, Math.floor(maxCompletionTokens / 2));
      continue;
    }
    throw new Error(`Vision chat API HTTP ${res.status}: ${rawText.slice(0, 800)}`);
  }
  if (!res.ok) {
    throw new Error(`Vision chat API HTTP ${res.status} (after lowering max_completion_tokens): ${rawText.slice(0, 800)}`);
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
    res.status(500).type('json').send(JSON.stringify({ error: e.message || String(e) }));
  }
}

function persistenceAvailable() {
  return !!(redis || !IS_VERCEL);
}

function persistenceErrorResponse() {
  if (IS_VERCEL && !redis) {
    return {
      error:
        'Database not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the host environment for multi-user storage on Vercel.'
    };
  }
  return { error: 'Storage unavailable.' };
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
      error: 'Too many uploads. Please try again later.',
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
  legacyHeaders: false
});

const apiWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads from this IP. Try again in a while.' }
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const turnstileSecret = process.env.TURNSTILE_SECRET_KEY && String(process.env.TURNSTILE_SECRET_KEY).trim();
    if (turnstileSecret) {
      const token =
        (req.body && (req.body['cf-turnstile-response'] || req.body['cf_turnstile_response'])) || '';
      const ok = await verifyTurnstileToken(token, req.ip).catch(() => false);
      if (!ok) {
        unlinkUploadSilently(filePath);
        return res.status(400).json({
          error: 'Human verification failed or expired. Refresh the page and try again.'
        });
      }
    }

    const originalName = req.file.originalname || '';
    let extracted = null;
    try {
      extracted = await extractWithGroq(filePath, originalName, req.file.mimetype);
      await saveUserData(req.userId, extracted);
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
  }
);

if (!IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server at http://localhost:${PORT}`);
    console.log('Extraction: Groq (vision + JSON)');
    console.log('GROQ_API_KEY:', process.env.GROQ_API_KEY ? 'set' : 'NOT SET');
    console.log('GROQ_MODEL:', (process.env.GROQ_MODEL || GROQ_DEFAULT_VISION_MODEL).trim());
    console.log('Per-user store:', redis ? 'Upstash Redis' : 'local .user-data/*.json');
    console.log('Upload ratelimit (Upstash):', uploadRatelimit ? 'on' : 'off (set UPSTASH_REDIS_* for distributed limits)');
    const tsSec = !!(process.env.TURNSTILE_SECRET_KEY && String(process.env.TURNSTILE_SECRET_KEY).trim());
    const tsSite = !!(process.env.TURNSTILE_SITE_KEY && String(process.env.TURNSTILE_SITE_KEY).trim());
    console.log('Turnstile:', tsSec ? 'verify on' : 'off', tsSite ? '(site key set)' : '');
    if (tsSec && !tsSite) {
      console.warn('Turnstile: TURNSTILE_SECRET_KEY is set but TURNSTILE_SITE_KEY is missing — uploads will fail until both are set.');
    }
    try {
      getSessionSecret();
      console.log('SESSION_SECRET: ok');
    } catch (e) {
      console.error('SESSION_SECRET:', e.message);
    }
  });
}

module.exports = app;
