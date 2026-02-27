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

// API Football helper
async function apiFootball(endpoint, params = {}) {
  const response = await axios.get(`${API_BASE}${endpoint}`, {
    headers: { 'x-apisports-key': API_KEY },
    params
  });
  return response.data;
}

// =============================================
// LEAGUE MANAGEMENT
// =============================================

// In-memory store (we'll move to a database later)
let leagues = {};
let nextLeagueId = 1;

// Create a new league
app.post('/api/leagues', (req, res) => {
  const { name, managerCount, competition } = req.body;
  if (!name || !managerCount || !competition) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (managerCount % 2 !== 0 || managerCount < 8 || managerCount > 14) {
    return res.status(400).json({ error: 'Manager count must be even, between 8 and 14' });
  }

  const leagueId = nextLeagueId++;
  const adminToken = generateToken();
  const inviteLinks = [];

  for (let i = 0; i < managerCount; i++) {
    inviteLinks.push({ slot: i + 1, token: generateToken(), managerId: null, managerName: null, teamName: null });
  }

  leagues[leagueId] = {
    id: leagueId,
    name,
    managerCount,
    competition,
    adminToken,
    inviteLinks,
    draftOrder: [],
    draftPicks: [],
    draftOpen: false,
    draftComplete: false,
    rosters: {},
    manualStats: {},
    createdAt: new Date().toISOString()
  };

  res.json({ leagueId, adminToken, inviteLinks: inviteLinks.map(l => ({ slot: l.slot, token: l.token })) });
});

// Get league (public info)
app.get('/api/leagues/:id', (req, res) => {
  const league = leagues[req.params.id];
  if (!league) return res.status(404).json({ error: 'League not found' });
  res.json(sanitizeLeague(league));
});

// Admin: get full league info
app.get('/api/leagues/:id/admin', (req, res) => {
  const league = leagues[req.params.id];
  if (!league) return res.status(404).json({ error: 'League not found' });
  if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
  res.json(league);
});

// Manager joins via invite link
app.post('/api/leagues/:id/join', (req, res) => {
  const league = leagues[req.params.id];
  if (!league) return res.status(404).json({ error: 'League not found' });
  const { token, managerName, teamName } = req.body;
  const slot = league.inviteLinks.find(l => l.token === token);
  if (!slot) return res.status(404).json({ error: 'Invalid invite link' });
  if (slot.managerId) return res.status(400).json({ error: 'This slot is already taken' });

  slot.managerId = generateToken();
  slot.managerName = managerName;
  slot.teamName = teamName;

  res.json({ managerId: slot.managerId, managerName, teamName, slot: slot.slot });
});

// Admin: set draft order
app.post('/api/leagues/:id/draft-order', (req, res) => {
  const league = leagues[req.params.id];
  if (!league) return res.status(404).json({ error: 'League not found' });
  if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
  league.draftOrder = req.body.order;
  res.json({ success: true });
});

// Admin: open/close draft
app.post('/api/leagues/:id/draft-status', (req, res) => {
  const league = leagues[req.params.id];
  if (!league) return res.status(404).json({ error: 'League not found' });
  if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
  league.draftOpen = req.body.open;
  res.json({ success: true, draftOpen: league.draftOpen });
});

// Make a draft pick
app.post('/api/leagues/:id/pick', (req, res) => {
  const league = leagues[req.params.id];
  if (!league) return res.status(404).json({ error: 'League not found' });
  if (!league.draftOpen) return res.status(400).json({ error: 'Draft is not open' });

  const { managerId, playerId, adminOverride } = req.body;
  const isAdmin = req.headers['x-admin-token'] === league.adminToken;

  // Figure out whose turn it is
  const currentPickIndex = league.draftPicks.length;
  const snakePicks = generateSnakePicks(league.draftOrder, 8);
  if (currentPickIndex >= snakePicks.length) return res.status(400).json({ error: 'Draft is complete' });

  const currentPick = snakePicks[currentPickIndex];

  // Verify it's this manager's turn (or admin override)
  if (!isAdmin && currentPick.managerId !== managerId) {
    return res.status(403).json({ error: 'Not your turn' });
  }

  // Check player not already drafted
  const alreadyDrafted = league.draftPicks.find(p => p.playerId === playerId);
  if (alreadyDrafted) return res.status(400).json({ error: 'Player already drafted' });

  const pick = {
    overall: currentPickIndex + 1,
    round: currentPick.round,
    pickInRound: currentPick.pickInRound,
    managerId: currentPick.managerId,
    managerName: currentPick.managerName,
    playerId,
    timestamp: new Date().toISOString()
  };

  league.draftPicks.push(pick);

  // Check if draft complete
  if (league.draftPicks.length >= snakePicks.length) {
    league.draftOpen = false;
    league.draftComplete = true;
  }

  res.json({ success: true, pick });
});

// Admin: override/undo last pick
app.delete('/api/leagues/:id/pick', (req, res) => {
  const league = leagues[req.params.id];
  if (!league) return res.status(404).json({ error: 'League not found' });
  if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });
  if (league.draftPicks.length === 0) return res.status(400).json({ error: 'No picks to undo' });
  const undone = league.draftPicks.pop();
  res.json({ success: true, undone });
});

// Admin: add manual stat (penalty drawn, corrections)
app.post('/api/leagues/:id/manual-stat', (req, res) => {
  const league = leagues[req.params.id];
  if (!league) return res.status(404).json({ error: 'League not found' });
  if (req.headers['x-admin-token'] !== league.adminToken) return res.status(403).json({ error: 'Unauthorized' });

  const { playerId, stage, statType, value, note } = req.body;
  const key = `${playerId}-${stage}`;
  if (!league.manualStats[key]) league.manualStats[key] = [];
  league.manualStats[key].push({ statType, value, note, addedAt: new Date().toISOString() });

  res.json({ success: true });
});

