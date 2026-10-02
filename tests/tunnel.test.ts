import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

it('refuses to publish the game port or any listener without the callback marker', async () => {
  const server = createServer((_request, response) => response.end('A different service'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const env = {
    ...process.env,
    NGROK_AUTHTOKEN: 'test-token',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REDIRECT_URI: 'https://gather.example/auth/google/callback',
    GOOGLE_CALLBACK_PORT: String(address.port),
    PORT: String(address.port),
  };
  const run = (overrides = {}) =>
    promisify(execFile)(process.execPath, ['scripts/google-tunnel.mjs'], {
      env: { ...env, ...overrides },
      timeout: 5000,
    });
  try {
    await expect(run()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('different from the game port'),
    });
    await expect(run({ PORT: '0' })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('callback-only listener is not running'),
    });
    await expect(run({ NGROK_AUTHTOKEN: '' })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Add NGROK_AUTHTOKEN'),
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
