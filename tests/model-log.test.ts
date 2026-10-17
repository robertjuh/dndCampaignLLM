import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createModelLog, emitModelTrace } from '../server/model-log';
import { ChatGPTGM } from '../server/providers';
import type { ChatGPTAuth } from '../server/auth';
import type { GMContext, GameTools } from '../server/game';
import { ensureLocations } from '../shared/locations';
import { initialScene, initialState } from '../shared/rules';
import { templateCharacter } from '../shared/schema';

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  vi.restoreAllMocks();
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'gather-model-log-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return dir;
}
function context(): GMContext {
  const character = templateCharacter('Explorer');
  const member = {
    id: randomUUID(),
    playerId: randomUUID(),
    playerName: 'Player',
    characterId: randomUUID(),
    character,
    state: initialState(character, 'model-log-test'),
    active: true,
  };
  return {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Tracing',
      setting: 'Forest',
      premise: '',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'chatgpt',
      model: 'test-model',
    },
    scene: ensureLocations(initialScene('Forest'), [member.id]),
    members: [member],
    journal: [],
    history: [],
    turn: {
      id: randomUUID(),
      number: 1,
      phase: 'resolving',
      roster: [member.id],
      actions: [{ memberId: member.id, text: 'Inspect the tree.', passed: false }],
      rolls: [],
      result: null,
      error: null,
    },
    requestBudget: { used: 0, limit: 8 },
  };
}
function completed(output: unknown) {
  return new Response(
    `data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }], usage: { input_tokens: 100, output_tokens: 20 } } })}\n\n`,
    { headers: { 'x-request-id': 'req-upstream-test' } },
  );
}

it('logs actual request/response JSON, correlation IDs and corrections without authorization headers', async () => {
  const dir = directory();
  const c = context();
  const trace = createModelLog(dir);
  c.requestBudget!.traceContext = {
    campaignId: 'test-campaign',
    turnId: c.turn.id,
    turnNumber: 1,
    stage: 'adjudication',
    attempt: 1,
  };
  const fetcher = vi.fn(async (_url, init) => {
    expect((init!.headers as Record<string, string>)['X-Client-Request-Id']).toMatch(/^[a-f0-9-]{36}$/);
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer private-connection-token');
    return completed({ malformed: true });
  }) as unknown as typeof fetch;
  await new ChatGPTGM(
    { accessToken: async () => 'private-connection-token' } as unknown as ChatGPTAuth,
    'owner',
    'test-model',
    fetcher,
    trace,
  ).adjudicate(c, {} as GameTools);
  expect(fetcher).toHaveBeenCalledTimes(3);
  const calls = readdirSync(join(dir, 'chatgpt-calls'));
  expect(calls).toHaveLength(3);
  for (const name of calls) {
    const filename = join(dir, 'chatgpt-calls', name);
    const text = readFileSync(filename, 'utf8');
    const saved = JSON.parse(text);
    expect(saved.request.model).toBe('test-model');
    expect(saved.request.instructions).toContain('You are the adjudicator');
    expect(saved.request.input[0].content).toContain('Inspect the tree.');
    expect(saved.response.output[0].content[0].text).toBe('{"malformed":true}');
    expect(saved.metadata).toMatchObject({
      turnId: c.turn.id,
      stage: 'adjudication',
      turnNumber: 1,
      diagnostic: { status: 200, upstreamRequestId: 'req-upstream-test', inputTokens: 100 },
    });
    expect(saved.feedback.length).toBeGreaterThan(0);
    if (saved.metadata.request > 1)
      expect(JSON.parse(saved.request.input[0].content).correctionsToPreserve.length).toBeGreaterThan(0);
    expect(text).not.toContain('private-connection-token');
    expect(text).not.toContain('Authorization');
    expect(statSync(filename).mode & 0o777).toBe(0o600);
  }
  const events = readFileSync(join(dir, 'chatgpt.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(events.filter((event) => event.type === 'request')).toHaveLength(3);
  expect(events.at(-1).type).toBe('fallback');
  expect(events.every((event) => !event.body && !event.output)).toBe(true);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

it('bounds log retention and rotates the compact server log', () => {
  const dir = directory();
  const trace = createModelLog(dir);
  const event = {
    type: 'request' as const,
    callId: randomUUID(),
    timestamp: new Date().toISOString(),
    body: { model: 'test-model' },
  };
  trace(event);
  for (let i = 0; i < 201; i++) writeFileSync(join(dir, 'chatgpt-calls', `${randomUUID()}.json`), '{}');
  writeFileSync(join(dir, 'chatgpt.jsonl'), 'x'.repeat(2_000_001));
  trace({ ...event, callId: randomUUID() });
  expect(readdirSync(join(dir, 'chatgpt-calls'))).toHaveLength(200);
  expect(statSync(join(dir, 'chatgpt.jsonl.1')).size).toBe(2_000_001);
  expect(readFileSync(join(dir, 'chatgpt.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});

it('keeps a diagnostics failure from interrupting gameplay and rejects unsafe filenames', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() =>
    emitModelTrace(
      () => {
        throw new Error('Disk full');
      },
      { type: 'request', callId: randomUUID(), timestamp: new Date().toISOString() },
    ),
  ).not.toThrow();
  expect(warning).toHaveBeenCalledOnce();
  const trace = createModelLog(directory());
  expect(() => trace({ type: 'request', callId: '../outside', timestamp: '' })).toThrow(
    'Invalid model trace ID',
  );
});

it('keeps the total eight-request ceiling even when the model returns only invalid tool calls', async () => {
  const c = context();
  const fetcher = vi.fn(
    async () =>
      new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'function_call', name: 'roll_check', call_id: 'bad-check', arguments: '{}' }] } })}\n\n`,
      ),
  ) as unknown as typeof fetch;
  await new ChatGPTGM(
    { accessToken: async () => 'token' } as unknown as ChatGPTAuth,
    'owner',
    'test-model',
    fetcher,
  ).adjudicate(c, {} as GameTools);
  expect(fetcher).toHaveBeenCalledTimes(8);
  expect(c.requestBudget!.used).toBe(8);
});
