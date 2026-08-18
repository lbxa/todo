import { file, serve } from 'bun';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';

const OUT = join(import.meta.dir, '..', 'out');

/**
 * Serves the built static export the way Cloudflare Workers assets does, so the
 * suite exercises the real deploy artefact rather than the dev server.
 */
export function startServer() {
  if (!existsSync(join(OUT, 'index.html'))) {
    throw new Error('out/index.html missing — run `next build` first (or use `bun run test`).');
  }

  return serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      let rel = normalize(decodeURIComponent(pathname));
      if (rel.includes('..')) return new Response('Forbidden', { status: 403 });
      if (rel.endsWith('/')) rel += 'index.html';

      for (const candidate of [rel, `${rel}.html`, join(rel, 'index.html')]) {
        const path = join(OUT, candidate);
        if (existsSync(path) && !path.endsWith('/')) return new Response(file(path));
      }
      return new Response(file(join(OUT, '404.html')), { status: 404 });
    },
  });
}

export const originOf = (server: ReturnType<typeof startServer>) =>
  `http://localhost:${server.port}`;
