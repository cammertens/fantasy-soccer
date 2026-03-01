const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';

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
    `);
    console.log('Database initialized');
  } catch(e) {
    console.error('DB init error:', e.message);
  }
}

// =============================================
// API FOOTBALL HELPER
// =============================================
const API_FOOTBALL_SQUADS_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const API_FOOTBALL_MIN_INTERVAL_MS = 6500; // ~10/min safety margin
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

const apiFootballCache = new Map(); // key -> { expiresAt, data }

function getApiFootballCached(key) {
  const entry = apiFootballCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    apiFootballCache.delete(key);
    return null;
  }
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
    if (cached) {
      console.log(`[apiFootball] squads cache hit team=${params.team}`);
      return cached;
    }
    console.log(`[apiFootball] squads cache miss team=${params.team}`);
    try {
      const response = await scheduleApiFootballRequest(`GET ${endpoint} team=${params.team}`, () =>
        axios.get(`${API_BASE}${endpoint}`, {
          headers: { 'x-apisports-key': API_KEY },
          params
        })
      );
      const data = response.data;
      if (hasUpstreamErrors(data)) {
        const errors = data.errors;
        throw new ApiFootballError('API-Football returned errors', {
          status: 429,
          retryAfterSeconds: 60,
          endpoint,
          params,
          upstreamStatus: 200,
          upstreamErrors: errors,
          upstreamBody: data
        });
      }
      setApiFootballCached(cacheKey, data, API_FOOTBALL_SQUADS_TTL_MS);
      return data;
    } catch (e) {
      if (e && e.isApiFootballError) throw e;
      if (e && e.response) {
        throw new ApiFootballError('API-Football HTTP error', {
          status: e.response.status === 429 ? 429 : 502,
          retryAfterSeconds: e.response.status === 429 ? 60 : undefined,
          endpoint,
          params,
          upstreamStatus: e.response.status,
          upstreamErrors: e.response.data && e.response.data.errors,
          upstreamBody: e.response.data
        });
      }
      throw e;
    }
  }
  try {
    const response = await scheduleApiFootballRequest(`GET ${endpoint}`, () =>
      axios.get(`${API_BASE}${endpoint}`, {
        headers: { 'x-apisports-key': API_KEY },
        params
      })
    );
    const data = response.data;
    if (hasUpstreamErrors(data)) {
      throw new ApiFootballError('API-Football returned errors', {
        status: 429,
        retryAfterSeconds: 60,
        endpoint,
        params,
        upstreamStatus: 200,
        upstreamErrors: data.errors,
        upstreamBody: data
      });
    }
    return data;
  } catch (e) {
    if (e && e.isApiFootballError) throw e;
    if (e && e.response) {
      throw new ApiFootballError('API-Football HTTP error', {
        status: e.response.status === 429 ? 429 : 502,
        retryAfterSeconds: e.response.status === 429 ? 60 : undefined,
        endpoint,
        params,
        upstreamStatus: e.response.status,
        upstreamErrors: e.response.data && e.response.data.errors,
        upstreamBody: e.response.data
      });
    }
    throw e;
  }
}

// =============================================
// LEAGUE HELPERS
// =============================================
function generateToken() {
  return Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
}

function generateSnakePicks(draftOrder, rounds) {
  const picks = [];
  if (!draftOrder || draftOrder.length === 0) return picks;
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 === 0 ? [...draftOrder] : [...draftOrder].reverse();
    order.forEach((manager, i) => {
      picks.push({
        round: r + 1,
        pickInRound: i + 1,
        overall: r * draftOrder.length + i + 1,
        managerId: manager.id,
        managerName: manager.name
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
      slot: s.slot,
      token: s.token,
      managerId: s.manager_id,
      managerName: s.manager_name,
      teamName: s.team_name
    })),
    managers: slotsRes.rows
      .filter(s => s.manager_id)
      .map(s => ({
        slot: s.slot,
        managerId: s.manager_id,
        managerName: s.manager_name,
        teamName: s.team_name
      }))
  };
}

function sanitizeLeague(league) {
  const { adminToken, ...safe } = league;
  // Remove tokens from invite links for public view
  safe.inviteLinks = undefined;
  return safe;
}

// =============================================
// PLAYER POOL
// =============================================
const COMPETITION_TEAMS = {
  2: [ // UEFA Champions League
    { id: 40, name: 'Liverpool', code: 'LIV' },
    { id: 42, name: 'Arsenal', code: 'ARS' },
    { id: 50, name: 'Manchester City', code: 'MAN' },
    { id: 529, name: 'Barcelona', code: 'BAR' },
    { id: 541, name: 'Real Madrid', code: 'REA' },
    { id: 530, name: 'Atletico Madrid', code: 'ATL' },
    { id: 157, name: 'Bayern Munich', code: 'BAY' },
    { id: 85, name: 'PSG', code: 'PAR' },
    { id: 168, name: 'Bayer Leverkusen', code: 'BAY' },
    { id: 499, name: 'Atalanta', code: 'ATA' },
    { id: 228, name: 'Sporting CP', code: 'SPO' },
    { id: 49, name: 'Chelsea', code: 'CHE' },
    { id: 47, name: 'Tottenham', code: 'TOT' },
    { id: 34, name: 'Newcastle', code: 'NEW' },
    { id: 645, name: 'Galatasaray', code: 'GAL' },
    { id: 327, name: 'Bodo/Glimt', code: 'BOD' }
  ]
  // Add more competitions (e.g. 1 for World Cup) as needed
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
  const squadResults = [];

  for (const t of teams) {
    try {
      const data = await apiFootball('/players/squads', { team: t.id });
      squadResults.push(data);
      (data.response || []).forEach(squad => {
        (squad.players || []).forEach(p => {
          if (!playerMap.has(p.id)) {
            playerMap.set(p.id, {
              id: p.id,
              name: p.name,
              country: squad.team?.code || (squad.team?.name || '').substring(0, 3).toUpperCase() || '???',
              pos: mapPosition(p.position),
              scores: {},
              draftedBy: null
            });
          }
        });
      });
    } catch (e) {
      console.warn(`[playerPool] squad fetch failed team=${t.id}:`, e.message);
      squadResults.push({ response: [] });
    }
    await sleep(500);
  }

  const players = Array.from(playerMap.values());
  const teamsData = teams.map(t => ({
    id: `team-${t.id}`,
    apiId: t.id,
    name: `${t.name} Defense`,
    country: t.code,
    pos: 'TEAM',
    scores: {},
    draftedBy: null
  }));

  return { players, teams: teamsData };
}

async function getOrCreatePlayerPool(leagueApiId, season) {
  const res = await pool.query(
    'SELECT players, teams FROM player_pools WHERE league_api_id = $1 AND season = $2',
    [leagueApiId, season]
  );
  if (res.rows.length > 0) {
    return {
      players: res.rows[0].players || [],
      teams: res.rows[0].teams || [],
      fromDb: true
    };
  }
  const { players, teams } = await fetchSquadsFromApi(leagueApiId);
  await pool.query(
    `INSERT INTO player_pools (league_api_id, season, players, teams)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (league_api_id, season) DO UPDATE SET
       players = EXCLUDED.players,
       teams = EXCLUDED.teams,
       last_refreshed_at = NOW()`,
    [leagueApiId, season, JSON.stringify(players), JSON.stringify(teams)]
  );
  return { players, teams, fromDb: false };
}

async function refreshPlayerPool(leagueApiId, season) {
  const res = await pool.query(
    'SELECT players, teams FROM player_pools WHERE league_api_id = $1 AND season = $2',
    [leagueApiId, season]
  );
  const existingPlayers = (res.rows[0]?.players || []);
  const existingTeams = (res.rows[0]?.teams || []).length > 0 ? res.rows[0].teams : null;
  const existingIds = new Set(existingPlayers.map(p => String(p.id)));

  const { players: freshPlayers, teams: freshTeams } = await fetchSquadsFromApi(leagueApiId);
  const merged = [...existingPlayers];
  let added = 0;
  for (const p of freshPlayers) {
    if (!existingIds.has(String(p.id))) {
      merged.push(p);
      existingIds.add(String(p.id));
      added++;
    }
  }
  const teamsToSave = existingTeams || freshTeams;

  await pool.query(
    `INSERT INTO player_pools (league_api_id, season, players, teams)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (league_api_id, season) DO UPDATE SET
       players = EXCLUDED.players,
       teams = EXCLUDED.teams,
       last_refreshed_at = NOW()`,
    [leagueApiId, season, JSON.stringify(merged), JSON.stringify(teamsToSave)]
  );
  return { players: merged, teams: teamsToSave, added };
}

// =============================================
// LEAGUE ROUTES
// =============================================

// Create league
app.post('/api/leagues', async (req, res) => {
  const { name, managerCount, competition } = req.body;
  if (!name || !managerCount || !competition) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (managerCount % 2 !== 0 || managerCount < 8 || managerCount > 14) {
    return res.status(400).json({ error: 'Manager count must be even, between 8 and 14' });
  }

  try {
    const adminToken = generateToken();
    const leagueRes = await pool.query(
      `INSERT INTO leagues (name, manager_count, competition, admin_token)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, managerCount, JSON.stringify(competition), adminToken]
    );
    const leagueId = leagueRes.rows[0].id;

    const { adminName } = req.body;
    const adminManagerId = generateToken();
    const inviteLinks = [];

    for (let i = 0; i < managerCount; i++) {
      const token = generateToken();
      if (i === 0) {
        await pool.query(
          `INSERT INTO league_slots (league_id, slot, token, manager_id, manager_name, team_name) VALUES ($1, $2, $3, $4, $5, $6)`,
          [leagueId, 1, token, adminManagerId, adminName || 'Commissioner', 'My Team']
        );
        inviteLinks.push({ slot: 1, token, managerId: adminManagerId, managerName: adminName || 'Commissioner', teamName: 'My Team' });
      } else {
        await pool.query(
          `INSERT INTO league_slots (league_id, slot, token) VALUES ($1, $2, $3)`,
          [leagueId, i + 1, token]
        );
        inviteLinks.push({ slot: i + 1, token });
      }
    }

    res.json({ leagueId, adminToken, adminManagerId, inviteLinks });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Get league (public)
