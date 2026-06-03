const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';
const SUPERADMIN_KEY = process.env.SUPERADMIN_KEY || 'WC2026_SUPERADMIN_KEY';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// =============================================
// DATABASE SETUP
// =============================================
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leagues (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        manager_count INTEGER NOT NULL,
        competition JSONB NOT NULL,
        admin_token TEXT NOT NULL,
        draft_order JSONB DEFAULT '[]',
        draft_picks JSONB DEFAULT '[]',
        draft_open BOOLEAN DEFAULT false,
        draft_complete BOOLEAN DEFAULT false,
        manual_stats JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS league_slots (
        id SERIAL PRIMARY KEY,
        league_id INTEGER REFERENCES leagues(id),
        slot INTEGER NOT NULL,
        token TEXT NOT NULL,
        manager_id TEXT,
        manager_name TEXT,
        team_name TEXT
      );

      CREATE TABLE IF NOT EXISTS player_pools (
        id SERIAL PRIMARY KEY,
        league_api_id INTEGER NOT NULL,
        season INTEGER NOT NULL,
        players JSONB NOT NULL DEFAULT '[]',
        teams JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMP DEFAULT NOW(),
        last_refreshed_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(league_api_id, season)
      );

      CREATE TABLE IF NOT EXISTS draft_queues (
        id SERIAL PRIMARY KEY,
        league_id INTEGER REFERENCES leagues(id),
        manager_id TEXT NOT NULL,
        queue JSONB NOT NULL DEFAULT '[]',
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(league_id, manager_id)
      );

      CREATE TABLE IF NOT EXISTS fixtures (
        id BIGINT PRIMARY KEY,
        league_api_id INTEGER NOT NULL,
        season INTEGER NOT NULL,
        round TEXT,
        stage TEXT,
        home_team_api_id INTEGER,
        away_team_api_id INTEGER,
        status TEXT,
        elapsed INTEGER,
        finalized BOOLEAN DEFAULT false,
        match_date TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS match_stats (
        fixture_id BIGINT REFERENCES fixtures(id),
        player_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        goals INTEGER DEFAULT 0,
        assists INTEGER DEFAULT 0,
        pk_goals INTEGER DEFAULT 0,
        pk_misses INTEGER DEFAULT 0,
        red_cards INTEGER DEFAULT 0,
        fantasy_points INTEGER DEFAULT 0,
        UNIQUE(fixture_id, player_id)
      );

      CREATE TABLE IF NOT EXISTS team_match_stats (
        fixture_id BIGINT REFERENCES fixtures(id),
        team_api_id INTEGER NOT NULL,
        stage TEXT NOT NULL,
        goals_scored INTEGER DEFAULT 0,
        goals_against INTEGER DEFAULT 0,
        result TEXT,
        clean_sheet BOOLEAN DEFAULT false,
        fantasy_points INTEGER DEFAULT 0,
        UNIQUE(fixture_id, team_api_id)
      );

      CREATE TABLE IF NOT EXISTS co_managers (
        id SERIAL PRIMARY KEY,
        league_id INTEGER REFERENCES leagues(id),
        slot_id INTEGER REFERENCES league_slots(id),
        token TEXT NOT NULL UNIQUE,
        co_manager_name TEXT,
        added_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Database initialized');
  } catch(e) {
    console.error('DB init error:', e.message);
  }
}

// =============================================
// API FOOTBALL HELPER
// =============================================
const API_FOOTBALL_SQUADS_TTL_MS = 12 * 60 * 60 * 1000;
const API_FOOTBALL_MIN_INTERVAL_MS = 6500;
let apiFootballNextAllowedAt = 0;
let apiFootballQueue = Promise.resolve();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scheduleApiFootballRequest(label, fn) {
  apiFootballQueue = apiFootballQueue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, apiFootballNextAllowedAt - now);
    if (waitMs > 0) console.log(`[apiFootball] throttle wait ${waitMs}ms (${label})`);
    if (waitMs > 0) await sleep(waitMs);
    const start = Date.now();
    apiFootballNextAllowedAt = start + API_FOOTBALL_MIN_INTERVAL_MS;
    return fn();
  });
  return apiFootballQueue;
}

function stableStringify(obj) {
  if (!obj || typeof obj !== 'object') return String(obj);
  const keys = Object.keys(obj).sort();
  return keys.map(k => `${k}=${encodeURIComponent(String(obj[k]))}`).join('&');
}

const apiFootballCache = new Map();

function getApiFootballCached(key) {
  const entry = apiFootballCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) { apiFootballCache.delete(key); return null; }
  return entry.data;
}

function setApiFootballCached(key, data, ttlMs) {
  apiFootballCache.set(key, { expiresAt: Date.now() + ttlMs, data });
}

