// Static server for www/ so the app can be opened in a desktop browser.
// ES modules are blocked over file://, so browser testing needs a real HTTP origin.
// The native bridge is absent here, so recording uses the WebAudio fallback path.
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';

const PORT = Number(process.env.PORT) || 5173;
const ROOT = 'www';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function resolvePath(url) {
  const path = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  const relative = normalize(path).replace(/^([/\\])+/, '');
  return join(ROOT, relative === '' ? 'index.html' : relative);
}

createServer(async (req, res) => {
  const file = resolvePath(req.url);
  if (!file.startsWith(normalize(ROOT))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Nocturne dev server: http://localhost:${PORT}`);
});
