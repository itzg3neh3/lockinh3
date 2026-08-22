// Lock in H3 — Cloudflare Worker
const ALLOWED_ORIGIN = 'https://itzg3neh3.github.io';
const MAX_SNAPSHOTS = 10;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-App-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

function randomId(len = 6) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let id = '';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  arr.forEach(b => id += chars[b % chars.length]);
  return id;
}

function normalizeName(name) {
  return (name || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
}

async function createFingerprint(games) {
  const parts = games.map(g => {
    const allPlayers = [...(g.redTeam || []), ...(g.blueTeam || [])];
    const playerStr = allPlayers
      .map(p => `${normalizeName(p.name)}:${p.kills||0}:${p.deaths||0}:${p.assists||0}`)
      .sort()
      .join('|');
    return `${g.gameType||''}:${g.winner||''}:${playerStr}`;
  });
  return parts.sort().join('||');
}

async function hashString(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function generateAdminToken(env) {
  return await hashString((env.ADMIN_PASSWORD || '') + ':mcc-admin-session-2026');
}

async function generateAppToken(env) {
  return await hashString((env.APP_PASSWORD || '') + ':mcc-app-session-2026');
}

async function validateAdminToken(request, env) {
  const token = request.headers.get('X-Admin-Token');
  if (!token) return false;
  const expected = await generateAdminToken(env);
  return token === expected;
}

function parseTimeSecs(t) {
  if (t === null || t === undefined || t === 'null' || t === '') return 0;
  const s = String(t).trim();
  if (s.includes(':')) {
    const parts = s.split(':');
    return parseInt(parts[0] || 0) * 60 + parseInt(parts[1] || 0);
  }
  return parseInt(s) || 0;
}

function lbKey(mode) {
  if (mode === '2v2') return 'leaderboard:2v2';
  if (mode === '1v1') return 'leaderboard:1v1';
  return 'leaderboard:alltime';
}

function snapshotPrefix(mode) {
  if (mode === '2v2') return 'snapshot2v2:';
  if (mode === '1v1') return 'snapshot1v1:';
  return 'snapshot:';
}

async function saveSnapshot(leaderboard, env, mode) {
  const timestamp = new Date().toISOString();
  const prefix = snapshotPrefix(mode);
  const snapshotKey = `${prefix}${timestamp}`;
  await env.REPORTS.put(snapshotKey, JSON.stringify({ timestamp, data: leaderboard }), {
    expirationTtl: 60 * 60 * 24 * 365,
  });
  const list = await env.REPORTS.list({ prefix });
  const keys = list.keys.map(k => k.name).sort();
  if (keys.length > MAX_SNAPSHOTS) {
    const toDelete = keys.slice(0, keys.length - MAX_SNAPSHOTS);
    await Promise.all(toDelete.map(k => env.REPORTS.delete(k)));
  }
}

async function saveHistoryEntry(games, seriesWinner, mode, reportId, playedAt, env) {
  const g1 = games[0];
  const squad1 = (g1.redTeam || []).map(p => p.name).filter(Boolean);
  const squad2 = (g1.blueTeam || []).map(p => p.name).filter(Boolean);

  let s1Wins = 0, s2Wins = 0;
  games.forEach(g => {
    const wt = g.winner === 'Red' ? (g.redTeam || []) : (g.blueTeam || []);
    if (wt.length > 0) {
      const firstName = wt[0].name;
      const inSquad1 = squad1.some(n => n && firstName && n.toLowerCase() === firstName.toLowerCase());
      if (inSquad1) s1Wins++; else s2Wins++;
    }
  });

  const timestamp = playedAt || new Date().toISOString();
  const historyKey = `history:${timestamp}:${reportId}`;
  const entry = {
    reportId,
    reportUrl: `https://itzg3neh3.github.io/lockinh3/?r=${reportId}`,
    playedAt: timestamp,
    mode: mode || '4v4',
    squad1,
    squad2,
    squad1Wins: s1Wins,
    squad2Wins: s2Wins,
    seriesWinner,
    gamesPlayed: games.length,
    gameTypes: games.map(g => g.gameType || 'Unknown'),
  };

  await env.REPORTS.put(historyKey, JSON.stringify(entry), {
    expirationTtl: 60 * 60 * 24 * 365 * 2,
  });

  return entry;
}

// ─────────────────────────────────────────────────────────────────────────
// Award calculation — ported from the same logic used on the report page,
// so History backfill and live series submissions both use one consistent
// source of truth. Only applies to 4v4 and 2v2 (1v1 has no award system).
// ─────────────────────────────────────────────────────────────────────────

function isOddballW(gt) { return !!(gt || '').toLowerCase().match(/oddball|ball/); }
function isCTFW(gt) { const g = (gt || '').toLowerCase(); return !!(g.match(/ctf|flag|5flag/) || (g.includes('30') && !g.includes('ball'))); }
function isKOTHW(gt) { return !!(gt || '').toLowerCase().match(/king|hill|koth/); }

function buildSquadsW(games) {
  if (!games.length) return { squad1: new Set(), squad2: new Set() };
  const g1 = games[0];
  return {
    squad1: new Set((g1.redTeam || []).map(p => p.name).filter(Boolean)),
    squad2: new Set((g1.blueTeam || []).map(p => p.name).filter(Boolean)),
  };
}

function getSquadW(name, squad1, squad2) {
  if (squad1.has(name)) return 1;
  if (squad2.has(name)) return 2;
  for (const n of squad1) { if (n && name && n.toLowerCase() === name.toLowerCase()) return 1; }
  for (const n of squad2) { if (n && name && n.toLowerCase() === name.toLowerCase()) return 2; }
  return 1;
}

function aggregatePlayersW(games, squad1, squad2) {
  const agg = {};
  games.forEach(g => {
    const all = [...(g.redTeam || []).map(p => ({ ...p })), ...(g.blueTeam || []).map(p => ({ ...p }))];
    all.forEach(p => {
      if (!p.name) return;
      const sq = getSquadW(p.name, squad1, squad2);
      if (!agg[p.name]) agg[p.name] = { name: p.name, squad: sq, kills: 0, deaths: 0, assists: 0, ballSecs: 0, flagCaps: 0, hillSecs: 0 };
      const a = agg[p.name];
      a.kills += p.kills || 0;
      a.deaths += p.deaths || 0;
      a.assists += p.assists || 0;
      a.ballSecs += parseTimeSecs(p.ballTime);
      a.flagCaps += p.flagCaps || 0;
      a.hillSecs += parseTimeSecs(p.hillTime);
    });
  });
  return Object.values(agg);
}

// Best (Series MVP) and worst (Top Shitter) via the same weighted formula used
// in index.html: 40% KDA + 30% +/- + 20% K/D + 10% OBJ (equal-weighted across
// flag caps / hill time / ball time), falling back to 45/35/20 when a series
// has no OBJ games at all (which is always true for 2v2, since it's Slayer-only).
function calcSeriesExtremesW(players) {
  if (!players.length) return { best: null, worst: null };
  const kdas = players.map(p => p.deaths > 0 ? (p.kills + p.assists) / p.deaths : (p.kills + p.assists));
  const pms = players.map(p => p.kills - p.deaths);
  const kds = players.map(p => p.deaths > 0 ? p.kills / p.deaths : p.kills);
  const minVal = arr => Math.min(...arr), maxVal = arr => Math.max(...arr);
  const normalize = (v, mn, mx) => mx === mn ? 0.5 : (v - mn) / (mx - mn);
  const kdaMin = minVal(kdas), kdaMax = maxVal(kdas);
  const pmMin = minVal(pms), pmMax = maxVal(pms);
  const kdMin = minVal(kds), kdMax = maxVal(kds);
  const tb = players.reduce((s, p) => s + p.ballSecs, 0);
  const tc = players.reduce((s, p) => s + p.flagCaps, 0);
  const th = players.reduce((s, p) => s + p.hillSecs, 0);
  const hasObj = tb > 0 || tc > 0 || th > 0;
  const objScores = players.map(p => {
    if (!hasObj) return 0;
    let ws = 0, tw = 0;
    if (tb > 0) { ws += p.ballSecs / tb * 1; tw += 1; }
    if (tc > 0) { ws += p.flagCaps / tc * 1; tw += 1; }
    if (th > 0) { ws += p.hillSecs / th * 1; tw += 1; }
    return tw > 0 ? ws / tw : 0;
  });
  const objMin = minVal(objScores), objMax = maxVal(objScores);
  let best = null, bestScore = -Infinity, worst = null, worstScore = Infinity;
  players.forEach((p, i) => {
    const nKDA = normalize(kdas[i], kdaMin, kdaMax);
    const nPM = normalize(pms[i], pmMin, pmMax);
    const nKD = normalize(kds[i], kdMin, kdMax);
    const nObj = hasObj ? normalize(objScores[i], objMin, objMax) : 0;
    const score = hasObj ? nKDA * 0.4 + nPM * 0.3 + nKD * 0.2 + nObj * 0.1 : nKDA * 0.45 + nPM * 0.35 + nKD * 0.2;
    if (score > bestScore) { bestScore = score; best = p; }
    if (score < worstScore) { worstScore = score; worst = p; }
  });
  return { best, worst };
}

// OBJ MVP — flag caps, hill time, and ball time weighted equally (1x each).
function calcObjMVPW(players, games) {
  const hasObjGames = games.some(g => isOddballW(g.gameType) || isCTFW(g.gameType) || isKOTHW(g.gameType));
  if (!hasObjGames) return null;
  const tb = players.reduce((s, p) => s + p.ballSecs, 0);
  const tc = players.reduce((s, p) => s + p.flagCaps, 0);
  const th = players.reduce((s, p) => s + p.hillSecs, 0);
  let best = null, bestScore = -1;
  players.forEach(p => {
    let ws = 0, tw = 0;
    if (tb > 0) { ws += p.ballSecs / tb * 1; tw += 1; }
    if (tc > 0) { ws += p.flagCaps / tc * 1; tw += 1; }
    if (th > 0) { ws += p.hillSecs / th * 1; tw += 1; }
    if (!tw) return;
    const score = ws / tw;
    if (score > bestScore) { bestScore = score; best = p; }
  });
  return best;
}

// Returns the winner name (or null) for each award in a single series.
// Series MVP and OBJ MVP only apply to 4v4; Top Fragger, Top Shitter, and
// Assist King apply to both 4v4 and 2v2. Awards are computed regardless of
// whether the series itself ended in a win, loss, or tie.
function computeAwardsForSeries(games, mode) {
  const empty = { seriesMVP: null, topFragger: null, topShitter: null, assistKing: null, objMVP: null };
  if (mode === '1v1' || !games || !games.length) return empty;

  const { squad1, squad2 } = buildSquadsW(games);
  const players = aggregatePlayersW(games, squad1, squad2);
  if (!players.length) return empty;

  const extremes = calcSeriesExtremesW(players);
  const topFragger = [...players].sort((a, b) => b.kills - a.kills)[0] || null;
  const assistKing = [...players].sort((a, b) => b.assists - a.assists || b.kills - a.kills)[0] || null;
  const objMVP = mode === '4v4' ? calcObjMVPW(players, games) : null;
  const seriesMVP = mode === '4v4' ? extremes.best : null;
  const topShitter = extremes.worst;

  return {
    seriesMVP: seriesMVP ? seriesMVP.name : null,
    topFragger: topFragger ? topFragger.name : null,
    topShitter: topShitter ? topShitter.name : null,
    assistKing: assistKing ? assistKing.name : null,
    objMVP: objMVP ? objMVP.name : null,
  };
}

function bumpAwardCount(leaderboard, name, field) {
  if (!name) return;
  const key = normalizeName(name);
  if (!leaderboard[key]) return;
  if (leaderboard[key][field] === undefined) leaderboard[key][field] = 0;
  leaderboard[key][field] += 1;
}

async function mergeSeriesIntoLeaderboard(games, seriesWinner, env, mode) {
  const key = lbKey(mode);
  const lbRaw = await env.REPORTS.get(key);
  const leaderboard = lbRaw ? JSON.parse(lbRaw) : {};

  const g1 = games[0];
  const squad1Names = new Set((g1.redTeam || []).map(p => normalizeName(p.name)).filter(Boolean));
  const squad2Names = new Set((g1.blueTeam || []).map(p => normalizeName(p.name)).filter(Boolean));
  const winningSquadNames = seriesWinner === 1 ? squad1Names : squad2Names;
  const losingSquadNames = seriesWinner === 1 ? squad2Names : squad1Names;

  const playerStats = {};
  games.forEach(g => {
    const allPlayers = [
      ...(g.redTeam || []).map(p => ({ ...p })),
      ...(g.blueTeam || []).map(p => ({ ...p }))
    ];
    allPlayers.forEach(p => {
      if (!p.name) return;
      const pKey = normalizeName(p.name);
      if (!playerStats[pKey]) playerStats[pKey] = {
        displayName: p.name,
        kills: 0, deaths: 0, assists: 0,
        flagCaps: 0, hillSecs: 0, ballSecs: 0
      };
      const s = playerStats[pKey];
      s.kills += p.kills || 0;
      s.deaths += p.deaths || 0;
      s.assists += p.assists || 0;
      s.flagCaps += p.flagCaps || 0;
      s.hillSecs += parseTimeSecs(p.hillTime);
      s.ballSecs += parseTimeSecs(p.ballTime);
    });
  });

  Object.entries(playerStats).forEach(([pKey, stats]) => {
    if (!leaderboard[pKey]) {
      leaderboard[pKey] = {
        displayName: stats.displayName,
        seriesPlayed: 0, seriesWon: 0, seriesLost: 0, seriesTied: 0,
        kills: 0, deaths: 0, assists: 0,
        flagCaps: 0, hillSecs: 0, ballSecs: 0,
        seriesMVPCount: 0, topFraggerCount: 0, topShitterCount: 0, assistKingCount: 0, objMVPCount: 0
      };
    }
    const lb = leaderboard[pKey];
    // Backward compatibility for older entries missing newer fields
    if (lb.seriesTied === undefined) lb.seriesTied = 0;
    if (lb.seriesMVPCount === undefined) lb.seriesMVPCount = 0;
    if (lb.topFraggerCount === undefined) lb.topFraggerCount = 0;
    if (lb.topShitterCount === undefined) lb.topShitterCount = 0;
    if (lb.assistKingCount === undefined) lb.assistKingCount = 0;
    if (lb.objMVPCount === undefined) lb.objMVPCount = 0;

    lb.displayName = stats.displayName;
    lb.seriesPlayed += 1;
    if (mode === '1v1' && seriesWinner === 0) {
      lb.seriesTied += 1;
    } else if (winningSquadNames.has(pKey)) {
      lb.seriesWon += 1;
    } else if (losingSquadNames.has(pKey)) {
      lb.seriesLost += 1;
    }
    lb.kills += stats.kills;
    lb.deaths += stats.deaths;
    lb.assists += stats.assists;
    lb.flagCaps += stats.flagCaps;
    lb.hillSecs += stats.hillSecs;
    lb.ballSecs += stats.ballSecs;
  });

  // Tally awards for this series into each player's running totals
  if (mode !== '1v1') {
    const awards = computeAwardsForSeries(games, mode);
    if (mode === '4v4') {
      bumpAwardCount(leaderboard, awards.seriesMVP, 'seriesMVPCount');
      bumpAwardCount(leaderboard, awards.objMVP, 'objMVPCount');
    }
    bumpAwardCount(leaderboard, awards.topFragger, 'topFraggerCount');
    bumpAwardCount(leaderboard, awards.topShitter, 'topShitterCount');
    bumpAwardCount(leaderboard, awards.assistKing, 'assistKingCount');
  }

  await env.REPORTS.put(key, JSON.stringify(leaderboard));
  return leaderboard;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors(origin) });
    }

    if (origin !== ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403 });
    }

    // ── POST /app/auth ───────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/app/auth') {
      try {
        const { password } = await request.json();
        if (!password) return jsonResponse({ error: 'No password provided' }, 400, origin);
        if (password !== env.APP_PASSWORD) return jsonResponse({ error: 'Incorrect password' }, 401, origin);
        const token = await generateAppToken(env);
        return jsonResponse({ token }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /admin/auth ─────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/admin/auth') {
      try {
        const { password } = await request.json();
        if (!password) return jsonResponse({ error: 'No password provided' }, 400, origin);
        if (password !== env.ADMIN_PASSWORD) return jsonResponse({ error: 'Incorrect password' }, 401, origin);
        const token = await generateAdminToken(env);
        return jsonResponse({ token }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /analyze ────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/analyze') {
      try {
        const body = await request.json();
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        return jsonResponse(data, resp.status, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /save ───────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/save') {
      try {
        const body = await request.text();
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed)) throw new Error('Invalid data');
        if (body.length > 512 * 1024) throw new Error('Data too large');
        let id, attempts = 0;
        do {
          id = randomId(6);
          const existing = await env.REPORTS.get(id);
          if (!existing) break;
          attempts++;
        } while (attempts < 5);
        await env.REPORTS.put(id, body, { expirationTtl: 60 * 60 * 24 * 90 });
        return jsonResponse({ id }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── GET /report ──────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/report') {
      const id = url.searchParams.get('id');
      if (!id || !/^[a-z2-9]{4,10}$/.test(id)) {
        return jsonResponse({ error: 'Invalid ID' }, 400, origin);
      }
      try {
        const data = await env.REPORTS.get(id);
        if (!data) return jsonResponse({ error: 'Report not found' }, 404, origin);
        return jsonResponse(JSON.parse(data), 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /leaderboard/save ───────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/leaderboard/save') {
      try {
        const { games, seriesWinner, force, mode } = await request.json();
        if (!Array.isArray(games)) throw new Error('Invalid data');
        const resolvedMode = mode === '2v2' ? '2v2' : mode === '1v1' ? '1v1' : '4v4';

        const fingerprint = await createFingerprint(games);
        const hash = await hashString(fingerprint);
        const fpKey = `fp:${resolvedMode}:${hash}`;

        if (!force) {
          const existing = await env.REPORTS.get(fpKey);
          if (existing) {
            return jsonResponse({ status: 'duplicate', message: 'Series already counted' }, 200, origin);
          }
        }

        const leaderboard = await mergeSeriesIntoLeaderboard(games, seriesWinner, env, resolvedMode);
        await saveSnapshot(leaderboard, env, resolvedMode);
        await env.REPORTS.put(fpKey, '1', { expirationTtl: 60 * 60 * 24 * 365 * 2 });

        const reportBody = JSON.stringify(games);
        let reportId;
        let attempts = 0;
        do {
          reportId = randomId(6);
          const existing = await env.REPORTS.get(reportId);
          if (!existing) break;
          attempts++;
        } while (attempts < 5);
        await env.REPORTS.put(reportId, reportBody, { expirationTtl: 60 * 60 * 24 * 365 * 2 });
        await saveHistoryEntry(games, seriesWinner, resolvedMode, reportId, new Date().toISOString(), env);

        return jsonResponse({ status: 'saved', reportId }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── GET /leaderboard ─────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/leaderboard') {
      try {
        const mode = url.searchParams.get('mode') === '2v2' ? '2v2' : url.searchParams.get('mode') === '1v1' ? '1v1' : '4v4';
        const data = await env.REPORTS.get(lbKey(mode));
        if (!data) return jsonResponse({}, 200, origin);
        return jsonResponse(JSON.parse(data), 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── GET /leaderboard/snapshots ───────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/leaderboard/snapshots') {
      if (!await validateAdminToken(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      try {
        const mode = url.searchParams.get('mode') === '2v2' ? '2v2' : url.searchParams.get('mode') === '1v1' ? '1v1' : '4v4';
        const prefix = snapshotPrefix(mode);
        const list = await env.REPORTS.list({ prefix });
        const snapshots = list.keys
          .map(k => ({ key: k.name, timestamp: k.name.replace(prefix, '') }))
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return jsonResponse({ snapshots }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /leaderboard/restore ────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/leaderboard/restore') {
      if (!await validateAdminToken(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      try {
        const { key, mode } = await request.json();
        const resolvedMode = mode === '2v2' ? '2v2' : mode === '1v1' ? '1v1' : '4v4';
        if (!key || (!key.startsWith('snapshot:') && !key.startsWith('snapshot2v2:') && !key.startsWith('snapshot1v1:'))) throw new Error('Invalid snapshot key');
        const snapshotRaw = await env.REPORTS.get(key);
        if (!snapshotRaw) throw new Error('Snapshot not found');
        const snapshot = JSON.parse(snapshotRaw);
        await env.REPORTS.put(lbKey(resolvedMode), JSON.stringify(snapshot.data));
        return jsonResponse({ status: 'restored', timestamp: snapshot.timestamp }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /leaderboard/edit ───────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/leaderboard/edit') {
      if (!await validateAdminToken(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      try {
        const { key, stats, mode } = await request.json();
        if (!key || !stats) throw new Error('key and stats required');
        const resolvedMode = mode === '2v2' ? '2v2' : mode === '1v1' ? '1v1' : '4v4';
        const lbRaw = await env.REPORTS.get(lbKey(resolvedMode));
        if (!lbRaw) throw new Error('Leaderboard is empty');
        const leaderboard = JSON.parse(lbRaw);
        if (!leaderboard[key]) throw new Error(`Player "${key}" not found`);
        leaderboard[key].seriesPlayed = stats.seriesPlayed;
        leaderboard[key].seriesWon = stats.seriesWon;
        leaderboard[key].seriesLost = stats.seriesLost;
        leaderboard[key].seriesTied = stats.seriesTied || 0;
        leaderboard[key].kills = stats.kills;
        leaderboard[key].deaths = stats.deaths;
        leaderboard[key].assists = stats.assists;
        leaderboard[key].flagCaps = stats.flagCaps;
        leaderboard[key].hillSecs = stats.hillSecs;
        leaderboard[key].ballSecs = stats.ballSecs;
        // Award counts are only overwritten if explicitly provided, so editing
        // other stats never accidentally wipes a player's award history.
        if (stats.seriesMVPCount !== undefined) leaderboard[key].seriesMVPCount = stats.seriesMVPCount;
        if (stats.topFraggerCount !== undefined) leaderboard[key].topFraggerCount = stats.topFraggerCount;
        if (stats.topShitterCount !== undefined) leaderboard[key].topShitterCount = stats.topShitterCount;
        if (stats.assistKingCount !== undefined) leaderboard[key].assistKingCount = stats.assistKingCount;
        if (stats.objMVPCount !== undefined) leaderboard[key].objMVPCount = stats.objMVPCount;
        await env.REPORTS.put(lbKey(resolvedMode), JSON.stringify(leaderboard));
        await saveSnapshot(leaderboard, env, resolvedMode);
        return jsonResponse({ status: 'saved' }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /leaderboard/merge ──────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/leaderboard/merge') {
      if (!await validateAdminToken(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      try {
        const { fromKey, toKey, mode } = await request.json();
        if (!fromKey || !toKey) throw new Error('fromKey and toKey required');
        if (fromKey === toKey) throw new Error('Cannot merge a player into themselves');
        const resolvedMode = mode === '2v2' ? '2v2' : mode === '1v1' ? '1v1' : '4v4';
        const lbRaw = await env.REPORTS.get(lbKey(resolvedMode));
        if (!lbRaw) throw new Error('Leaderboard is empty');
        const leaderboard = JSON.parse(lbRaw);
        const from = leaderboard[fromKey];
        const to = leaderboard[toKey];
        if (!from) throw new Error(`Player "${fromKey}" not found`);
        if (!to) throw new Error(`Player "${toKey}" not found`);
        to.seriesPlayed += from.seriesPlayed;
        to.seriesWon += from.seriesWon;
        to.seriesLost += from.seriesLost;
        to.seriesTied = (to.seriesTied || 0) + (from.seriesTied || 0);
        to.kills += from.kills;
        to.deaths += from.deaths;
        to.assists += from.assists;
        to.flagCaps += from.flagCaps;
        to.hillSecs += from.hillSecs;
        to.ballSecs += from.ballSecs;
        to.seriesMVPCount = (to.seriesMVPCount || 0) + (from.seriesMVPCount || 0);
        to.topFraggerCount = (to.topFraggerCount || 0) + (from.topFraggerCount || 0);
        to.topShitterCount = (to.topShitterCount || 0) + (from.topShitterCount || 0);
        to.assistKingCount = (to.assistKingCount || 0) + (from.assistKingCount || 0);
        to.objMVPCount = (to.objMVPCount || 0) + (from.objMVPCount || 0);
        delete leaderboard[fromKey];
        await env.REPORTS.put(lbKey(resolvedMode), JSON.stringify(leaderboard));
        await saveSnapshot(leaderboard, env, resolvedMode);
        return jsonResponse({ status: 'merged' }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /leaderboard/delete ─────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/leaderboard/delete') {
      if (!await validateAdminToken(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      try {
        const { key, mode } = await request.json();
        if (!key) throw new Error('key required');
        const resolvedMode = mode === '2v2' ? '2v2' : mode === '1v1' ? '1v1' : '4v4';
        const lbRaw = await env.REPORTS.get(lbKey(resolvedMode));
        if (!lbRaw) throw new Error('Leaderboard is empty');
        const leaderboard = JSON.parse(lbRaw);
        if (!leaderboard[key]) throw new Error(`Player "${key}" not found`);
        delete leaderboard[key];
        await env.REPORTS.put(lbKey(resolvedMode), JSON.stringify(leaderboard));
        await saveSnapshot(leaderboard, env, resolvedMode);
        return jsonResponse({ status: 'deleted' }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /leaderboard/backfill-awards ────────────────────────────────
    // One-time (but safely re-runnable) migration: walks every stored series
    // in History for the given mode, recomputes who won each award using the
    // exact same formulas as the live report page, and stores the totals on
    // each player's leaderboard entry. Always recalculates from zero rather
    // than incrementing, so re-running it after a fix is always safe.
    if (request.method === 'POST' && url.pathname === '/leaderboard/backfill-awards') {
      if (!await validateAdminToken(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      try {
        const { mode } = await request.json();
        const resolvedMode = mode === '2v2' ? '2v2' : '4v4';
        const key = lbKey(resolvedMode);
        const lbRaw = await env.REPORTS.get(key);
        const leaderboard = lbRaw ? JSON.parse(lbRaw) : {};

        // Safety snapshot of the pre-backfill state before anything changes
        await saveSnapshot(leaderboard, env, resolvedMode);

        Object.values(leaderboard).forEach(p => {
          p.seriesMVPCount = 0;
          p.topFraggerCount = 0;
          p.topShitterCount = 0;
          p.assistKingCount = 0;
          p.objMVPCount = 0;
        });

        const list = await env.REPORTS.list({ prefix: 'history:' });
        let processed = 0, skippedNoReport = 0, skippedOtherMode = 0, skippedBadData = 0;

        for (const k of list.keys) {
          const raw = await env.REPORTS.get(k.name);
          if (!raw) continue;
          let entry;
          try { entry = JSON.parse(raw); } catch (e) { skippedBadData++; continue; }
          if ((entry.mode || '4v4') !== resolvedMode) { skippedOtherMode++; continue; }

          const reportRaw = await env.REPORTS.get(entry.reportId);
          if (!reportRaw) { skippedNoReport++; continue; }
          let games;
          try { games = JSON.parse(reportRaw); } catch (e) { skippedBadData++; continue; }
          if (!Array.isArray(games) || !games.length) { skippedBadData++; continue; }

          const awards = computeAwardsForSeries(games, resolvedMode);
          if (resolvedMode === '4v4') {
            bumpAwardCount(leaderboard, awards.seriesMVP, 'seriesMVPCount');
            bumpAwardCount(leaderboard, awards.objMVP, 'objMVPCount');
          }
          bumpAwardCount(leaderboard, awards.topFragger, 'topFraggerCount');
          bumpAwardCount(leaderboard, awards.topShitter, 'topShitterCount');
          bumpAwardCount(leaderboard, awards.assistKing, 'assistKingCount');
          processed++;
        }

        await env.REPORTS.put(key, JSON.stringify(leaderboard));
        await saveSnapshot(leaderboard, env, resolvedMode);

        return jsonResponse({
          status: 'done', mode: resolvedMode, processed,
          skippedNoReport, skippedOtherMode, skippedBadData
        }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── GET /history ─────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/history') {
      try {
        const list = await env.REPORTS.list({ prefix: 'history:' });
        const entries = [];
        for (const k of list.keys) {
          const raw = await env.REPORTS.get(k.name);
          if (raw) {
            try { entries.push(JSON.parse(raw)); } catch(e) {}
          }
        }
        entries.sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt));
        return jsonResponse({ entries }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /history/import ─────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/history/import') {
      if (!await validateAdminToken(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      try {
        const { reportUrl, playedAt, mode } = await request.json();
        if (!reportUrl || !playedAt) throw new Error('reportUrl and playedAt required');
        const match = reportUrl.match(/[?&]r=([a-z2-9]{4,10})/);
        if (!match) throw new Error('Could not extract report ID from URL');
        const reportId = match[1];
        const reportRaw = await env.REPORTS.get(reportId);
        if (!reportRaw) throw new Error(`Report "${reportId}" not found — link may have expired`);
        const games = JSON.parse(reportRaw);
        if (!Array.isArray(games)) throw new Error('Invalid report data');
        const resolvedMode = mode === '2v2' ? '2v2' : mode === '1v1' ? '1v1' : '4v4';
        const g1 = games[0];
        const squad1 = new Set((g1.redTeam || []).map(p => p.name).filter(Boolean));
        let s1Wins = 0, s2Wins = 0;
        games.forEach(g => {
          const wt = g.winner === 'Red' ? (g.redTeam || []) : (g.blueTeam || []);
          if (wt.length > 0) {
            const inSquad1 = squad1.has(wt[0].name) || [...squad1].some(n => n && wt[0].name && n.toLowerCase() === wt[0].name.toLowerCase());
            if (inSquad1) s1Wins++; else s2Wins++;
          }
        });
        const seriesWinner = s1Wins > s2Wins ? 1 : s2Wins > s1Wins ? 2 : 0;
        const list = await env.REPORTS.list({ prefix: 'history:' });
        for (const k of list.keys) {
          if (k.name.includes(reportId)) {
            return jsonResponse({ error: 'This report is already in history' }, 400, origin);
          }
        }
        const entry = await saveHistoryEntry(games, seriesWinner, resolvedMode, reportId, playedAt, env);
        return jsonResponse({ status: 'imported', entry }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /history/delete ─────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/history/delete') {
      if (!await validateAdminToken(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      try {
        const { key } = await request.json();
        if (!key) throw new Error('key required');
        await env.REPORTS.delete(key);
        return jsonResponse({ status: 'deleted' }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /history/get ────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/history/get') {
      if (!await validateAdminToken(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      try {
        const { key } = await request.json();
        if (!key) throw new Error('key required');
        const raw = await env.REPORTS.get(key);
        if (!raw) throw new Error('Entry not found');
        return jsonResponse({ entry: JSON.parse(raw) }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /history/update ─────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/history/update') {
      if (!await validateAdminToken(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      try {
        const { key, newPlayedAt, entry } = await request.json();
        if (!key || !newPlayedAt || !entry) throw new Error('key, newPlayedAt, and entry required');
        await env.REPORTS.delete(key);
        const newKey = `history:${newPlayedAt}:${entry.reportId}`;
        const updatedEntry = { ...entry, playedAt: newPlayedAt };
        await env.REPORTS.put(newKey, JSON.stringify(updatedEntry), {
          expirationTtl: 60 * 60 * 24 * 365 * 2,
        });
        return jsonResponse({ status: 'updated' }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── GET /history/players ─────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/history/players') {
      try {
        const list = await env.REPORTS.list({ prefix: 'history:' });
        const playerSet = new Set();
        for (const k of list.keys) {
          const raw = await env.REPORTS.get(k.name);
          if (raw) {
            try {
              const entry = JSON.parse(raw);
              [...(entry.squad1||[]), ...(entry.squad2||[])].forEach(n => { if (n) playerSet.add(n); });
            } catch(e) {}
          }
        }
        const players = [...playerSet].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        return jsonResponse({ players }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── GET /history/h2h ─────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/history/h2h') {
      try {
        const p1 = url.searchParams.get('p1');
        const p2 = url.searchParams.get('p2');
        if (!p1 || !p2) throw new Error('p1 and p2 required');
        const list = await env.REPORTS.list({ prefix: 'history:' });
        const asOpponents = { p1Wins: 0, p2Wins: 0, series: [] };
        const asTeammates = { wins: 0, losses: 0, series: [] };
        for (const k of list.keys) {
          const raw = await env.REPORTS.get(k.name);
          if (!raw) continue;
          try {
            const entry = JSON.parse(raw);
            const s1 = (entry.squad1 || []).map(n => n.toLowerCase());
            const s2 = (entry.squad2 || []).map(n => n.toLowerCase());
            const p1Low = p1.toLowerCase(), p2Low = p2.toLowerCase();
            const p1InS1 = s1.includes(p1Low), p1InS2 = s2.includes(p1Low);
            const p2InS1 = s1.includes(p2Low), p2InS2 = s2.includes(p2Low);
            const p1Present = p1InS1 || p1InS2, p2Present = p2InS1 || p2InS2;
            if (!p1Present || !p2Present) continue;
            const sameTeam = (p1InS1 && p2InS1) || (p1InS2 && p2InS2);
            if (sameTeam) {
              const theirSquad = p1InS1 ? 1 : 2;
              const won = entry.seriesWinner === theirSquad;
              if (won) asTeammates.wins++; else asTeammates.losses++;
              asTeammates.series.push({ ...entry, histKey: k.name, teammateWon: won });
            } else {
              const p1Squad = p1InS1 ? 1 : 2;
              const p1Won = entry.seriesWinner === p1Squad;
              if (p1Won) asOpponents.p1Wins++; else asOpponents.p2Wins++;
              asOpponents.series.push({ ...entry, histKey: k.name, p1Won });
            }
          } catch(e) {}
        }
        asOpponents.series.sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt));
        asTeammates.series.sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt));
        return jsonResponse({ asOpponents, asTeammates, p1, p2 }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── GET /player ──────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/player') {
      try {
        const name = url.searchParams.get('name');
        if (!name) return jsonResponse({ error: 'name required' }, 400, origin);
        const nameLow = name.toLowerCase().trim();
        const [lb4Raw, lb2Raw, lb1Raw] = await Promise.all([
          env.REPORTS.get('leaderboard:alltime'),
          env.REPORTS.get('leaderboard:2v2'),
          env.REPORTS.get('leaderboard:1v1'),
        ]);
        const lb4 = lb4Raw ? JSON.parse(lb4Raw) : {};
        const lb2 = lb2Raw ? JSON.parse(lb2Raw) : {};
        const lb1 = lb1Raw ? JSON.parse(lb1Raw) : {};
        const find = (lb) => {
          for (const [key, val] of Object.entries(lb)) {
            if (key === normalizeName(name) || (val.displayName || '').toLowerCase() === nameLow) {
              return { ...val, key };
            }
          }
          return null;
        };
        const stats4v4 = find(lb4);
        const stats2v2 = find(lb2);
        const stats1v1 = find(lb1);
        if (!stats4v4 && !stats2v2 && !stats1v1) {
          return jsonResponse({ error: 'Player not found' }, 404, origin);
        }
        const list = await env.REPORTS.list({ prefix: 'history:' });
        const seriesHistory = [];
        for (const k of list.keys) {
          const raw = await env.REPORTS.get(k.name);
          if (!raw) continue;
          try {
            const entry = JSON.parse(raw);
            const allPlayers = [...(entry.squad1||[]), ...(entry.squad2||[])];
            const inSeries = allPlayers.some(n => n.toLowerCase() === nameLow);
            if (inSeries) {
              const inSquad1 = (entry.squad1||[]).some(n => n.toLowerCase() === nameLow);
              const playerSquad = inSquad1 ? 1 : 2;
              const won = entry.seriesWinner === playerSquad;
              const tied = entry.seriesWinner === 0;
              seriesHistory.push({
                ...entry, histKey: k.name, playerSquad, playerWon: won, playerTied: tied,
                teammates: inSquad1 ? (entry.squad1||[]).filter(n => n.toLowerCase() !== nameLow) : (entry.squad2||[]).filter(n => n.toLowerCase() !== nameLow),
                opponents: inSquad1 ? (entry.squad2||[]) : (entry.squad1||[]),
              });
            }
          } catch(e) {}
        }
        seriesHistory.sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt));
        const opponentRecords = {};
        seriesHistory.forEach(s => {
          (s.opponents || []).forEach(opp => {
            const key = opp.toLowerCase();
            if (!opponentRecords[key]) opponentRecords[key] = { name: opp, wins: 0, losses: 0, ties: 0 };
            if (s.playerWon) opponentRecords[key].wins++;
            else if (s.playerTied) opponentRecords[key].ties++;
            else opponentRecords[key].losses++;
          });
        });
        const opponents = Object.values(opponentRecords).sort((a, b) =>
          (b.wins + b.losses + b.ties) - (a.wins + a.losses + a.ties)
        );
        const displayName = (stats4v4 || stats2v2 || stats1v1).displayName || name;
        return jsonResponse({ displayName, stats4v4, stats2v2, stats1v1, seriesHistory, opponents }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    return new Response('Not found', { status: 404 });
  },
};
