# Live Scoring Prompt — Evaluation

## Verdict: **The prompt is sound and should succeed**, with a few clarifications and one small fix recommended before implementation.

---

## What aligns well with your codebase

1. **Player pool and scores**  
   `player_pools` has `players` and `teams` JSONB; each item already has `scores: {}`. The frontend uses `player.scores[stage]` and `defense.scores[stage]` with `STAGES = ['GS1','GS2','GS3','R32','R16','QF','SF','F']`. Writing aggregated fantasy points into those `scores` in `updatePlayerPoolScores()` matches how the app already displays totals. No frontend change needed.

2. **League → competition**  
   Leagues use `competition: { leagueId, season }`. You already resolve `leagueApiId` and `season` from that in `/api/leagues/:id/players` and refresh. Using the same pattern for `GET /api/leagues/:id/fixtures` and `POST /api/leagues/:id/seed-fixtures` is consistent.

3. **Admin auth**  
   `x-admin-token` vs `league.adminToken` is already used for admin routes. Reusing it for seed-fixtures and for a global `POST /api/admin/poll-now` (validating that the token matches any league) fits the existing model.

4. **API usage**  
   `scheduleApiFootballRequest` and the existing `apiFootball()` wrapper (with `x-apisports-key`) are the right place to hang `GET /fixtures?live=all&league=2&season=2025`, `GET /fixtures/events?fixture=ID`, and `GET /fixtures/statistics?fixture=ID`. Throttling and error handling stay in one place.

5. **Manual stats**  
   Manual stats are applied in the frontend on top of `player.scores` when computing the displayed total. Backend only writes match-derived scores into `player_pools`; manual stats stay in `league.manual_stats`. No conflict.

6. **Database design**  
   `fixtures` (with `league_api_id`, `season`, `stage`, `finalized`), `match_stats` (per fixture/player), and `team_match_stats` (per fixture/team) are coherent. Joining through `fixtures` lets `updatePlayerPoolScores(leagueApiId, season)` aggregate only that competition’s data.

---

## Clarifications and recommendations

### 1. Only process fixtures that exist in your DB (recommended)

The prompt says: fetch live fixtures, then for each apply elapsed-based filtering and, if not finalized, call events/statistics.

**Recommendation:** Only run that logic for fixtures that already exist in your `fixtures` table (from seed-fixtures). If a live fixture returned by the API is not in your table, skip it. That way:

- You only score fixtures you’ve explicitly seeded for the competition.
- You always have `stage` (R16/QF/SF/F) from your own data.
- You avoid guessing stage from the live response and keep one source of truth.

So in Step 2, add: “If the fixture id is not in the `fixtures` table, skip it.”

### 2. Poller scope (league/season)

The prompt hardcodes `league=2&season=2025` in the poll. That’s fine for a first version. Later you can:

- Run the poller for multiple `(league_api_id, season)` (e.g. from a config or from distinct rows in `fixtures`), or
- Keep a single poll and only seed/process UCL for now.

No change required for the first iteration.

### 3. `updatePlayerPoolScores` — which competitions to update

The prompt says: after updating `match_stats`, call `updatePlayerPoolScores(leagueApiId, season)`.

For a single poll with `league=2&season=2025`, calling `updatePlayerPoolScores(2, 2025)` once at the end is enough. If you later support multiple competitions in one poll run, call it once per distinct `(league_api_id, season)` that had fixture updates.

### 4. POST /api/admin/poll-now — how to authorize

“Use x-admin-token from any valid league” can be implemented as:

- Require header `x-admin-token`.
- `SELECT id FROM leagues WHERE admin_token = $1 LIMIT 1`.
- If a row exists, treat as admin and run `pollLiveFixtures()` (once); otherwise 403.

No league id in the URL is required.

### 5. Team defense — “2 pts minimum” for shootout loser with clean sheet

The rule “A shootout loss with 0 goals allowed still counts as a clean sheet (2 pts minimum)” is a bit ambiguous:

- Interpret as: for the team that **loses** the shootout, if they allowed 0 goals in open play (RT+ET), give **2 pts** (same as draw + clean sheet), not 0. So “minimum” means the loser still gets 2 when they kept a clean sheet.

Implementing it that way is consistent with “clean sheet from RT+ET only” and “shootout winner = Win for scoring”.

### 6. Upsert semantics for match_stats / team_match_stats

Re-fetching events and statistics on each poll and then “upserting” should mean:

- Recompute per-player stats from the **full** events list for that fixture.
- Recompute per-team stats from the **full** statistics for that fixture.
- Upsert one row per `(fixture_id, player_id)` and per `(fixture_id, team_api_id)` with the new totals.

So you replace the row each time, avoiding double-counting. The prompt’s “upsert” fits that.

### 7. API-Football season and round strings

You already noted: confirm with API-Football that the current UCL season is 2025 (e.g. `GET /leagues?id=2`). If it’s 2024, change the three `2025` references (poll, seed-fixtures, and any `updatePlayerPoolScores(2, 2025)`).

Also confirm the **round** strings in the API response (e.g. `"Round of 16"`, `"Quarter-finals"`) match exactly what you use in `STAGE_MAP`. If the API returns different wording (e.g. “Round of 16” vs “Round 16”), the map must match the API.

### 8. Polling interval and elapsed-based filtering (updated)

**API plan:** 7,500 requests/day — enough for live updates every minute during matchdays (UCL: 1–2 games/day; World Cup group stage: 4 games/day).

**Use this in the implementation (replace any “10 minutes” / “elapsed 10 / 55” spec):**

- **Interval:** Run `pollLiveFixtures()` every **1 minute** (`setInterval(pollLiveFixtures, 60 * 1000)`), and call it once on startup.
- **Elapsed-based filtering — when to start pulling:**
  - **Status NS** → skip.
  - **Status HT** → skip.
  - **Status 1H** → process only when **elapsed ≥ 1** (i.e. 1 minute after kickoff). Skip if elapsed &lt; 1.
  - **Status 2H** → process only when **elapsed ≥ 47** (i.e. 1 minute after second-half kickoff; second half starts at 46). Skip if elapsed &lt; 47.
  - **Status ET, P** → process (extra time / penalties in progress).
  - **Status FT, AET, PEN** → process as final, then set `finalized = true`.

So the first pull happens at 1′ in the first half and at 47′ in the second half; then every minute after that until the fixture is finalized.

---

## What to leave unchanged (as in the prompt)

- Frontend (`index.html`), draft, queue, player pool fetch, and existing routes.
- `getOrCreatePlayerPool` / `refreshPlayerPool` behavior; only the `scores` inside existing player/team objects are updated.
- Rate limiting and throttle queue logic.

---

## Summary

- **Makes sense:** Yes. The flow (seed fixtures → poll live → events + statistics → match_stats + team_match_stats → updatePlayerPoolScores → same player_pool the frontend already uses) is consistent and should work.
- **Will succeed:** Yes, if you (1) only process live fixtures that exist in `fixtures`, (2) verify UCL season (2024 vs 2025) and round strings before going live, and (3) implement the “2 pts minimum” for shootout loser with clean sheet as above.
- **Polling:** With a 7,500 req/day API plan, use a **1-minute** poll interval and start pulling **1 minute after kickoff** (1H, elapsed ≥ 1) and **1 minute after second-half kickoff** (2H, elapsed ≥ 47). See §8 above.

Adding the “only process fixtures present in `fixtures`” rule is the main change to the prompt; the rest are implementation clarifications and checks.