// =============================================
// API-FOOTBALL ENDPOINTS
// =============================================

// Get players for a competition/season
app.get('/api/football/players', async (req, res) => {
  try {
    const { league, season, page = 1 } = req.query;
    const data = await apiFootball('/players', { league, season, page });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get fixtures for a competition
app.get('/api/football/fixtures', async (req, res) => {
  try {
    const { league, season } = req.query;
    const data = await apiFootball('/fixtures', { league, season });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get fixture stats (events) for a specific game
app.get('/api/football/fixture/:fixtureId', async (req, res) => {
  try {
    const [events, stats] = await Promise.all([
      apiFootball('/fixtures/events', { fixture: req.params.fixtureId }),
      apiFootball('/fixtures/statistics', { fixture: req.params.fixtureId })
    ]);
    res.json({ events: events.response, stats: stats.response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get standings
app.get('/api/football/standings', async (req, res) => {
  try {
    const { league, season } = req.query;
    const data = await apiFootball('/standings', { league, season });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get teams for a competition
app.get('/api/football/teams', async (req, res) => {
  try {
    const { league, season } = req.query;
    const data = await apiFootball('/teams', { league, season });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// SCORING ENGINE
// =============================================
app.get('/api/leagues/:id/scores', async (req, res) => {
  const league = leagues[req.params.id];
  if (!league) return res.status(404).json({ error: 'League not found' });

  try {
    const fixtures = await apiFootball('/fixtures', {
      league: league.competition.leagueId,
      season: league.competition.season
    });

    const finishedFixtures = fixtures.response.filter(f =>
      f.fixture.status.short === 'FT' || f.fixture.status.short === 'AET' || f.fixture.status.short === 'PEN'
    );

    // Score each fixture
    const scores = {};
    for (const fixture of finishedFixtures) {
      const fixtureId = fixture.fixture.id;
      const events = await apiFootball('/fixtures/events', { fixture: fixtureId });
      scores[fixtureId] = calculateFantasyPoints(events.response, fixture, league);
    }

    res.json({ scores, fixtures: finishedFixtures.map(f => ({
      id: f.fixture.id,
      home: f.teams.home.name,
      away: f.teams.away.name,
      date: f.fixture.date,
      round: f.league.round
    }))});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function calculateFantasyPoints(events, fixture, league) {
  const playerPoints = {};
  const homeTeamId = fixture.teams.home.id;
  const awayTeamId = fixture.teams.away.id;
  const homeScore = fixture.goals.home;
  const awayScore = fixture.goals.away;
  const homeWon = homeScore > awayScore;
  const awayWon = awayScore > homeScore;
  const homeCleanSheet = awayScore === 0;
  const awayCleanSheet = homeScore === 0;

  const addPoints = (playerId, pts, reason) => {
    if (!playerPoints[playerId]) playerPoints[playerId] = { points: 0, breakdown: [] };
    playerPoints[playerId].points += pts;
    playerPoints[playerId].breakdown.push({ pts, reason });
  };

  events.forEach(event => {
    const playerId = event.player?.id;
    const assistId = event.assist?.id;
    if (!playerId) return;

    if (event.type === 'Goal') {
      if (event.detail === 'Penalty') {
        addPoints(playerId, 2, 'PK Goal');
      } else if (event.detail === 'Missed Penalty') {
        addPoints(playerId, -1, 'PK Miss');
      } else {
        addPoints(playerId, 3, 'Goal');
      }
      if (assistId) addPoints(assistId, 1, 'Assist');
    }

    if (event.type === 'Card' && event.detail === 'Red Card') {
      addPoints(playerId, -2, 'Red Card');
    }
  });

  // Team defense points
  const teamDefensePoints = (teamId, won, cleanSheet) => {
    let pts = 0;
    const breakdown = [];
    if (won) { pts += 1; breakdown.push({ pts: 1, reason: 'Win' }); }
    if (cleanSheet) { pts += 2; breakdown.push({ pts: 2, reason: 'Clean Sheet' }); }
    // Red cards for team defense checked from events
    const redCards = events.filter(e => e.type === 'Card' && e.detail === 'Red Card' && e.team?.id === teamId).length;
    if (redCards > 0) { pts -= redCards; breakdown.push({ pts: -redCards, reason: `${redCards} Red Card(s)` }); }
    return { points: pts, breakdown, isTeam: true };
  };

  playerPoints[`team-${homeTeamId}`] = teamDefensePoints(homeTeamId, homeWon, homeCleanSheet);
  playerPoints[`team-${awayTeamId}`] = teamDefensePoints(awayTeamId, awayWon, awayCleanSheet);

  return playerPoints;
}

// =============================================
// HELPERS
// =============================================
function generateToken() {
  return Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
}

function generateSnakePicks(draftOrder, rounds) {
  const picks = [];
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

function sanitizeLeague(league) {
  return {
    id: league.id,
    name: league.name,
    managerCount: league.managerCount,
    competition: league.competition,
    managers: league.inviteLinks.filter(l => l.managerId).map(l => ({
      slot: l.slot,
      managerId: l.managerId,
      managerName: l.managerName,
      teamName: l.teamName
    })),
    draftOrder: league.draftOrder,
    draftPicks: league.draftPicks,
    draftOpen: league.draftOpen,
    draftComplete: league.draftComplete
  };
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));