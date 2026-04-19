// Lock in H3 — Cloudflare Worker
// Handles: Anthropic API proxy + report save/load via KV
//
// SETUP INSTRUCTIONS:
// 1. In Cloudflare dashboard → Workers & Pages → your worker → Settings → Variables
//    Add variable: ANTHROPIC_API_KEY = your key (mark as secret)
// 2. In Cloudflare dashboard → Workers & Pages → KV → Create namespace → name it "REPORTS"
// 3. In your worker → Settings → Bindings → KV Namespace → Add binding:
//    Variable name: REPORTS   KV namespace: REPORTS
// 4. Deploy

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
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no confusable chars
  let id = '';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  arr.forEach(b => id += chars[b % chars.length]);
  return id;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors(origin) });
    }

    // Only allow requests from your GitHub Pages site
    if (origin !== ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403 });
    }

    // ── POST /analyze — proxy to Anthropic ──────────────────────────────
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

    // ── POST /save — save report data, return short ID ──────────────────
    if (request.method === 'POST' && url.pathname === '/save') {
      try {
        const body = await request.text();
        // Validate it's real JSON and not huge (max 512KB)
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed)) throw new Error('Invalid data');
        if (body.length > 512 * 1024) throw new Error('Data too large');

        // Generate a unique ID
        let id, attempts = 0;
        do {
          id = randomId(6);
          const existing = await env.REPORTS.get(id);
          if (!existing) break;
          attempts++;
        } while (attempts < 5);

        // Save to KV with 90-day expiry
        await env.REPORTS.put(id, body, { expirationTtl: 60 * 60 * 24 * 90 });
        return jsonResponse({ id }, 200, origin);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    // ── GET /report?id=xxx — load report data by ID ─────────────────────
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

    return new Response('Not found', { status: 404 });
  },
};