app.get('/api/leagues/:id', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    res.json(sanitizeLeague(league));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get league (admin)
app.get('/api/leagues/:id/admin', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    res.json(league);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Join league
app.post('/api/leagues/:id/join', async (req, res) => {
  const { token, managerName, teamName } = req.body;
  try {
    const slotRes = await pool.query(
      'SELECT * FROM league_slots WHERE league_id = $1 AND token = $2',
      [req.params.id, token]
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
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolve invite token: already joined → managerId/name; not yet → pending (so refresh/reopen can re-enter)
app.get('/api/leagues/:id/slot-by-token', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    const slotRes = await pool.query(
      'SELECT manager_id, manager_name, team_name FROM league_slots WHERE league_id = $1 AND token = $2',
      [req.params.id, token]
    );
    if (slotRes.rows.length === 0) return res.status(404).json({ error: 'Invalid invite link' });
    const slot = slotRes.rows[0];
    if (slot.manager_id) {
      return res.json({ managerId: slot.manager_id, managerName: slot.manager_name, teamName: slot.team_name });
    }
    return res.json({ pending: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Verify manager token (for rejoin)
app.post('/api/leagues/:id/verify-manager', async (req, res) => {
  const { managerId } = req.body;
  try {
    const slotRes = await pool.query(
      'SELECT * FROM league_slots WHERE league_id = $1 AND manager_id = $2',
      [req.params.id, managerId]
    );
    if (slotRes.rows.length === 0) return res.status(404).json({ error: 'Manager not found' });
    const slot = slotRes.rows[0];
    res.json({ managerId: slot.manager_id, managerName: slot.manager_name, teamName: slot.team_name });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/leagues/:id', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });

    await pool.query('DELETE FROM league_slots WHERE league_id = $1', [req.params.id]);
    await pool.query('DELETE FROM draft_queues WHERE league_id = $1', [req.params.id]);
    await pool.query('DELETE FROM leagues WHERE id = $1', [req.params.id]);

    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// DRAFT QUEUE
// =============================================
async function getQueueRow(leagueId, managerId) {
  const res = await pool.query(
    'SELECT queue FROM draft_queues WHERE league_id = $1 AND manager_id = $2',
    [leagueId, managerId]
  );
  return res.rows.length > 0 ? (res.rows[0].queue || []) : [];
}

function upsertQueue(leagueId, managerId, queue) {
  return pool.query(
    `INSERT INTO draft_queues (league_id, manager_id, queue)
     VALUES ($1, $2, $3)
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
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leagues/:id/queue', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    const { managerId, playerId } = req.body;
    if (!managerId || playerId === undefined) return res.status(400).json({ error: 'Missing managerId or playerId' });
    const pid = String(playerId);
    let queue = await getQueueRow(req.params.id, managerId);
    if (queue.some(id => String(id) === pid)) {
      return res.json({ queue });
    }
    queue = [...queue, pid];
    await upsertQueue(req.params.id, managerId, queue);
    res.json({ queue });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get player pool (serves from PostgreSQL; only calls API if no pool exists)
app.get('/api/leagues/:id/players', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    const comp = league.competition;
    if (!comp || comp.leagueId == null || comp.season == null) {
      return res.status(400).json({ error: 'League has no competition configured' });
    }
    const leagueApiId = typeof comp.leagueId === 'number' ? comp.leagueId : parseInt(comp.leagueId, 10);
    const season = typeof comp.season === 'number' ? comp.season : parseInt(comp.season, 10);
    const { players, teams } = await getOrCreatePlayerPool(leagueApiId, season);
    res.json({ players, teams });
  } catch(e) {
    console.error('[players]', e);
    if (e && e.isApiFootballError) return sendApiFootballError(res, e);
    res.status(500).json({ error: e.message });
  }
});

// Refresh player pool (admin only): re-pulls squads, adds new players without removing existing
app.post('/api/leagues/:id/players/refresh', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
    const comp = league.competition;
    if (!comp || comp.leagueId == null || comp.season == null) {
      return res.status(400).json({ error: 'League has no competition configured' });
    }
    const leagueApiId = typeof comp.leagueId === 'number' ? comp.leagueId : parseInt(comp.leagueId, 10);
    const season = typeof comp.season === 'number' ? comp.season : parseInt(comp.season, 10);
    const { players, teams, added } = await refreshPlayerPool(leagueApiId, season);
    res.json({ players, teams, added });
  } catch(e) {
    console.error('[players/refresh]', e);
    if (e && e.isApiFootballError) return sendApiFootballError(res, e);
    res.status(500).json({ error: e.message });
  }
});

// Set draft order
app.post('/api/leagues/:id/draft-order', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });

    await pool.query(
      'UPDATE leagues SET draft_order = $1 WHERE id = $2',
      [JSON.stringify(req.body.order), req.params.id]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Open/close draft
app.post('/api/leagues/:id/draft-status', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });

    await pool.query(
      'UPDATE leagues SET draft_open = $1 WHERE id = $2',
      [req.body.open, req.params.id]
    );
    res.json({ success: true, draftOpen: req.body.open });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Make a pick
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

    if (!isAdmin && currentPick.managerId !== managerId) {
      return res.status(403).json({ error: 'Not your turn' });
    }

    const alreadyDrafted = league.draftPicks.find(p => String(p.playerId) === String(playerId));
    if (alreadyDrafted) return res.status(400).json({ error: 'Player already drafted' });

    const pick = {
      overall: currentPickIndex + 1,
      round: currentPick.round,
      pickInRound: currentPick.pickInRound,
      managerId: currentPick.managerId,
      managerName: currentPick.managerName,
      playerId: String(playerId),
      timestamp: new Date().toISOString()
    };

    const newPicks = [...league.draftPicks, pick];
    const draftComplete = newPicks.length >= snakePicks.length;

    await pool.query(
      'UPDATE leagues SET draft_picks = $1, draft_open = $2, draft_complete = $3 WHERE id = $4',
      [JSON.stringify(newPicks), draftComplete ? false : league.draftOpen, draftComplete, req.params.id]
    );

    res.json({ success: true, pick });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Undo last pick
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
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leagues/:id/swap-pick', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });

    const { outPlayerId, inPlayerId, managerId } = req.body;
    if (!outPlayerId || !inPlayerId || !managerId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const picks = [...league.draftPicks];

    const pickIndex = picks.findIndex(p => String(p.playerId) === String(outPlayerId) && p.managerId === managerId);
    if (pickIndex === -1) return res.status(404).json({ error: 'Pick not found for this manager' });

    const alreadyDrafted = picks.find(p => String(p.playerId) === String(inPlayerId));
    if (alreadyDrafted) return res.status(400).json({ error: 'Replacement player already drafted' });

    picks[pickIndex] = { ...picks[pickIndex], playerId: String(inPlayerId) };

    await pool.query(
      'UPDATE leagues SET draft_picks = $1 WHERE id = $2',
      [JSON.stringify(picks), req.params.id]
    );

    res.json({ success: true, picks });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Add manual stat
app.post('/api/leagues/:id/manual-stat', async (req, res) => {
  try {
    const league = await getLeague(req.params.id);
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });

    const { playerId, stage, statType, value, note } = req.body;
    const newStat = { playerId, stage, statType, value, note, addedAt: new Date().toISOString() };
    const newStats = [...league.manualStats, newStat];

    await pool.query(
      'UPDATE leagues SET manual_stats = $1 WHERE id = $2',
      [JSON.stringify(newStats), req.params.id]
    );

    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// API-FOOTBALL ROUTES
// =============================================

app.get('/api/football/players', async (req, res) => {
  try {
    const { league, season, page = 1 } = req.query;
    const data = await apiFootball('/players', { league, season, page });
    res.json(data);
  } catch(e) {
    sendApiFootballError(res, e);
  }
});

app.get('/api/football/players/squads', async (req, res) => {
  try {
    const { team } = req.query;
    const data = await apiFootball('/players/squads', { team });
    res.json(data);
  } catch(e) {
    sendApiFootballError(res, e);
  }
});

app.get('/api/football/fixtures', async (req, res) => {
  try {
    const { league, season } = req.query;
    const data = await apiFootball('/fixtures', { league, season });
    res.json(data);
  } catch(e) {
    sendApiFootballError(res, e);
  }
});

app.get('/api/football/fixture/:fixtureId', async (req, res) => {
  try {
    const [events, stats] = await Promise.all([
      apiFootball('/fixtures/events', { fixture: req.params.fixtureId }),
      apiFootball('/fixtures/statistics', { fixture: req.params.fixtureId })
    ]);
    res.json({ events: events.response, stats: stats.response });
  } catch(e) {
    sendApiFootballError(res, e);
  }
});

app.get('/api/football/teams', async (req, res) => {
  try {
    const { league, season } = req.query;
    const data = await apiFootball('/teams', { league, season });
    res.json(data);
  } catch(e) {
    sendApiFootballError(res, e);
  }
});

app.get('/api/football/standings', async (req, res) => {
  try {
    const { league, season } = req.query;
    const data = await apiFootball('/standings', { league, season });
    res.json(data);
  } catch(e) {
    sendApiFootballError(res, e);
  }
});

// =============================================
// START
// =============================================
initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});