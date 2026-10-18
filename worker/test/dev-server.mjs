// Run the sync Worker locally on Node (no Cloudflare account needed):
//   node worker/test/dev-server.mjs            -> http://127.0.0.1:8787
// Set "syncApi": "http://127.0.0.1:8787" in site/config.json to try sync against it.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import worker from '../src/index.mjs';
import { makeD1 } from './d1-shim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = {
  DB: makeD1(path.join(here, '..', 'schema.sql')),
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '*',
  KEY_PEPPER: 'local-dev',
};
const port = Number(process.env.PORT || 8787);

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log(`sync dev server on http://127.0.0.1:${port}`));
