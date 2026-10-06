import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatGPTGM, readResponseStream } from '../server/providers';
import type { ChatGPTAuth } from '../server/auth';
import { templateCharacter, type Item, type Character } from '../shared/schema';

import { localDice } from '../server/random';

beforeEach(() => vi.spyOn(localDice, 'draw').mockReturnValue(1));
afterEach(() => vi.restoreAllMocks());
function generationSheet(character: Character) {
  const { equipmentOptions: _, selectedEquipmentIds: __, ...sheet } = character;
  return {
    ...sheet,
    combatAffinity: 'strike',
    abilities: [
      ...sheet.abilities,
      { ...sheet.abilities[0], name: 'Alternative combat ability' },
      { ...sheet.abilities[1], name: 'Alternative utility ability', description: 'Help with navigation.' },
    ],
  };
}

const frame = (data: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
const auth = {
  accessToken: async () => 'test-token',
  models: async () => [{ id: 'available-model', name: 'Available' }],
} as unknown as ChatGPTAuth;
function streamedItems(items: unknown[], terminal = 'response.completed', close = true) {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        // Arrive out of order to verify output_index, not arrival order, is used.
        items
          .map((item, output_index) => ({ item, output_index }))
          .reverse()
          .forEach((entry) => controller.enqueue(frame({ type: 'response.output_item.done', ...entry })));
        controller.enqueue(
          frame({
            type: terminal,
            response: { status: terminal === 'response.completed' ? 'completed' : 'failed', output: [] },
          }),
        );
        if (close) controller.close();
      },
      cancel,
    }),
  );
  return { response, cancel };
}
it('collects finished text and tool items when the completed envelope has empty output, without waiting for EOF', async () => {
  const items = [
    { type: 'reasoning', id: 'reasoning', summary: [] },
    { type: 'function_call', name: 'roll_check', call_id: 'call', arguments: '{}' },
    { type: 'message', content: [{ type: 'output_text', text: 'Complete text' }] },
  ];
  const { response, cancel } = streamedItems(items, 'response.completed', false);
  expect((await readResponseStream(response)).output).toEqual(items);
  expect(cancel).toHaveBeenCalledOnce();
});
it('never accepts finished items when inference subsequently fails', async () => {
  const { response } = streamedItems(
    [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }],
    'response.failed',
  );
  await expect(readResponseStream(response)).rejects.toThrow('could not complete');
});
it.each(['assist', 'mend'] as const)(
  'generates a character with utility %s, then names five server-rolled equippable items',
  async (utilityEffect) => {
    const sheet = generationSheet(templateCharacter('Sea warrior', 'Custom sea creature'));
    sheet.abilities[1].effect = utilityEffect;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const context = JSON.parse(JSON.parse(init!.body as string).input[0].content);
      const value = context.rolledEquipment
        ? {
            abilities: context.schemaExample.abilities,
            items: context.rolledEquipment.map((item: Item) => ({
              id: item.id,
              name: item.name,
              description: 'Custom equipment',
            })),
          }
        : sheet;
      return streamedItems([
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
      ]).response;
    });
    const result = await new ChatGPTGM(auth, 'owner', '', fetcher as typeof fetch).generate('sea warrior');
    const { abilities: _abilities, combatAffinity: _affinity, ...expectedSheet } = sheet;
    expect(result).toMatchObject(expectedSheet);
    expect(result.equipmentOptions).toHaveLength(5);
    expect(result.abilities).toEqual([]);
    expect(result.abilityOptions!.map((a) => a.kind)).toEqual(['combat', 'utility', 'combat', 'utility']);
    expect(result.abilityOptions!.filter((a) => a.kind === 'combat').map((a) => a.effect)).toEqual([
      'strike',
      'mend',
    ]);
    if (utilityEffect === 'mend') {
      expect(result.abilityOptions![1]).toMatchObject({
        kind: 'utility',
        effect: 'mend',
        dice: '1d4',
        bonus: 2,
        cures: ['Bleeding'],
      });
    }
    expect(result.traits).toHaveLength(2);
    expect(result.stats).toEqual({ STR: 5, DEX: 5, INT: 5, CHA: 5, CON: 5, WIS: 5 });
    const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(request.instructions).toContain('STR/DEX/INT/CHA/CON/WIS');
    expect(request.instructions).toContain('Each successful encounter restores one spent charge');
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);
it('preserves trait-derived asymmetry in the sheet and equipment generation context', async () => {
  const character = templateCharacter('Bram', 'Frail ogre');
  character.traits[0].stats = { ...character.traits[0].stats, STR: 6, INT: -4 };
  character.traits[1].stats = { ...character.traits[1].stats, CON: -4, WIS: 8 };
  const sheet = generationSheet(character);
  vi.mocked(localDice.draw).mockImplementation((sides) => (sides === 3 ? 3 : 1));
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const context = JSON.parse(JSON.parse(init!.body as string).input[0].content);
    const value = context.rolledEquipment
      ? {
          abilities: context.schemaExample.abilities,
          items: context.rolledEquipment.map(({ id, name, description }: Item) => ({
            id,
            name,
            description,
          })),
        }
      : sheet;
    return streamedItems([
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
    ]).response;
  });
  const result = await new ChatGPTGM(auth, 'owner', '', fetcher as typeof fetch).generate('a frail ogre');
  const expected = { STR: 13, DEX: 11, INT: 1, CHA: 5, CON: 1, WIS: 13 };
  expect(result.stats).toEqual(expected);
  expect(result.traits).toEqual(character.traits);
  expect(sheet.stats).toEqual({ STR: 5, DEX: 5, INT: 5, CHA: 5, CON: 5, WIS: 5 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
  expect(request.instructions).toContain('STR/DEX/INT/CHA/CON/WIS deltas -5..8');
  expect(request.instructions).toContain('Favor varied, asymmetric strengths');
  const equipmentContext = JSON.parse(JSON.parse(fetcher.mock.calls[1][1]!.body as string).input[0].content);
  expect(equipmentContext.character.stats).toEqual(expected);
  expect(result.equipmentOptions).toEqual(equipmentContext.rolledEquipment);
});
it('returns precise validation errors to the model for a correction', async () => {
  const sheet = generationSheet(templateCharacter('Sea warrior'));
  const drafts = [{ ...sheet, abilities: [] }, sheet];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const context = JSON.parse(JSON.parse(init!.body as string).input[0].content);
    const value = context.rolledEquipment
      ? {
          abilities: context.schemaExample.abilities,
          items: context.rolledEquipment.map(({ id, name, description }: Item) => ({
            id,
            name,
            description,
          })),
        }
      : drafts.shift();
    return streamedItems([
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
    ]).response;
  });
  const gm = new ChatGPTGM(auth, 'owner', '', fetcher as typeof fetch);
  await expect(gm.generate('sea warrior')).resolves.toMatchObject({ name: sheet.name, abilities: [] });
  const retry = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
  expect(retry.input.at(-1).content).toContain('abilities:');
});

