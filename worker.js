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
  return mode === '2v2' ? 'leaderboard:2v2' : 'leaderboard:alltime';
}

function snapshotPrefix(mode) {
  return mode === '2v2' ? 'snapshot2v2:' : 'snapshot:';
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

// Save a history entry for a series
async function saveHistoryEntry(games, seriesWinner, mode, reportId, playedAt, env) {
  const g1 = games[0];
  const squad1 = (g1.redTeam || []).map(p => p.name).filter(Boolean);
  const squad2 = (g1.blueTeam || []).map(p => p.name).filter(Boolean);

  // Count wins per squad
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
    expirationTtl: 60 * 60 * 24 * 365 * 2, // 2 years
  });

  return entry;
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
        seriesPlayed: 0, seriesWon: 0, seriesLost: 0,
        kills: 0, deaths: 0, assists: 0,
        flagCaps: 0, hillSecs: 0, ballSecs: 0
      };
    }
    const lb = leaderboard[pKey];
    lb.displayName = stats.displayName;
    lb.seriesPlayed += 1;
    if (winningSquadNames.has(pKey)) lb.seriesWon += 1;
    else if (losingSquadNames.has(pKey)) lb.seriesLost += 1;
    lb.kills += stats.kills;
    lb.deaths += stats.deaths;
    lb.assists += stats.assists;
    lb.flagCaps += stats.flagCaps;
    lb.hillSecs += stats.hillSecs;
    lb.ballSecs += stats.ballSecs;
  });

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
        const resolvedMode = mode === '2v2' ? '2v2' : '4v4';

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

        // Auto-save report and history entry
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
        const mode = url.searchParams.get('mode') === '2v2' ? '2v2' : '4v4';
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
        const mode = url.searchParams.get('mode') === '2v2' ? '2v2' : '4v4';
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
        const resolvedMode = mode === '2v2' ? '2v2' : '4v4';
        if (!key || (!key.startsWith('snapshot:') && !key.startsWith('snapshot2v2:'))) throw new Error('Invalid snapshot key');
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
        const resolvedMode = mode === '2v2' ? '2v2' : '4v4';
        const lbRaw = await env.REPORTS.get(lbKey(resolvedMode));
        if (!lbRaw) throw new Error('Leaderboard is empty');
        const leaderboard = JSON.parse(lbRaw);
        if (!leaderboard[key]) throw new Error(`Player "${key}" not found`);
        leaderboard[key].seriesPlayed = stats.seriesPlayed;
        leaderboard[key].seriesWon = stats.seriesWon;
        leaderboard[key].seriesLost = stats.seriesLost;
        leaderboard[key].kills = stats.kills;
        leaderboard[key].deaths = stats.deaths;
        leaderboard[key].assists = stats.assists;
        leaderboard[key].flagCaps = stats.flagCaps;
        leaderboard[key].hillSecs = stats.hillSecs;
        leaderboard[key].ballSecs = stats.ballSecs;
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
        const resolvedMode = mode === '2v2' ? '2v2' : '4v4';
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
        to.kills += from.kills;
        to.deaths += from.deaths;
        to.assists += from.assists;
        to.flagCaps += from.flagCaps;
        to.hillSecs += from.hillSecs;
        to.ballSecs += from.ballSecs;
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
        const resolvedMode = mode === '2v2' ? '2v2' : '4v4';
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
        // Sort newest first
        entries.sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt));
        return jsonResponse({ entries }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /history/import — requires admin token ───────────────────────
    if (request.method === 'POST' && url.pathname === '/history/import') {
      if (!await validateAdminToken(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      try {
        const { reportUrl, playedAt, mode } = await request.json();
        if (!reportUrl || !playedAt) throw new Error('reportUrl and playedAt required');

        // Extract report ID from URL
        const match = reportUrl.match(/[?&]r=([a-z2-9]{4,10})/);
        if (!match) throw new Error('Could not extract report ID from URL');
        const reportId = match[1];

        // Fetch the report data
        const reportRaw = await env.REPORTS.get(reportId);
        if (!reportRaw) throw new Error(`Report "${reportId}" not found — link may have expired`);
        const games = JSON.parse(reportRaw);
        if (!Array.isArray(games)) throw new Error('Invalid report data');

        const resolvedMode = mode === '2v2' ? '2v2' : '4v4';

        // Determine series winner from game data
        const g1 = games[0];
        const squad1 = new Set((g1.redTeam || []).map(p => p.name).filter(Boolean));
        let s1Wins = 0, s2Wins = 0;
        games.forEach(g => {
          const wt = g.winner === 'Red' ? (g.redTeam || []) : (g.blueTeam || []);
          if (wt.length > 0) {
            const inSquad1 = squad1.has(wt[0].name) ||
              [...squad1].some(n => n && wt[0].name && n.toLowerCase() === wt[0].name.toLowerCase());
            if (inSquad1) s1Wins++; else s2Wins++;
          }
        });
        const seriesWinner = s1Wins > s2Wins ? 1 : s2Wins > s1Wins ? 2 : 0;

        // Check for duplicate history entry
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

    // ── POST /history/delete — requires admin token ───────────────────────
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
// ── POST /history/get — requires admin token ──────────────────────────
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

// ── POST /history/update — requires admin token ───────────────────────
if (request.method === 'POST' && url.pathname === '/history/update') {
  if (!await validateAdminToken(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
  try {
    const { key, newPlayedAt, entry } = await request.json();
    if (!key || !newPlayedAt || !entry) throw new Error('key, newPlayedAt, and entry required');

    // Delete old key
    await env.REPORTS.delete(key);

    // Save with new timestamp
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
        const p1Low = p1.toLowerCase();
        const p2Low = p2.toLowerCase();

        const p1InS1 = s1.includes(p1Low);
        const p1InS2 = s2.includes(p1Low);
        const p2InS1 = s1.includes(p2Low);
        const p2InS2 = s2.includes(p2Low);

        const p1Present = p1InS1 || p1InS2;
        const p2Present = p2InS1 || p2InS2;
        if (!p1Present || !p2Present) continue;

        const sameTeam = (p1InS1 && p2InS1) || (p1InS2 && p2InS2);

        if (sameTeam) {
          // Determine if their shared team won
          const theirSquad = p1InS1 ? 1 : 2;
          const won = entry.seriesWinner === theirSquad;
          if (won) asTeammates.wins++; else asTeammates.losses++;
          asTeammates.series.push({ ...entry, histKey: k.name, teammateWon: won });
        } else {
          // Opponents — who won?
          const p1Squad = p1InS1 ? 1 : 2;
          const p1Won = entry.seriesWinner === p1Squad;
          if (p1Won) asOpponents.p1Wins++; else asOpponents.p2Wins++;
          asOpponents.series.push({ ...entry, histKey: k.name, p1Won });
        }
      } catch(e) {}
    }

    // Sort each list newest first
    asOpponents.series.sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt));
    asTeammates.series.sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt));

    return jsonResponse({ asOpponents, asTeammates, p1, p2 }, 200, origin);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, origin);
  }
}
    return new Response('Not found', { status: 404 });
  },
};
