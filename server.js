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
    `);
    console.log('Database initialized');
  } catch(e) {
    console.error('DB init error:', e.message);
  }
}

// =============================================
// API FOOTBALL HELPER
// =============================================
async function apiFootball(endpoint, params = {}) {
  const response = await axios.get(`${API_BASE}${endpoint}`, {
    headers: { 'x-apisports-key': API_KEY },
    params
  });
  return response.data;
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

    const inviteLinks = [];
    for (let i = 0; i < managerCount; i++) {
      const token = generateToken();
      await pool.query(
        `INSERT INTO league_slots (league_id, slot, token) VALUES ($1, $2, $3)`,
        [leagueId, i + 1, token]
      );
      inviteLinks.push({ slot: i + 1, token });
    }

    res.json({ leagueId, adminToken, inviteLinks });
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
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/football/players/squads', async (req, res) => {
  try {
    const { team } = req.query;
    const data = await apiFootball('/players/squads', { team });
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/football/fixtures', async (req, res) => {
  try {
    const { league, season } = req.query;
    const data = await apiFootball('/fixtures', { league, season });
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/football/teams', async (req, res) => {
  try {
    const { league, season } = req.query;
    const data = await apiFootball('/teams', { league, season });
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/football/standings', async (req, res) => {
  try {
    const { league, season } = req.query;
    const data = await apiFootball('/standings', { league, season });
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// START
// =============================================
initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});