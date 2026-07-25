import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TabManager } from './tabs';

const PORT_FILE = path.join(os.tmpdir(), 'swiftshop-browser-api.json');

export interface ApiServerHandle {
  port: number;
  close: () => void;
}

export function startApiServer(tabs: TabManager): ApiServerHandle {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/navigate') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { url, newTab } = JSON.parse(body);
          if (typeof url !== 'string' || !url) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing or invalid url' }));
            return;
          }
          // newTab:true opens each URL in its own tab (so a burst of links doesn't
          // clobber the active tab). Omitted/false preserves the original navigate.
          if (newTab) tabs.newTab(url, { activate: true });
          else tabs.navigate(url);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      fs.writeFileSync(PORT_FILE, JSON.stringify({ port }), 'utf8');
      console.log(`[API] SwiftShop API listening on http://127.0.0.1:${port}`);
    } catch (err) {
      console.error('[API] Failed to write port file:', err);
    }
  });

  const handle: ApiServerHandle = {
    get port(): number {
      const addr = server.address();
      return typeof addr === 'object' && addr ? addr.port : 0;
    },
    close: () => {
      server.close();
      try { fs.unlinkSync(PORT_FILE); } catch { /* ok */ }
    }
  };

  return handle;
}