class ApiFootballError extends Error {
  constructor(message, { status = 502, endpoint, params, upstreamStatus, upstreamErrors, upstreamBody, retryAfterSeconds } = {}) {
    super(message);
    this.name = 'ApiFootballError';
    this.isApiFootballError = true;
    this.status = status;
    this.endpoint = endpoint;
    this.params = params;
    this.upstreamStatus = upstreamStatus;
    this.upstreamErrors = upstreamErrors;
    this.upstreamBody = upstreamBody;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function hasUpstreamErrors(data) {
  const errs = data && data.errors;
  if (!errs) return false;
  if (Array.isArray(errs)) return errs.length > 0;
  if (typeof errs === 'object') return Object.keys(errs).length > 0;
  return Boolean(errs);
}

function sendApiFootballError(res, e) {
  if (e && e.isApiFootballError) {
    if (e.status === 429 && e.retryAfterSeconds) res.set('Retry-After', String(e.retryAfterSeconds));
    return res.status(e.status).json({
      error: e.message,
      upstreamStatus: e.upstreamStatus,
      upstreamErrors: e.upstreamErrors,
      endpoint: e.endpoint,
      params: e.params
    });
  }
  return res.status(500).json({ error: e.message });
}

async function apiFootball(endpoint, params = {}) {
  if (endpoint === '/players/squads') {
    const cacheKey = `${endpoint}?${stableStringify(params)}`;
    const cached = getApiFootballCached(cacheKey);
    if (cached) { console.log(`[apiFootball] squads cache hit team=${params.team}`); return cached; }
    console.log(`[apiFootball] squads cache miss team=${params.team}`);
    try {
      const response = await scheduleApiFootballRequest(`GET ${endpoint} team=${params.team}`, () =>
        axios.get(`${API_BASE}${endpoint}`, { headers: { 'x-apisports-key': API_KEY }, params })
      );
      const data = response.data;
      if (hasUpstreamErrors(data)) throw new ApiFootballError('API-Football returned errors', {
        status: 429, retryAfterSeconds: 60, endpoint, params,
        upstreamStatus: 200, upstreamErrors: data.errors, upstreamBody: data
      });
      setApiFootballCached(cacheKey, data, API_FOOTBALL_SQUADS_TTL_MS);
      return data;
    } catch (e) {
      if (e && e.isApiFootballError) throw e;
      if (e && e.response) throw new ApiFootballError('API-Football HTTP error', {
        status: e.response.status === 429 ? 429 : 502,
        retryAfterSeconds: e.response.status === 429 ? 60 : undefined,
        endpoint, params, upstreamStatus: e.response.status,
        upstreamErrors: e.response.data && e.response.data.errors, upstreamBody: e.response.data
      });
      throw e;
    }
  }
  try {
    const response = await scheduleApiFootballRequest(`GET ${endpoint}`, () =>
      axios.get(`${API_BASE}${endpoint}`, { headers: { 'x-apisports-key': API_KEY }, params })
    );
    const data = response.data;
    if (hasUpstreamErrors(data)) throw new ApiFootballError('API-Football returned errors', {
      status: 429, retryAfterSeconds: 60, endpoint, params,
      upstreamStatus: 200, upstreamErrors: data.errors, upstreamBody: data
    });
    return data;
  } catch (e) {
    if (e && e.isApiFootballError) throw e;
    if (e && e.response) throw new ApiFootballError('API-Football HTTP error', {
      status: e.response.status === 429 ? 429 : 502,
      retryAfterSeconds: e.response.status === 429 ? 60 : undefined,
      endpoint, params, upstreamStatus: e.response.status,
      upstreamErrors: e.response.data && e.response.data.errors, upstreamBody: e.response.data
    });
    throw e;
  }
}

// =============================================
// LEAGUE HELPERS
// =============================================
function generateToken() {
  return Math.random().toString(36).substring(2) +
         Math.random().toString(36).substring(2) +
         Math.random().toString(36).substring(2);
}

function generateSnakePicks(draftOrder, rounds) {
  const picks = [];
  if (!draftOrder || draftOrder.length === 0) return picks;
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 === 0 ? [...draftOrder] : [...draftOrder].reverse();
    order.forEach((manager, i) => {
      picks.push({
        round: r + 1, pickInRound: i + 1,
        overall: r * draftOrder.length + i + 1,
        managerId: manager.id, managerName: manager.name
      });
    });
  }
  return picks;
}

async function getLeague(id) {
  const leagueRes = await pool.query('SELECT * FROM leagues WHERE id = $1', [id]);
  if (leagueRes.rows.length === 0) return null;
  const league = leagueRes.rows[0];
  const slotsRes = await pool.query('SELECT * FROM league_slots WHERE league_id = $1 ORDER BY slot', [id]);
  return {
    id: league.id,
    name: league.name,
    managerCount: league.manager_count,
    competition: league.competition,
    adminToken: league.admin_token,
    draftOrder: league.draft_order || [],
    draftPicks: league.draft_picks || [],
    draftOpen: league.draft_open,
    draftComplete: league.draft_complete,
    manualStats: league.manual_stats || [],
    inviteLinks: slotsRes.rows.map(s => ({
      slot: s.slot, token: s.token,
      managerId: s.manager_id, managerName: s.manager_name, teamName: s.team_name
    })),
    managers: slotsRes.rows.filter(s => s.manager_id).map(s => ({
      slot: s.slot, managerId: s.manager_id,
      managerName: s.manager_name, teamName: s.team_name
    }))
  };
}

function sanitizeLeague(league) {
  const { adminToken, ...safe } = league;
  safe.inviteLinks = undefined;
  return safe;
}

// =============================================
// PLAYER POOL — FIFA WORLD CUP 2026 (48 teams)
// =============================================
// NOTE: Verify these API-Football national team IDs against
// GET /teams?league=1&season=2026 once your subscription is active.
// National team IDs are different from club IDs.
const COMPETITION_TEAMS = {
  1: [ // FIFA World Cup 2026
    // Group A
    { id: 2, name: 'USA', code: 'USA' },
    { id: 6, name: 'Mexico', code: 'MEX' },
    { id: 95, name: 'Canada', code: 'CAN' },
    // Group B
    { id: 9, name: 'Argentina', code: 'ARG' },
    { id: 26, name: 'Chile', code: 'CHI' },
    { id: 31, name: 'Peru', code: 'PER' },
    // Group C
    { id: 10, name: 'Brazil', code: 'BRA' },
    { id: 21, name: 'Colombia', code: 'COL' },
    { id: 30, name: 'Paraguay', code: 'PAR' },
    // Group D
    { id: 5, name: 'Germany', code: 'GER' },
    { id: 762, name: 'Scotland', code: 'SCO' },
    { id: 732, name: 'Hungary', code: 'HUN' },
    // Group E
    { id: 8, name: 'Spain', code: 'ESP' },
    { id: 768, name: 'Serbia', code: 'SRB' },
    { id: 1508, name: 'Morocco', code: 'MAR' },
    // Group F
    { id: 773, name: 'France', code: 'FRA' },
    { id: 772, name: 'Belgium', code: 'BEL' },
    { id: 1118, name: 'Senegal', code: 'SEN' },
    // Group G
    { id: 27, name: 'England', code: 'ENG' },
    { id: 1546, name: 'Tunisia', code: 'TUN' },
    { id: 756, name: 'Slovakia', code: 'SVK' },
    // Group H
    { id: 769, name: 'Portugal', code: 'POR' },
    { id: 764, name: 'Czech Republic', code: 'CZE' },
    { id: 1530, name: 'Cameroon', code: 'CMR' },
    // Group I
    { id: 3, name: 'Netherlands', code: 'NED' },
    { id: 771, name: 'Austria', code: 'AUT' },
    { id: 1529, name: 'Ivory Coast', code: 'CIV' },
    // Group J
    { id: 1, name: 'Japan', code: 'JPN' },
    { id: 760, name: 'Croatia', code: 'CRO' },
    { id: 1527, name: 'Equatorial Guinea', code: 'EQG' },
    // Group K
    { id: 7, name: 'South Korea', code: 'KOR' },
    { id: 770, name: 'Switzerland', code: 'SUI' },
    { id: 1540, name: 'Nigeria', code: 'NGA' },
    // Group L
    { id: 766, name: 'Denmark', code: 'DEN' },
    { id: 1523, name: 'New Zealand', code: 'NZL' },
    { id: 1516, name: 'Saudi Arabia', code: 'KSA' },
    // Remaining qualified teams — verify IDs
    { id: 767, name: 'Poland', code: 'POL' },
    { id: 761, name: 'Slovenia', code: 'SVN' },
    { id: 1514, name: 'Australia', code: 'AUS' },
    { id: 1519, name: 'Iran', code: 'IRN' },
    { id: 1515, name: 'South Africa', code: 'RSA' },
    { id: 1528, name: 'Congo DR', code: 'COD' },
    { id: 1520, name: 'Qatar', code: 'QAT' },
    { id: 1521, name: 'Uruguay', code: 'URU' },
    { id: 1522, name: 'Ecuador', code: 'ECU' },
    { id: 1524, name: 'Venezuela', code: 'VEN' },
    { id: 1526, name: 'Panama', code: 'PAN' },
    { id: 1525, name: 'Honduras', code: 'HON' },
  ]
};

// IMPORTANT: Verify these round strings exactly match what API-Football returns
// for GET /fixtures?league=1&season=2026 before seeding.
// Run GET /fixtures?league=1&season=2026&round=Group+Stage+-+1 to confirm naming.
const STAGE_MAP = {
  1: { // FIFA World Cup 2026
    'Group Stage - 1': 'GS1',
    'Group Stage - 2': 'GS2',
    'Group Stage - 3': 'GS3',
    'Round of 32': 'R32',
    'Round of 16': 'R16',
    'Quarter-finals': 'QF',
    'Semi-finals': 'SF',
    'Third Place Match': '3RD',
    'Final': 'F'
  }
};

function mapPosition(pos) {
  if (!pos) return 'MF';
  const p = String(pos).toLowerCase();
  if (p.includes('attack') || p.includes('forward')) return 'FW';
  if (p.includes('midfield')) return 'MF';
  if (p.includes('defend')) return 'DF';
  if (p.includes('goal')) return 'GK';
  return 'MF';
}

async function fetchSquadsFromApi(leagueApiId) {
  const teams = COMPETITION_TEAMS[leagueApiId];
  if (!teams) throw new Error(`Unknown competition: league ${leagueApiId}`);

  const playerMap = new Map();

  for (const t of teams) {
    try {
      const data = await apiFootball('/players/squads', { team: t.id });
      (data.response || []).forEach(squad => {
        (squad.players || []).forEach(p => {
          if (!playerMap.has(p.id)) {
            playerMap.set(p.id, {
              id: p.id, name: p.name, country: t.code,
              pos: mapPosition(p.position), scores: {}, draftedBy: null
            });
          }
        });
      });
    } catch (e) {
      console.warn(`[playerPool] squad fetch failed team=${t.id} (${t.name}):`, e.message);
    }
    await sleep(500);
  }

  const players = Array.from(playerMap.values());
  const teamsData = teams.map(t => ({
    id: `team-${t.id}`, apiId: t.id,
    name: `${t.name} Defense`, country: t.code,
    pos: 'TEAM', scores: {}, draftedBy: null
  }));

  return { players, teams: teamsData };
}

async function getOrCreatePlayerPool(leagueApiId, season) {
  const res = await pool.query(
    'SELECT players, teams FROM player_pools WHERE league_api_id = $1 AND season = $2',
    [leagueApiId, season]
  );
  if (res.rows.length > 0) return { players: res.rows[0].players || [], teams: res.rows[0].teams || [], fromDb: true };
  const { players, teams } = await fetchSquadsFromApi(leagueApiId);
  await pool.query(
    `INSERT INTO player_pools (league_api_id, season, players, teams)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (league_api_id, season) DO UPDATE SET
       players = EXCLUDED.players, teams = EXCLUDED.teams, last_refreshed_at = NOW()`,
    [leagueApiId, season, JSON.stringify(players), JSON.stringify(teams)]
  );
  return { players, teams, fromDb: false };
}

async function refreshPlayerPool(leagueApiId, season) {
  const res = await pool.query(
    'SELECT players, teams FROM player_pools WHERE league_api_id = $1 AND season = $2',
    [leagueApiId, season]
  );
  const existingPlayers = res.rows[0]?.players || [];
  const existingTeams = res.rows[0]?.teams?.length > 0 ? res.rows[0].teams : null;
  const existingIds = new Set(existingPlayers.map(p => String(p.id)));

  const { players: freshPlayers, teams: freshTeams } = await fetchSquadsFromApi(leagueApiId);
  const merged = [...existingPlayers];
  let added = 0;
  for (const p of freshPlayers) {
    if (!existingIds.has(String(p.id))) { merged.push(p); existingIds.add(String(p.id)); added++; }
  }
  const teamsToSave = existingTeams || freshTeams;
  await pool.query(
    `INSERT INTO player_pools (league_api_id, season, players, teams)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (league_api_id, season) DO UPDATE SET
       players = EXCLUDED.players, teams = EXCLUDED.teams, last_refreshed_at = NOW()`,
    [leagueApiId, season, JSON.stringify(merged), JSON.stringify(teamsToSave)]
  );
  return { players: merged, teams: teamsToSave, added };
}

// =============================================
// LEAGUE ROUTES
// =============================================
app.post('/api/leagues', async (req, res) => {
  const { name, managerCount, competition, adminName } = req.body;
  if (!name || !managerCount || !competition) return res.status(400).json({ error: 'Missing required fields' });
  if (managerCount % 2 !== 0 || managerCount < 8 || managerCount > 14) {
    return res.status(400).json({ error: 'Manager count must be even, between 8 and 14' });
  }
  try {
    const adminToken = generateToken();
    const leagueRes = await pool.query(
      `INSERT INTO leagues (name, manager_count, competition, admin_token) VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, managerCount, JSON.stringify(competition), adminToken]
    );
    const leagueId = leagueRes.rows[0].id;
    const adminManagerId = generateToken();
    const inviteLinks = [];

    for (let i = 0; i < managerCount; i++) {
      const token = generateToken();
      if (i === 0) {
        if (adminName) {
          await pool.query(
            `INSERT INTO league_slots (league_id, slot, token, manager_id, manager_name, team_name) VALUES ($1, $2, $3, $4, $5, $6)`,
            [leagueId, 1, token, adminManagerId, adminName, 'My Team']
          );
          inviteLinks.push({ slot: 1, token, managerId: adminManagerId, managerName: adminName, teamName: 'My Team' });
        } else {
          await pool.query(
            `INSERT INTO league_slots (league_id, slot, token) VALUES ($1, $2, $3)`,
            [leagueId, 1, token]
          );
          inviteLinks.push({ slot: 1, token });
        }
      } else {
        await pool.query(`INSERT INTO league_slots (league_id, slot, token) VALUES ($1, $2, $3)`, [leagueId, i + 1, token]);
        inviteLinks.push({ slot: i + 1, token });
      }
    }
    res.json({ leagueId, adminToken, adminManagerId, inviteLinks });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leagues/:id', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    res.json(sanitizeLeague(league));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leagues/:id/admin', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
    res.json(league);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leagues/:id/join', async (req, res) => {
  const { token, managerName, teamName } = req.body;
  try {
    const slotRes = await pool.query(
      'SELECT * FROM league_slots WHERE league_id = $1 AND token = $2', [req.params.id, token]
    );
    if (slotRes.rows.length === 0) return res.status(404).json({ error: 'Invalid invite link' });
    const slot = slotRes.rows[0];
    if (slot.manager_id) return res.status(400).json({ error: 'This slot is already taken' });
    const managerId = generateToken();
    await pool.query(
      'UPDATE league_slots SET manager_id = $1, manager_name = $2, team_name = $3 WHERE id = $4',
      [managerId, managerName, teamName, slot.id]
    );
    res.json({ managerId, managerName, teamName, slot: slot.slot });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leagues/:id/slot-by-token', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    // Check primary slot token
    const slotRes = await pool.query(
      'SELECT id, manager_id, manager_name, team_name FROM league_slots WHERE league_id = $1 AND token = $2',
      [req.params.id, token]
    );
    if (slotRes.rows.length > 0) {
      const slot = slotRes.rows[0];
      if (slot.manager_id) return res.json({ managerId: slot.manager_id, managerName: slot.manager_name, teamName: slot.team_name });
      return res.json({ pending: true });
    }
    // Check co-manager token
    const coRes = await pool.query(
      `SELECT cm.co_manager_name, ls.manager_id, ls.manager_name, ls.team_name
       FROM co_managers cm
       JOIN league_slots ls ON ls.id = cm.slot_id
       WHERE cm.league_id = $1 AND cm.token = $2`,
      [req.params.id, token]
    );
    if (coRes.rows.length > 0) {
      const co = coRes.rows[0];
      if (!co.manager_id) return res.status(400).json({ error: 'Primary manager has not joined yet' });
      return res.json({
        managerId: co.manager_id,
        managerName: co.manager_name,
        teamName: co.team_name,
        isCoManager: true,
        coManagerName: co.co_manager_name
      });
    }
    return res.status(404).json({ error: 'Invalid invite link' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leagues/:id/verify-manager', async (req, res) => {
  const { managerId } = req.body;
  try {
    const slotRes = await pool.query(
      'SELECT * FROM league_slots WHERE league_id = $1 AND manager_id = $2', [req.params.id, managerId]
    );
    if (slotRes.rows.length === 0) return res.status(404).json({ error: 'Manager not found' });
    const slot = slotRes.rows[0];
    res.json({ managerId: slot.manager_id, managerName: slot.manager_name, teamName: slot.team_name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/leagues/:id/profile', async (req, res) => {
  const leagueId = req.params.id;
  const { managerId, managerName, teamName } = req.body;
  if (!managerId) return res.status(400).json({ error: 'Missing managerId' });
  try {
    const slotRes = await pool.query(
      'SELECT id FROM league_slots WHERE league_id = $1 AND manager_id = $2', [leagueId, managerId]
    );
    if (slotRes.rows.length === 0) return res.status(404).json({ error: 'Manager not found' });
    const slot = slotRes.rows[0];
    const updates = []; const values = []; let n = 1;
    if (managerName !== undefined) { updates.push(`manager_name = $${n++}`); values.push(managerName == null ? '' : String(managerName)); }
    if (teamName !== undefined) { updates.push(`team_name = $${n++}`); values.push(teamName == null ? '' : String(teamName)); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    values.push(slot.id);
    await pool.query(`UPDATE league_slots SET ${updates.join(', ')} WHERE id = $${n}`, values);
    const updated = await pool.query('SELECT manager_id, manager_name, team_name FROM league_slots WHERE id = $1', [slot.id]);
    const row = updated.rows[0];
    res.json({ managerId: row.manager_id, managerName: row.manager_name, teamName: row.team_name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leagues/:id', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
    await pool.query('DELETE FROM co_managers WHERE league_id = $1', [req.params.id]);
    await pool.query('DELETE FROM league_slots WHERE league_id = $1', [req.params.id]);
    await pool.query('DELETE FROM draft_queues WHERE league_id = $1', [req.params.id]);
    await pool.query('DELETE FROM leagues WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================
// CO-MANAGER ROUTES
// =============================================

// Admin adds a co-manager to a slot — returns a unique join link
app.post('/api/leagues/:id/co-manager', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });

    const { slot, coManagerName } = req.body;
    if (!slot) return res.status(400).json({ error: 'Missing slot number' });

    const slotRes = await pool.query(
      'SELECT id, manager_id, manager_name FROM league_slots WHERE league_id = $1 AND slot = $2',
      [req.params.id, slot]
    );
    if (slotRes.rows.length === 0) return res.status(404).json({ error: 'Slot not found' });
    const slotRow = slotRes.rows[0];

    const token = generateToken();
    await pool.query(
      `INSERT INTO co_managers (league_id, slot_id, token, co_manager_name) VALUES ($1, $2, $3, $4)`,
      [req.params.id, slotRow.id, token, coManagerName || 'Co-Manager']
    );

    const link = `${req.protocol}://${req.get('host')}?league=${req.params.id}&token=${token}`;
    res.json({ success: true, token, link, forSlot: slot, primaryManager: slotRow.manager_name || 'Not joined yet' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// List co-managers for a league (admin only)
app.get('/api/leagues/:id/co-managers', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });

    const res2 = await pool.query(
      `SELECT cm.id, cm.token, cm.co_manager_name, cm.added_at, ls.slot, ls.manager_name
       FROM co_managers cm
       JOIN league_slots ls ON ls.id = cm.slot_id
       WHERE cm.league_id = $1
       ORDER BY ls.slot, cm.added_at`,
      [req.params.id]
    );
    res.json({ coManagers: res2.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Remove a co-manager (admin only)
app.delete('/api/leagues/:id/co-manager/:coManagerId', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
    await pool.query('DELETE FROM co_managers WHERE id = $1 AND league_id = $2', [req.params.coManagerId, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================
// DRAFT QUEUE
// =============================================
async function getQueueRow(leagueId, managerId) {
  const res = await pool.query(
    'SELECT queue FROM draft_queues WHERE league_id = $1 AND manager_id = $2', [leagueId, managerId]
  );
  return res.rows.length > 0 ? (res.rows[0].queue || []) : [];
}

function upsertQueue(leagueId, managerId, queue) {
  return pool.query(
    `INSERT INTO draft_queues (league_id, manager_id, queue) VALUES ($1, $2, $3)
     ON CONFLICT (league_id, manager_id) DO UPDATE SET queue = EXCLUDED.queue, updated_at = NOW()`,
    [leagueId, managerId, JSON.stringify(queue)]
  );
}

app.get('/api/leagues/:id/queue', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    const managerId = req.query.managerId;
    if (!managerId) return res.status(400).json({ error: 'Missing managerId' });
    const queue = await getQueueRow(req.params.id, managerId);
    res.json({ queue });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leagues/:id/queue', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    const { managerId, playerId } = req.body;
    if (!managerId || playerId === undefined) return res.status(400).json({ error: 'Missing managerId or playerId' });
    const pid = String(playerId);
    let queue = await getQueueRow(req.params.id, managerId);
    if (queue.some(id => String(id) === pid)) return res.json({ queue });
    queue = [...queue, pid];
    await upsertQueue(req.params.id, managerId, queue);
    res.json({ queue });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leagues/:id/queue/:playerId', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    const managerId = req.body?.managerId;
    if (!managerId) return res.status(400).json({ error: 'Missing managerId' });
    const pid = String(req.params.playerId);
    let queue = await getQueueRow(req.params.id, managerId);
    queue = queue.filter(id => String(id) !== pid);
    await upsertQueue(req.params.id, managerId, queue);
    res.json({ queue });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/leagues/:id/queue', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    const { managerId, queue: incoming } = req.body;
    if (!managerId || !Array.isArray(incoming)) return res.status(400).json({ error: 'Missing managerId or queue' });
    const existing = await getQueueRow(req.params.id, managerId);
    const existingSet = new Set(existing.map(id => String(id)));
    const incomingSet = new Set(incoming.map(id => String(id)));
    if (existingSet.size !== incomingSet.size || [...incomingSet].some(id => !existingSet.has(id))) {
      return res.status(400).json({ error: 'Queue must contain the same player IDs (reorder only)' });
    }
    await upsertQueue(req.params.id, managerId, incoming);
    res.json({ queue: incoming });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================
// PLAYER POOL ROUTES
// =============================================
app.get('/api/leagues/:id/players', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    const comp = league.competition;
    if (!comp || comp.leagueId == null || comp.season == null) {
      return res.status(400).json({ error: 'League has no competition configured' });
    }
    const leagueApiId = parseInt(comp.leagueId, 10);
    const season = parseInt(comp.season, 10);
    const { players, teams } = await getOrCreatePlayerPool(leagueApiId, season);
    res.json({ players, teams });
  } catch(e) {
    console.error('[players]', e);
    if (e && e.isApiFootballError) return sendApiFootballError(res, e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leagues/:id/players/refresh', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
    const comp = league.competition;
    if (!comp || comp.leagueId == null || comp.season == null) {
      return res.status(400).json({ error: 'League has no competition configured' });
    }
    const leagueApiId = parseInt(comp.leagueId, 10);
    const season = parseInt(comp.season, 10);
    const { players, teams, added } = await refreshPlayerPool(leagueApiId, season);
    res.json({ players, teams, added });
  } catch(e) {
    console.error('[players/refresh]', e);
    if (e && e.isApiFootballError) return sendApiFootballError(res, e);
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// DRAFT ROUTES
// =============================================
app.post('/api/leagues/:id/draft-order', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
    await pool.query('UPDATE leagues SET draft_order = $1 WHERE id = $2', [JSON.stringify(req.body.order), req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leagues/:id/draft-status', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
    await pool.query('UPDATE leagues SET draft_open = $1 WHERE id = $2', [req.body.open, req.params.id]);
    res.json({ success: true, draftOpen: req.body.open });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leagues/:id/pick', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (!league.draftOpen) return res.status(400).json({ error: 'Draft is not open' });
    const isAdmin = req.headers['x-admin-token'] === league.adminToken;
    const { managerId, playerId } = req.body;
    const snakePicks = generateSnakePicks(league.draftOrder, 8);
    const currentPickIndex = league.draftPicks.length;
    if (currentPickIndex >= snakePicks.length) return res.status(400).json({ error: 'Draft is complete' });
    const currentPick = snakePicks[currentPickIndex];
    if (!isAdmin && currentPick.managerId !== managerId) return res.status(403).json({ error: 'Not your turn' });
    const alreadyDrafted = league.draftPicks.find(p => String(p.playerId) === String(playerId));
    if (alreadyDrafted) return res.status(400).json({ error: 'Player already drafted' });
    const pick = {
      overall: currentPickIndex + 1, round: currentPick.round,
      pickInRound: currentPick.pickInRound, managerId: currentPick.managerId,
      managerName: currentPick.managerName, playerId: String(playerId),
      timestamp: new Date().toISOString()
    };
    const newPicks = [...league.draftPicks, pick];
    const draftComplete = newPicks.length >= snakePicks.length;
    await pool.query(
      'UPDATE leagues SET draft_picks = $1, draft_open = $2, draft_complete = $3 WHERE id = $4',
      [JSON.stringify(newPicks), draftComplete ? false : league.draftOpen, draftComplete, req.params.id]
    );
    res.json({ success: true, pick });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leagues/:id/pick', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
    if (league.draftPicks.length === 0) return res.status(400).json({ error: 'No picks to undo' });
    const newPicks = league.draftPicks.slice(0, -1);
    const undone = league.draftPicks[league.draftPicks.length - 1];
    await pool.query(
      'UPDATE leagues SET draft_picks = $1, draft_open = true, draft_complete = false WHERE id = $2',
      [JSON.stringify(newPicks), req.params.id]
    );
    res.json({ success: true, undone });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leagues/:id/swap-pick', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
    const { outPlayerId, inPlayerId, managerId } = req.body;
    if (!outPlayerId || !inPlayerId || !managerId) return res.status(400).json({ error: 'Missing required fields' });
    const picks = [...league.draftPicks];
    const pickIndex = picks.findIndex(p => String(p.playerId) === String(outPlayerId) && p.managerId === managerId);
    if (pickIndex === -1) return res.status(404).json({ error: 'Pick not found for this manager' });
    const alreadyDrafted = picks.find(p => String(p.playerId) === String(inPlayerId));
    if (alreadyDrafted) return res.status(400).json({ error: 'Replacement player already drafted' });
    picks[pickIndex] = { ...picks[pickIndex], playerId: String(inPlayerId) };
    await pool.query('UPDATE leagues SET draft_picks = $1 WHERE id = $2', [JSON.stringify(picks), req.params.id]);
    res.json({ success: true, picks });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================
// MANUAL STATS
// =============================================
app.post('/api/leagues/:id/manual-stat', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
    const { playerId, stage, statType, value, note } = req.body;
    const newStat = { playerId, stage, statType, value, note, addedAt: new Date().toISOString() };
    const newStats = [...league.manualStats, newStat];
    await pool.query('UPDATE leagues SET manual_stats = $1 WHERE id = $2', [JSON.stringify(newStats), req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leagues/:id/manual-stat', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
    const index = parseInt(req.body?.index, 10);
    const stats = league.manualStats || [];
    if (Number.isNaN(index) || index < 0 || index >= stats.length) return res.status(400).json({ error: 'Invalid index' });
    const newStats = stats.filter((_, i) => i !== index);
    await pool.query('UPDATE leagues SET manual_stats = $1 WHERE id = $2', [JSON.stringify(newStats), req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================
// SUPERADMIN ROUTES
// =============================================
function requireSuperAdmin(req, res, next) {
  const key = req.headers['x-superadmin-key'] || req.query.key;
  if (!key || key !== SUPERADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  next();
}

// List all leagues
app.get('/api/superadmin/leagues', requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.id, l.name, l.competition, l.created_at,
              COUNT(ls.id) FILTER (WHERE ls.manager_id IS NOT NULL) as joined_count,
              l.manager_count
       FROM leagues l
       LEFT JOIN league_slots ls ON ls.league_id = l.id
       GROUP BY l.id
       ORDER BY l.created_at DESC`
    );
    res.json({ leagues: result.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get full league data as superadmin (includes admin token so you can use normal admin routes too)
app.get('/api/superadmin/leagues/:id', requireSuperAdmin, async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    // Also pull player pool so superadmin can see drafted players
    const comp = league.competition;
    let players = [], teams = [];
    if (comp && comp.leagueId != null && comp.season != null) {
      const poolRes = await pool.query(
        'SELECT players, teams FROM player_pools WHERE league_api_id = $1 AND season = $2',
        [parseInt(comp.leagueId, 10), parseInt(comp.season, 10)]
      );
      if (poolRes.rows.length > 0) {
        players = poolRes.rows[0].players || [];
        teams = poolRes.rows[0].teams || [];
      }
    }
    res.json({ league, players, teams });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Add manual stat to any league (superadmin)
app.post('/api/superadmin/leagues/:id/manual-stat', requireSuperAdmin, async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    const { playerId, stage, statType, value, note } = req.body;
    const newStat = { playerId, stage, statType, value, note, addedAt: new Date().toISOString(), addedBySuperAdmin: true };
    const newStats = [...league.manualStats, newStat];
    await pool.query('UPDATE leagues SET manual_stats = $1 WHERE id = $2', [JSON.stringify(newStats), req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete manual stat from any league (superadmin)
app.delete('/api/superadmin/leagues/:id/manual-stat', requireSuperAdmin, async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    const index = parseInt(req.body?.index, 10);
    const stats = league.manualStats || [];
    if (Number.isNaN(index) || index < 0 || index >= stats.length) return res.status(400).json({ error: 'Invalid index' });
    const newStats = stats.filter((_, i) => i !== index);
    await pool.query('UPDATE leagues SET manual_stats = $1 WHERE id = $2', [JSON.stringify(newStats), req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================
// API-FOOTBALL PASSTHROUGH ROUTES
// =============================================
app.get('/api/football/players', async (req, res) => {
  try { res.json(await apiFootball('/players', req.query)); } catch(e) { sendApiFootballError(res, e); }
});
app.get('/api/football/players/squads', async (req, res) => {
  try { res.json(await apiFootball('/players/squads', { team: req.query.team })); } catch(e) { sendApiFootballError(res, e); }
});
app.get('/api/football/fixtures', async (req, res) => {
  try { res.json(await apiFootball('/fixtures', req.query)); } catch(e) { sendApiFootballError(res, e); }
});
app.get('/api/football/fixture/:fixtureId', async (req, res) => {
  try {
    const [events, stats] = await Promise.all([
      apiFootball('/fixtures/events', { fixture: req.params.fixtureId }),
      apiFootball('/fixtures/statistics', { fixture: req.params.fixtureId })
    ]);
    res.json({ events: events.response, stats: stats.response });
  } catch(e) { sendApiFootballError(res, e); }
});
app.get('/api/football/teams', async (req, res) => {
  try { res.json(await apiFootball('/teams', req.query)); } catch(e) { sendApiFootballError(res, e); }
});

// =============================================
// LIVE SCORING
// =============================================
const WC_LEAGUE_API_ID = 1;
const WC_SEASON = 2026;

app.post('/api/leagues/:id/seed-fixtures', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
    const comp = league.competition;
    const leagueApiId = parseInt(comp.leagueId);
    const season = parseInt(comp.season);
    const stageMap = STAGE_MAP[leagueApiId];
    if (!stageMap) return res.status(400).json({ error: 'No stage map for this competition' });
    let count = 0;
    for (const [roundName, stageLabel] of Object.entries(stageMap)) {
      const data = await apiFootball('/fixtures', { league: leagueApiId, season, round: roundName });
      const fixtures = data.response || [];
      for (const f of fixtures) {
        await pool.query(`
          INSERT INTO fixtures (id, league_api_id, season, round, stage, home_team_api_id, away_team_api_id, status, elapsed, finalized, match_date)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 0), $10, $11)
          ON CONFLICT (id) DO UPDATE SET
            round = EXCLUDED.round, stage = EXCLUDED.stage,
            home_team_api_id = EXCLUDED.home_team_api_id, away_team_api_id = EXCLUDED.away_team_api_id,
            status = EXCLUDED.status, elapsed = EXCLUDED.elapsed, match_date = EXCLUDED.match_date`,
          [f.fixture.id, leagueApiId, season, f.league.round, stageLabel,
           f.teams.home.id, f.teams.away.id, f.fixture.status.short,
           f.fixture.status.elapsed, false, new Date(f.fixture.date)]
        );
        count++;
      }
    }
    res.json({ success: true, count });
  } catch(e) {
    console.error('[seed-fixtures]', e);
    res.status(500).json({ error: e.message });
  }
});

async function pollLiveFixtures() {
  try {
    const liveData = await apiFootball('/fixtures', { live: 'all', league: WC_LEAGUE_API_ID, season: WC_SEASON });
    const liveFixtures = liveData.response || [];
    if (liveFixtures.length === 0) { console.log('[pollLiveFixtures] No live fixtures'); return; }

    const seededRes = await pool.query(
      'SELECT id, stage FROM fixtures WHERE league_api_id = $1 AND season = $2 AND finalized = false',
      [WC_LEAGUE_API_ID, WC_SEASON]
    );
    const seededMap = new Map(seededRes.rows.map(r => [Number(r.id), r.stage]));

    for (const fixture of liveFixtures) {
      const fixtureId = fixture.fixture.id;
      if (!seededMap.has(fixtureId)) {
        const round = fixture.league.round;
        const stageLabel = STAGE_MAP[WC_LEAGUE_API_ID]?.[round];
        if (!stageLabel) { console.log(`[pollLiveFixtures] Unknown round "${round}", skipping`); continue; }
        await pool.query(`
          INSERT INTO fixtures (id, league_api_id, season, round, stage, home_team_api_id, away_team_api_id, status, elapsed, finalized, match_date)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (id) DO NOTHING`,
          [fixtureId, WC_LEAGUE_API_ID, WC_SEASON, round, stageLabel,
           fixture.teams.home.id, fixture.teams.away.id,
           fixture.fixture.status.short, fixture.fixture.status.elapsed || 0,
           false, new Date(fixture.fixture.date)]
        );
        seededMap.set(fixtureId, stageLabel);
        console.log(`[pollLiveFixtures] Auto-seeded fixture ${fixtureId} stage=${stageLabel}`);
      }
    }

    if (seededMap.size === 0) { console.log('[pollLiveFixtures] No seeded fixtures'); return; }

    for (const fixture of liveFixtures) {
      const fixtureId = fixture.fixture.id;
      if (!seededMap.has(fixtureId)) continue;
      const status = fixture.fixture.status.short;
      const elapsed = fixture.fixture.status.elapsed || 0;
      if (status === 'NS' || status === 'HT') continue;
      if (status === '1H' && elapsed < 1) continue;
      if (status === '2H' && elapsed < 47) continue;

      const isFinal = ['FT', 'AET', 'PEN'].includes(status);
      const stage = seededMap.get(fixtureId);

      console.log(`[pollLiveFixtures] Processing ${fixtureId} status=${status} elapsed=${elapsed} stage=${stage}`);

      const [eventsData, statsData] = await Promise.all([
        apiFootball('/fixtures/events', { fixture: fixtureId }),
        apiFootball('/fixtures/statistics', { fixture: fixtureId })
      ]);

      const events = eventsData.response || [];
      const playerPoints = new Map();
      const getPlayer = (id) => {
        if (!id) return null;
        const key = String(id);
        if (!playerPoints.has(key)) playerPoints.set(key, { goals: 0, assists: 0, pk_goals: 0, pk_misses: 0, red_cards: 0, fantasy_points: 0 });
        return playerPoints.get(key);
      };

      for (const event of events) {
        const { type, detail } = event;
        const playerId = event.player?.id;
        const assistId = event.assist?.id;
        if (type === 'Goal') {
          if (detail === 'Normal Goal') {
            if (playerId) { const p = getPlayer(playerId); p.goals++; p.fantasy_points += 3; }
            if (assistId) { const p = getPlayer(assistId); p.assists++; p.fantasy_points += 1; }
          } else if (detail === 'Penalty') {
            if (playerId) { const p = getPlayer(playerId); p.pk_goals++; p.fantasy_points += 2; }
            if (assistId) { const p = getPlayer(assistId); p.assists++; p.fantasy_points += 1; }
          } else if (detail && /missed penalty|penalty missed/i.test(detail)) {
            if (playerId) { const p = getPlayer(playerId); p.pk_misses++; p.fantasy_points -= 1; }
          }
        } else if (type === 'Card' && (detail === 'Red Card' || detail === 'Yellow Red Card')) {
          if (playerId) { const p = getPlayer(playerId); p.red_cards++; p.fantasy_points -= 2; }
        }
      }

      for (const [playerId, stats] of playerPoints.entries()) {
        await pool.query(`
          INSERT INTO match_stats (fixture_id, player_id, stage, goals, assists, pk_goals, pk_misses, red_cards, fantasy_points)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (fixture_id, player_id) DO UPDATE SET
            goals = EXCLUDED.goals, assists = EXCLUDED.assists, pk_goals = EXCLUDED.pk_goals,
            pk_misses = EXCLUDED.pk_misses, red_cards = EXCLUDED.red_cards, fantasy_points = EXCLUDED.fantasy_points`,
          [fixtureId, playerId, stage, stats.goals, stats.assists, stats.pk_goals, stats.pk_misses, stats.red_cards, stats.fantasy_points]
        );
      }

      const homeTeamId = fixture.teams.home.id;
      const awayTeamId = fixture.teams.away.id;
      const homeGoals = fixture.goals.home || 0;
      const awayGoals = fixture.goals.away || 0;

      const processTeam = async (teamId, goalsScored, goalsAgainst, isShootoutWinner) => {
        const cleanSheet = goalsAgainst === 0;
        let result;
        if (isFinal && status === 'PEN') {
          result = isShootoutWinner ? 'W' : 'D';
        } else {
          result = goalsScored > goalsAgainst ? 'W' : goalsScored < goalsAgainst ? 'L' : 'D';
        }
        let fantasyPoints = 0;
        if (result === 'W' && cleanSheet) fantasyPoints = 3;
        else if (result === 'W') fantasyPoints = 1;
        else if (result === 'D' && cleanSheet) fantasyPoints = 2;
        else if (result === 'L' && cleanSheet) fantasyPoints = 2;
        await pool.query(`
          INSERT INTO team_match_stats (fixture_id, team_api_id, stage, goals_scored, goals_against, result, clean_sheet, fantasy_points)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (fixture_id, team_api_id) DO UPDATE SET
            goals_scored = EXCLUDED.goals_scored, goals_against = EXCLUDED.goals_against,
            result = EXCLUDED.result, clean_sheet = EXCLUDED.clean_sheet, fantasy_points = EXCLUDED.fantasy_points`,
          [fixtureId, teamId, stage, goalsScored, goalsAgainst, result, cleanSheet, fantasyPoints]
        );
      };

      let homeIsShootoutWinner = false, awayIsShootoutWinner = false;
      if (status === 'PEN') {
        const homePen = fixture.score?.penalty?.home || 0;
        const awayPen = fixture.score?.penalty?.away || 0;
        homeIsShootoutWinner = homePen > awayPen;
        awayIsShootoutWinner = awayPen > homePen;
      }
      await processTeam(homeTeamId, homeGoals, awayGoals, homeIsShootoutWinner);
      await processTeam(awayTeamId, awayGoals, homeGoals, awayIsShootoutWinner);

      await pool.query(
        'UPDATE fixtures SET status = $1, elapsed = $2, finalized = $3 WHERE id = $4',
        [status, elapsed, isFinal, fixtureId]
      );
      if (isFinal) console.log(`[pollLiveFixtures] Fixture ${fixtureId} finalized`);
    }

    await updatePlayerPoolScores(WC_LEAGUE_API_ID, WC_SEASON);
  } catch(e) {
    console.error('[pollLiveFixtures] Error:', e);
  }
}

async function updatePlayerPoolScores(leagueApiId, season) {
  try {
    const playerScores = await pool.query(`
      SELECT ms.player_id, ms.stage, SUM(ms.fantasy_points) as total
      FROM match_stats ms
      JOIN fixtures f ON f.id = ms.fixture_id
      WHERE f.league_api_id = $1 AND f.season = $2
      GROUP BY ms.player_id, ms.stage`, [leagueApiId, season]
    );
    const teamScores = await pool.query(`
      SELECT tms.team_api_id, tms.stage, SUM(tms.fantasy_points) as total
      FROM team_match_stats tms
      JOIN fixtures f ON f.id = tms.fixture_id
      WHERE f.league_api_id = $1 AND f.season = $2
      GROUP BY tms.team_api_id, tms.stage`, [leagueApiId, season]
    );

    const playerScoreMap = new Map();
    for (const row of playerScores.rows) {
      const key = String(row.player_id);
      if (!playerScoreMap.has(key)) playerScoreMap.set(key, {});
      playerScoreMap.get(key)[row.stage] = parseInt(row.total);
    }
    const teamScoreMap = new Map();
    for (const row of teamScores.rows) {
      const key = row.team_api_id;
      if (!teamScoreMap.has(key)) teamScoreMap.set(key, {});
      teamScoreMap.get(key)[row.stage] = parseInt(row.total);
    }

    const poolRes = await pool.query(
      'SELECT players, teams FROM player_pools WHERE league_api_id = $1 AND season = $2', [leagueApiId, season]
    );
    if (poolRes.rows.length === 0) return;
    const players = poolRes.rows[0].players || [];
    const teams = poolRes.rows[0].teams || [];

    for (const player of players) {
      const scores = playerScoreMap.get(String(player.id));
      if (scores) player.scores = { ...player.scores, ...scores };
    }
    for (const team of teams) {
      const scores = teamScoreMap.get(team.apiId);
      if (scores) team.scores = { ...team.scores, ...scores };
    }

    await pool.query(
      `UPDATE player_pools SET players = $1, teams = $2, last_refreshed_at = NOW()
       WHERE league_api_id = $3 AND season = $4`,
      [JSON.stringify(players), JSON.stringify(teams), leagueApiId, season]
    );
    console.log(`[updatePlayerPoolScores] Updated scores league=${leagueApiId} season=${season}`);
  } catch(e) { console.error('[updatePlayerPoolScores] Error:', e); }
}

app.post('/api/admin/poll-now', async (req, res) => {
  try {
    const token = req.headers['x-admin-token'];
    if (!token) return res.status(403).json({ error: 'Missing admin token' });
    const leagues = await pool.query('SELECT 1 FROM leagues WHERE admin_token = $1 LIMIT 1', [token]);
    if (leagues.rows.length === 0) return res.status(403).json({ error: 'Unauthorized' });
    await pollLiveFixtures();
    res.json({ success: true });
  } catch(e) {
    console.error('[poll-now]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/debug-fixtures', async (req, res) => {
  try {
    const live = await apiFootball('/fixtures', { live: 'all', league: WC_LEAGUE_API_ID, season: WC_SEASON });
    const seeded = await pool.query('SELECT id, stage, status, elapsed FROM fixtures ORDER BY id');
    res.json({
      live: (live.response || []).map(f => ({ id: f.fixture.id, status: f.fixture.status?.short, elapsed: f.fixture.status?.elapsed })),
      seeded: seeded.rows
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// =============================================
// START
// =============================================
initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  setInterval(pollLiveFixtures, 60 * 1000);
  setTimeout(pollLiveFixtures, 5000);
});