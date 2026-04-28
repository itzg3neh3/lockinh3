// Lock in H3 — Cloudflare Worker
const ALLOWED_ORIGIN = 'https://itzg3neh3.github.io';

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

function parseTimeSecs(t) {
  if (t === null || t === undefined || t === 'null' || t === '') return 0;
  const s = String(t).trim();
  if (s.includes(':')) {
    const parts = s.split(':');
    return parseInt(parts[0] || 0) * 60 + parseInt(parts[1] || 0);
  }
  return parseInt(s) || 0;
}

async function mergeSeriesIntoLeaderboard(games, seriesWinner, env) {
  const lbRaw = await env.REPORTS.get('leaderboard:alltime');
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
      const key = normalizeName(p.name);
      if (!playerStats[key]) playerStats[key] = {
        displayName: p.name,
        kills: 0, deaths: 0, assists: 0,
        flagCaps: 0, hillSecs: 0, ballSecs: 0
      };
      const s = playerStats[key];
      s.kills += p.kills || 0;
      s.deaths += p.deaths || 0;
      s.assists += p.assists || 0;
      s.flagCaps += p.flagCaps || 0;
      s.hillSecs += parseTimeSecs(p.hillTime);
      s.ballSecs += parseTimeSecs(p.ballTime);
    });
  });

  Object.entries(playerStats).forEach(([key, stats]) => {
    if (!leaderboard[key]) {
      leaderboard[key] = {
        displayName: stats.displayName,
        seriesPlayed: 0, seriesWon: 0, seriesLost: 0,
        kills: 0, deaths: 0, assists: 0,
        flagCaps: 0, hillSecs: 0, ballSecs: 0
      };
    }
    const lb = leaderboard[key];
    lb.displayName = stats.displayName;
    lb.seriesPlayed += 1;
    if (winningSquadNames.has(key)) lb.seriesWon += 1;
    else if (losingSquadNames.has(key)) lb.seriesLost += 1;
    lb.kills += stats.kills;
    lb.deaths += stats.deaths;
    lb.assists += stats.assists;
    lb.flagCaps += stats.flagCaps;
    lb.hillSecs += stats.hillSecs;
    lb.ballSecs += stats.ballSecs;
  });

  await env.REPORTS.put('leaderboard:alltime', JSON.stringify(leaderboard));
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
        const { games, seriesWinner, force } = await request.json();
        if (!Array.isArray(games)) throw new Error('Invalid data');

        const fingerprint = await createFingerprint(games);
        const hash = await hashString(fingerprint);
        const fpKey = `fp:${hash}`;

        // Check for duplicate — unless force flag is set
        if (!force) {
          const existing = await env.REPORTS.get(fpKey);
          if (existing) {
            return jsonResponse({ status: 'duplicate', message: 'Series already counted' }, 200, origin);
          }
        }

        // Merge stats FIRST — only mark fingerprint as seen if this succeeds
        await mergeSeriesIntoLeaderboard(games, seriesWinner, env);

        // Now safe to mark fingerprint as seen
        await env.REPORTS.put(fpKey, '1', { expirationTtl: 60 * 60 * 24 * 365 * 2 });

        return jsonResponse({ status: 'saved' }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── GET /leaderboard ─────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/leaderboard') {
      try {
        const data = await env.REPORTS.get('leaderboard:alltime');
        if (!data) return jsonResponse({}, 200, origin);
        return jsonResponse(JSON.parse(data), 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /leaderboard/merge ──────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/leaderboard/merge') {
      try {
        const { fromKey, toKey } = await request.json();
        if (!fromKey || !toKey) throw new Error('fromKey and toKey required');
        if (fromKey === toKey) throw new Error('Cannot merge a player into themselves');

        const lbRaw = await env.REPORTS.get('leaderboard:alltime');
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
        await env.REPORTS.put('leaderboard:alltime', JSON.stringify(leaderboard));
        return jsonResponse({ status: 'merged' }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── POST /leaderboard/delete ─────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/leaderboard/delete') {
      try {
        const { key } = await request.json();
        if (!key) throw new Error('key required');

        const lbRaw = await env.REPORTS.get('leaderboard:alltime');
        if (!lbRaw) throw new Error('Leaderboard is empty');
        const leaderboard = JSON.parse(lbRaw);

        if (!leaderboard[key]) throw new Error(`Player "${key}" not found`);
        delete leaderboard[key];

        await env.REPORTS.put('leaderboard:alltime', JSON.stringify(leaderboard));
        return jsonResponse({ status: 'deleted' }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }
// ── POST /leaderboard/edit ───────────────────────────────────────────
if (request.method === 'POST' && url.pathname === '/leaderboard/edit') {
  try {
    const { key, stats } = await request.json();
    if (!key || !stats) throw new Error('key and stats required');

    const lbRaw = await env.REPORTS.get('leaderboard:alltime');
    if (!lbRaw) throw new Error('Leaderboard is empty');
    const leaderboard = JSON.parse(lbRaw);

    if (!leaderboard[key]) throw new Error(`Player "${key}" not found`);

    // Overwrite stats fields, keep displayName unchanged
    leaderboard[key].seriesPlayed = stats.seriesPlayed;
    leaderboard[key].seriesWon = stats.seriesWon;
    leaderboard[key].seriesLost = stats.seriesLost;
    leaderboard[key].kills = stats.kills;
    leaderboard[key].deaths = stats.deaths;
    leaderboard[key].assists = stats.assists;
    leaderboard[key].flagCaps = stats.flagCaps;
    leaderboard[key].hillSecs = stats.hillSecs;
    leaderboard[key].ballSecs = stats.ballSecs;

    await env.REPORTS.put('leaderboard:alltime', JSON.stringify(leaderboard));
    return jsonResponse({ status: 'saved' }, 200, origin);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, origin);
  }
}
    return new Response('Not found', { status: 404 });
  },
};
