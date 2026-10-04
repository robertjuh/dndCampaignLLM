import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app';
import { openDatabase } from '../server/db';
import type { ChatGPTAuth } from '../server/auth';
import { ChatGPTGM, PracticeGM } from '../server/providers';
import {
  campaignSchema,
  characterSchema,
  templateCharacter,
  type CampaignConfig,
  type Item,
  type Ability,
} from '../shared/schema';

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const db = openDatabase(':memory:');
  const auth = {
    accessToken: vi.fn(async () => 'test-token'),
    models: vi.fn(async () => [{ id: 'default-model', name: 'Default' }]),
  } as unknown as ChatGPTAuth;
  const { equipmentOptions: _, selectedEquipmentIds: __, ...character } = templateCharacter('Station medic');
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const context = JSON.parse(JSON.parse(init!.body as string).input[0].content);
    const draft = structuredClone(character);
    draft.abilities.push(
      { ...draft.abilities[0], name: 'Alternative combat ability' },
      {
        ...draft.abilities[1],
        name: 'Alternative utility ability',
        description: 'Navigate unfamiliar places.',
      },
    );
    draft.traits[0].blocked = ['head', 'boots'].slice(0, context.handicapCount ?? 0) as ('head' | 'boots')[];
    const result = context.rolledEquipment
      ? {
          abilities: context.schemaExample.abilities,
          items: context.rolledEquipment.map(({ id, name, description }: Item) => ({
            id,
            name,
            description,
          })),
        }
      : { ...draft, combatAffinity: 'mend' };
    return new Response(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
        },
      })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  const providers = vi.fn(
    (owner: string, config: CampaignConfig) =>
      new ChatGPTGM(auth, owner, config.model, fetcher as typeof fetch),
  );
  const { app, game } = await createApp({ db, auth, providers });
  const host = game.identify();
  const member = game.identify();
  const stranger = game.identify();
  const config = campaignSchema.parse({
    name: 'Last station',
    setting: 'A haunted orbital station',
    premise: 'Restore the life support before the star goes dark.',
    tone: 'Hopeful science fiction',
    instructions: 'Use strange technology rather than medieval magic.',
    custom: [{ key: 'Faction', value: 'The Amber Engineers' }],
    language: 'Nederlands',
    provider: 'chatgpt',
    model: 'campaign-model',
  });
  const campaign = game.create(host.id, config);
  const saved = game.saveCharacter(member.id, templateCharacter('Existing traveller'));
  game.join(campaign.inviteCode!, member.id, saved.id);
  const generate = (token: string, context: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/characters/generate',
      headers: { 'x-gather-request': '1' },
      cookies: { gather_session: token },
      payload: { concept: 'A wandering medic', model: 'personal-model', ...context },
    });
  const close = async () => {
    await app.close();
    db.close();
  };
  return {
    db,
    app,
    game,
    auth,
    host,
    member,
    stranger,
    config,
    campaign,
    providers,
    fetcher,
    generate,
    close,
  };
}

it('uses an accessible campaign theme and host model for character and starting equipment without joining', async () => {
  const { game, host, member, stranger, config, campaign, providers, fetcher, auth, generate, close } =
    await fixture();
  try {
    const before = game.snapshot(campaign.id, host.id);
    for (const [token, context] of [
      [host.token!, { campaignId: campaign.id }],
      [member.token!, { campaignId: campaign.id }],
      [stranger.token!, { code: campaign.inviteCode! }],
    ] as const) {
      const response = await generate(token, context);
      expect(response.statusCode).toBe(200);
      expect(response.json().equipmentOptions).toHaveLength(5);
    }
    expect(providers).toHaveBeenCalledTimes(3);
    for (const call of providers.mock.calls) expect(call).toEqual([host.id, config]);
    expect(fetcher).toHaveBeenCalledTimes(6);
    for (const [, init] of fetcher.mock.calls) {
      const request = JSON.parse(init!.body as string);
      expect(request.model).toBe('campaign-model');
      expect(JSON.parse(JSON.parse(request.input[0].content).concept)).toEqual({
        playerConcept: 'A wandering medic',
        campaign: config,
      });
      expect(request.instructions).toContain("campaign's language");
      expect(request.instructions).toContain("campaign's setting");
      expect(request.instructions).toContain('Write all generated player-facing prose in Dutch (Nederlands)');
      expect(request.instructions).toContain(
        'Keep core game mechanics terms in English: STR, DEX, INT, CHA, CON, WIS, HP, XP, DC, attack, strike, mend, guard, assist',
      );
      expect(request.instructions).toContain('Never translate JSON property names, enum values, IDs');
      expect(request.input[0].content).not.toContain(campaign.displayToken);
      expect(request.input[0].content).not.toContain(campaign.inviteCode);
      expect(request.input[0].content).not.toContain(member.id);
    }
    for (const [owner] of vi.mocked(auth.accessToken).mock.calls) expect(owner).toBe(host.id);
    expect(game.snapshot(campaign.id, host.id)).toEqual(before);
    expect(game.characters(host.id)).toEqual([]);
    expect(game.characters(stranger.id)).toEqual([]);
  } finally {
    await close();
  }
});

