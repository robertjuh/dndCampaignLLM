import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';
import { networkInterfaces } from 'node:os';
import { createApp } from './app';
import { openDatabase } from './db';
import { ChatGPTAuth } from './auth';
import { GoogleAuth, createGoogleCallbackApp } from './google';

try {
  process.loadEnvFile(resolve('.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const directory = resolve(process.env.GATHER_DATA_DIR ?? 'data');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const db = openDatabase(join(directory, 'gather.sqlite'));
const partyOrigins = process.env.GATHER_PUBLIC_URL
  ? [new URL(process.env.GATHER_PUBLIC_URL).origin]
  : host === '0.0.0.0'
    ? Object.values(networkInterfaces())
        .flat()
        .filter((entry) => entry?.family === 'IPv4' && !entry.internal)
        .map((entry) => `http://${entry!.address}:${port}`)
    : [];
const google =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI
    ? new GoogleAuth(db, {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        redirectUri: process.env.GOOGLE_REDIRECT_URI,
      })
    : undefined;
const { app } = await createApp({
  db,
  auth: new ChatGPTAuth(join(directory, 'credentials')),
  port,
  partyOrigins,
  google,
});
if (google) {
  const callback = createGoogleCallbackApp(google);
  const callbackPort = Number(process.env.GOOGLE_CALLBACK_PORT ?? 3001);
  await callback.listen({ port: callbackPort, host: '127.0.0.1' });
  app.addHook('onClose', async () => {
    await callback.close();
  });
  console.log(`Google callback listener: http://127.0.0.1:${callbackPort}/auth/google/callback`);
}
if (process.argv.includes('--production')) {
  const root = resolve('dist');
  const assets = new Map<string, Buffer>();
  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile())
        assets.set('/' + relative(root, path).split('\\').join('/'), readFileSync(path));
    }
  }
  scan(root);
  const mime: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0];
    if (path.startsWith('/api/')) return reply.code(404).send({ error: 'Route not found.' });
    const file = assets.get(path);
    if (file) return reply.type(mime[extname(path)] ?? 'application/octet-stream').send(file);
    if (!extname(path)) return reply.type('text/html').send(assets.get('/index.html'));
    return reply.code(404).send('Not found');
  });
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: { middlewareMode: true, hmr: { server: app.server } },
    appType: 'spa',
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Route not found.' });
    reply.hijack();
    vite.middlewares(request.raw, reply.raw, () => {
      if (!reply.raw.writableEnded) {
        reply.raw.statusCode = 404;
        reply.raw.end('Not found');
      }
    });
  });
  app.addHook('onClose', async () => {
    await vite.close();
  });
}
await app.listen({ port, host });
console.log(`Gather is ready at http://127.0.0.1:${port}`);
for (const origin of partyOrigins) console.log(`Party address: ${origin}`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    db.close();
    process.exit(0);
  });
