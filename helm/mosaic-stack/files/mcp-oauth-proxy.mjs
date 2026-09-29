import http from 'node:http';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function tokenProvider({ tokenUrl, clientId, clientSecret, scope = '' }, fetchToken = fetch, now = Date.now) {
  const url = new URL(tokenUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('OAuth token URL must be HTTPS without credentials or fragment');
  let cached, pending;
  return {
    invalidate(token) { if (cached?.token === token) cached = undefined; },
    async get() {
      if (cached && now() < cached.expiresAt) return cached.token;
      if (!pending) pending = (async () => {
        const started = now();
        const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
        if (scope) body.set('scope', scope);
        const response = await fetchToken(url, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('OAuth token request failed');
        const data = await response.json();
        if (typeof data.access_token !== 'string' || !data.access_token || data.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Invalid OAuth token response');
        const lifetime = data.expires_in * 1000;
        const expiresAt = started + lifetime - Math.min(30000, lifetime / 10);
        if (expiresAt <= now()) throw new Error('OAuth token expired during acquisition');
        cached = { token: data.access_token, expiresAt };
        return cached.token;
      })().finally(() => { pending = undefined; });
      return pending;
    },
  };
}

function endToEndHeaders(headers) {
  const result = { ...headers };
  const hop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
  for (const name of String(headers.connection || '').split(',')) hop.push(name.trim().toLowerCase());
  for (const name of hop) delete result[name];
  return result;
}

export function proxyServer({ upstreamPort, path, tokens }) {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') return res.writeHead(200).end('ok');
    try {
      const target = new URL(req.url, 'http://localhost');
      if (target.origin !== 'http://localhost' || target.pathname !== path || !['GET', 'POST', 'DELETE'].includes(req.method)) return res.writeHead(404).end();
      const token = await tokens.get();
      if (res.destroyed) return;
      const headers = endToEndHeaders(req.headers);
      headers.authorization = `Bearer ${token}`;
      headers.host = `127.0.0.1:${upstreamPort}`;
      const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: target.pathname + target.search, method: req.method, headers }, reply => {
        if (reply.statusCode === 401) tokens.invalidate(token);
        res.writeHead(reply.statusCode, endToEndHeaders(reply.headers));
        reply.on('error', () => res.destroy());
        reply.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502).end('MCP upstream unavailable');
        else res.destroy();
      });
      res.on('close', () => upstream.destroy());
      req.on('error', () => upstream.destroy());
      req.on('aborted', () => upstream.destroy());
      req.pipe(upstream);
    } catch {
      res.writeHead(502).end('MCP authentication unavailable');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const env = process.env;
  const tokens = tokenProvider({ tokenUrl: env.OAUTH_TOKEN_URL, clientId: env.OAUTH_CLIENT_ID, clientSecret: env.OAUTH_CLIENT_SECRET, scope: env.OAUTH_SCOPE });
  proxyServer({ upstreamPort: Number(env.UPSTREAM_PORT), path: env.MCP_PATH, tokens }).listen(Number(env.PORT), '0.0.0.0');
}