it('lets the naming pass choose the final scaling stat after seeing the rolled combat effect', async () => {
  const sheet = generationSheet(templateCharacter('Battle medic'));
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const context = JSON.parse(JSON.parse(init!.body as string).input[0].content);
    const result = context.rolledEquipment
      ? {
          items: context.schemaExample.items,
          abilities: context.schemaExample.abilities.map((ability: { id: string; stat: string }) => ({
            ...ability,
            stat:
              context.abilityMechanics.find((offer: { id: string }) => offer.id === ability.id).effect ===
              'mend'
                ? 'WIS'
                : ability.stat,
          })),
        }
      : sheet;
    return streamedItems([
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] },
    ]).response;
  });
  const result = await new ChatGPTGM(auth, 'owner', '', fetcher as typeof fetch).generate('Battle medic');
  expect(result.abilityOptions!.find((a) => a.effect === 'mend')!.stat).toBe('WIS');
  const second = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
  expect(
    JSON.parse(second.input[0].content).abilityMechanics.map((a: { effect: string }) => a.effect),
  ).toContain('mend');
  expect(second.instructions).toContain('Now choose the scaling stat');
});
it('cancels even while model discovery is pending', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn();
  const slowAuth = { ...auth, models: () => new Promise(() => {}) } as unknown as ChatGPTAuth;
  const pending = new ChatGPTGM(slowAuth, 'owner', '', fetcher).generate('sea warrior', controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  expect(fetcher).not.toHaveBeenCalled();
});

it('corrects an invalid ability upgrade while keeping the server-selected target', async () => {
  const character = templateCharacter('Storm spectre');
  const target = character.abilities[0];
  target.dice = '2d8';
  target.bonus = 2;
  const valid = {
    ability: { ...target, level: 2, description: 'Guide the strike around an obstacle with finer control.' },
    description: 'Your focused strike gains finer control.',
  };
  const drafts = [
    { ...valid, ability: { ...valid.ability, dice: '2d4' } },
    { ...valid, ability: { ...valid.ability, bonus: 0 } },
    valid,
  ];
  const fetcher = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      streamedItems([
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(drafts.shift()) }] },
      ]).response,
  );
  const { initialState } = await import('../shared/rules');
  const { campaignSchema } = await import('../shared/schema');
  const context = {
    character,
    state: initialState(character, 'test'),
    target,
    attributes: [],
    choice: 'upgrade-combat' as const,
    config: campaignSchema.parse({
      name: 'Test',
      setting: 'Clouds',
      premise: '',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'chatgpt',
    }),
  };
  const result = await new ChatGPTGM(auth, 'owner', '', fetcher as typeof fetch).levelUp(context);
  expect(result).toEqual(valid);
  const request = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
  expect(JSON.parse(request.input[0].content).target).toEqual(target);
  expect(request.input.at(-1).content).toContain('dice, and rolled bonus');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(target.level).toBe(1);
});
