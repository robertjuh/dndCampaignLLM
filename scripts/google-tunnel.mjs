import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
try {
  process.loadEnvFile('.env');
  for (const key of ['NGROK_AUTHTOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'])
    if (!process.env[key]?.trim())
      throw new Error(`Add ${key} to .env first. See README.md → Google sign-in.`);
  const redirect = new URL(process.env.GOOGLE_REDIRECT_URI);
  if (
    redirect.protocol !== 'https:' ||
    redirect.pathname !== '/auth/google/callback' ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password
  )
    throw new Error('GOOGLE_REDIRECT_URI must be an HTTPS address ending in /auth/google/callback.');
  const port = Number(process.env.GOOGLE_CALLBACK_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === Number(process.env.PORT ?? 3000))
    throw new Error('GOOGLE_CALLBACK_PORT must be a valid port different from the game port.');
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
  });
  if (response.headers.get('x-gather-service') !== 'google-callback')
    throw new Error(
      'The callback-only listener is not running on that port. Restart Gather after configuring Google sign-in.',
    );
  const binary = existsSync('data/tools/ngrok') ? './data/tools/ngrok' : 'ngrok';
  console.log(
    `Forwarding only Google's callback at ${redirect.origin} to localhost:${port}. Keep this terminal open.`,
  );
  const env = { ...process.env };
  delete env.GOOGLE_CLIENT_SECRET;
  const child = spawn(
    binary,
    ['http', `http://127.0.0.1:${port}`, '--url', redirect.origin, '--inspect=false'],
    { stdio: 'inherit', env },
  );
  child.on('error', () => {
    console.error('Could not start ngrok. Install it using the README instructions.');
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
} catch (error) {
  console.error(
    error instanceof TypeError
      ? 'Could not reach the callback listener or parse its address. Check .env and restart Gather.'
      : error.message,
  );
  process.exitCode = 1;
}
