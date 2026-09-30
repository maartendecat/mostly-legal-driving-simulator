import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * Serves the built client (a Vite `dist` folder), so one process hosts both the game page and the
 * game server. Hashed build files are cached for a year; index.html is always revalidated.
 */
export function staticFileHandler(directory: string) {
  const root = resolve(directory);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    // normalize() resolves "..", and the check below keeps every request inside the folder.
    let file = join(root, normalize(path));
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    if (!(await isFile(file))) file = join(root, 'index.html'); // the game is a single page
    if (!(await isFile(file))) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('The game has not been built. Run: npm run build');
      return;
    }
    const isIndex = file.endsWith(`${sep}index.html`);
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': isIndex ? 'no-cache' : path.startsWith('/assets/') && /-[\w-]{8,}\./.test(path) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).pipe(response);
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
