import { expect, it } from 'vitest';
import { ProviderError, readResponseStream } from '../server/providers';

it('preserves the exact subscription sharing error rather than replacing every 429 with a rate limit', async () => {
  const response = Response.json(
    { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
    {
      status: 429,
      headers: { 'x-request-id': 'req-test', 'retry-after': '30' },
    },
  );
  const error = await readResponseStream(response).catch((e) => e);
  expect(error).toBeInstanceOf(ProviderError);
  expect(error.status).toBe(429);
  expect(error.message).toContain('overall plan may still have usage remaining');
  expect(error.diagnostics).toEqual({
    code: 'subscription_sharing_usage_limit_exceeded',
    upstreamStatus: 429,
    requestId: 'req-test',
    retryAfter: '30',
  });
});
it('distinguishes request throttling from subscription allowance', async () => {
  await expect(
    readResponseStream(Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 })),
  ).rejects.toThrow('rate-limiting requests');
});
it.each([{ detail: 'Private diagnostic' }, null, { error: { code: 'unknown_limit' } }])(
  'does not guess the cause of an unrecognized 429: %j',
  async (body) => {
    const error = await readResponseStream(Response.json(body, { status: 429 })).catch((e) => e);
    expect(error.message).toContain('without a recognized limit code');
    expect(error.message).not.toContain('Private diagnostic');
  },
);
it('preserves subscription errors arriving inside a successful HTTP stream', async () => {
  const response = new Response(
    `data: ${JSON.stringify({ type: 'error', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Private upstream details' } })}\n\n`,
    { status: 200 },
  );
  const error = await readResponseStream(response).catch((e) => e);
  expect(error.diagnostics).toMatchObject({
    code: 'subscription_sharing_usage_limit_exceeded',
    upstreamStatus: 200,
  });
  expect(error.status).toBe(429);
  expect(error.message).not.toContain('Private upstream details');
});