it('rejects inaccessible and missing campaign context before requesting generation', async () => {
  const { host, stranger, campaign, providers, fetcher, generate, close } = await fixture();
  try {
    expect((await generate(stranger.token!, { campaignId: campaign.id })).statusCode).toBe(403);
    expect((await generate(host.token!, { campaignId: randomUUID() })).statusCode).toBe(404);
    expect((await generate(host.token!, { campaignId: 'not-a-campaign-id' })).statusCode).toBe(400);
    expect(providers).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it('keeps generation without attached context on the player connection and selected model', async () => {
  const { host, providers, fetcher, auth, generate, close } = await fixture();
  try {
    vi.stubGlobal('fetch', fetcher);
    expect((await generate(host.token!)).statusCode).toBe(200);
    expect(providers).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) {
      const request = JSON.parse(init!.body as string);
      expect(request.model).toBe('personal-model');
      expect(JSON.parse(request.input[0].content).concept).toBe('A wandering medic');
    }
    for (const [owner] of vi.mocked(auth.accessToken).mock.calls) expect(owner).toBe(host.id);
  } finally {
    await close();
  }
});

it('preserves an explicit character name through generation and saving in every context', async () => {
  const { app, game, host, campaign, fetcher, generate, close } = await fixture();
  try {
    vi.stubGlobal('fetch', fetcher);
    const name = 'Ária “Starfall”';
    const contexts: Record<string, string>[] = [
      {},
      { campaignId: campaign.id },
      { code: campaign.inviteCode! },
    ];
    for (const context of contexts) {
      const response = await generate(host.token!, { ...context, name: `  ${name}  ` });
      expect(response.statusCode).toBe(200);
      const character = response.json();
      expect(character.name).toBe(name);
      character.abilities = ['combat', 'utility'].map((kind) =>
        character.abilityOptions.find((a: Ability) => a.kind === kind),
      );
      character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item: Item) => item.id);
      const saved = await app.inject({
        method: 'POST',
        url: '/api/characters',
        headers: { 'x-gather-request': '1' },
        cookies: { gather_session: host.token! },
        payload: character,
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().name).toBe(name);
    }
    expect(game.characters(host.id).map((character) => character.name)).toEqual([name, name, name]);
    for (const [, init] of fetcher.mock.calls) {
      const request = JSON.parse(init!.body as string);
      const input = JSON.parse(request.input[0].content);
      expect(JSON.parse(input.concept)).toMatchObject({
        playerConcept: 'A wandering medic',
        characterName: name,
      });
      if (input.rolledEquipment) expect(input.character.name).toBe(name);
      expect(request.instructions).toContain('character name');
    }
  } finally {
    await close();
  }
});

it('validates explicit names before requesting character generation', async () => {
  const { host, campaign, providers, fetcher, generate, close } = await fixture();
  try {
    for (const name of ['', '   ', 'x'.repeat(61)]) {
      const response = await generate(host.token!, { campaignId: campaign.id, name });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('name:');
    }
    expect(providers).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it('lets a fallen player generate in their campaign context, save their picks, and queue the character', async () => {
  const { app, db, game, host, member, campaign, generate, close } = await fixture();
  try {
    const survivor = game.saveCharacter(host.id, templateCharacter('Survivor'));
    game.join(campaign.inviteCode!, host.id, survivor.id);
    const fallen = game.members(campaign.id).find((candidate) => candidate.playerId === member.id)!;
    fallen.state.hp = 0;
    fallen.state.deathReason = 'The bridge collapsed.';
    db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(fallen.state), fallen.id);
    db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").run(campaign.id);
    const generated = await generate(member.token!, { campaignId: campaign.id, name: 'New traveller' });
    expect(generated.statusCode, generated.body).toBe(200);
    const character = generated.json();
    character.concept = 'A wandering medic';
    character.abilities = ['combat', 'utility'].map((kind) =>
      character.abilityOptions.find((a: Ability) => a.kind === kind),
    );
    character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item: Item) => item.id);
    const saved = await app.inject({
      method: 'POST',
      url: '/api/characters',
      headers: { 'x-gather-request': '1' },
      cookies: { gather_session: member.token! },
      payload: character,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const queued = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${campaign.id}/replacement`,
      headers: { 'x-gather-request': '1' },
      cookies: { gather_session: member.token! },
      payload: { characterId: saved.json().id },
    });
    expect(queued.statusCode, queued.body).toBe(200);
    const current = game.members(campaign.id).find((candidate) => candidate.id === fallen.id)!;
    expect(current.state.hp).toBe(0);
    expect(current.character.name).toBe(fallen.character.name);
    expect(current.replacement?.character).toMatchObject({
      name: 'New traveller',
      selectedEquipmentIds: character.selectedEquipmentIds,
    });
  } finally {
    await close();
  }
});

it('keeps practice character concepts valid with long campaign context and preserves standalone prose', async () => {
  const gm = new PracticeGM();
  const playerConcept = 'An optimistic android medic';
  const envelope = JSON.stringify({
    playerConcept,
    campaign: {
      name: 'Rust garden',
      setting: 'An abandoned orbital garden',
      premise: 'The station is being reclaimed by strange plant life. '.repeat(30),
    },
  });
  expect(envelope.length).toBeGreaterThan(1000);
  const character = await gm.generate(envelope);
  expect(characterSchema.parse(character).concept).toBe(playerConcept);
  expect((await gm.generate(JSON.stringify({ playerConcept, characterName: 'Ada' }))).concept).toBe(
    playerConcept,
  );
  for (const concept of ['A medic who paints {stars}', '{"name":"A living notebook"}'])
    expect((await gm.generate(concept)).concept).toBe(concept);
});
