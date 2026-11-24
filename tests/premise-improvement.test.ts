import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { ChatGPTAuth } from '../server/auth';
import { openDatabase } from '../server/db';
import { GameError, type GameMaster } from '../server/game';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const draft = {
  name: '',
  setting: '',
  premise: 'space pirates',
  tone: 'Curious and hopeful',
  language: 'Nederlands',
  partyGoal: 'Find a missing ship',
  instructions: 'No magic',
  custom: [{ key: 'Era', value: 'Distant future' }],
  provider: 'chatgpt',
  model: 'chosen-model',
};
async function fixture(provider: GameMaster) {
  const db = openDatabase(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'gather-premise-'));
  const factory = vi.fn(() => provider);
  const { app } = await createApp({ db, auth: new ChatGPTAuth(directory), providers: factory });
  cleanups.push(async () => {
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const post = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/campaigns/improve-premise',
      headers: { 'x-gather-request': '1' },
      payload,
    });
  return { app, db, factory, post };
}

it('improves an unsaved short premise using all draft settings without creating a campaign', async () => {
  const improvePremise = vi.fn(async () => ({
    setting: 'Orbital colonies',
    tone: 'Hopeful',
    partyGoal: 'Find the ship',
    premise: 'Een verdwenen schip zendt morgen al noodsignalen uit.',
    instructions: 'No magic\n\nBegin bij de noodsluis terwijl de lucht uit het schip ontsnapt.',
  }));
  const { db, factory, post } = await fixture({ improvePremise });
  const response = await post(draft);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    setting: 'Orbital colonies',
    tone: 'Hopeful',
    partyGoal: 'Find the ship',
    premise: 'Een verdwenen schip zendt morgen al noodsignalen uit.',
    instructions: 'No magic\n\nBegin bij de noodsluis terwijl de lucht uit het schip ontsnapt.',
  });
  expect(factory).toHaveBeenCalledWith(expect.any(String), expect.objectContaining(draft));
  expect(improvePremise).toHaveBeenCalledWith(
    expect.objectContaining(draft),
    expect.any(AbortSignal),
    undefined,
  );
  expect(db.prepare('SELECT count(*) AS total FROM campaigns').get()).toEqual({ total: 0 });
});

it('rejects empty seeds, oversized input, practice mode and unsupported output', async () => {
  const improvePremise = vi.fn(async () => ({
    setting: 'Orbital colonies', tone: 'Hopeful', partyGoal: '',
    premise: 'A ship sends a distress signal.', instructions: '',
  }));
  const { post, factory } = await fixture({ improvePremise });
  for (const invalid of [
    { ...draft, premise: ' ' },
    { ...draft, premise: 'x'.repeat(2001) },
    { ...draft, provider: 'practice' },
  ])
    expect((await post(invalid)).statusCode).toBe(400);
  expect(factory).not.toHaveBeenCalled();
  expect((await post(draft)).statusCode).toBe(400);
  expect(improvePremise).toHaveBeenCalledOnce();
});

it('returns generation failures without saving campaign state', async () => {
  const { db, post } = await fixture({
    improvePremise: async () => {
      throw new GameError('Connect ChatGPT first.', 503);
    },
  });
  const response = await post({ ...draft, setting: 'Orbital shipyards', premise: '' });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ error: 'Connect ChatGPT first.' });
  expect(db.prepare('SELECT count(*) AS total FROM campaigns').get()).toEqual({ total: 0 });
});
