import { expect, it, vi } from 'vitest';
import { ChatGPTGM, readResponseStream } from '../server/providers';
import type { ChatGPTAuth } from '../server/auth';
import { templateCharacter, type Item } from '../shared/schema';

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
it('generates the character, then names five server-rolled equippable items', async () => {
  const {
    equipmentOptions: _,
    selectedEquipmentIds: __,
    ...sheet
  } = templateCharacter('Sea warrior', 'Custom sea creature');
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const context = JSON.parse(JSON.parse(init!.body as string).input[0].content);
    const value = context.rolledEquipment
      ? {
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
  expect(result).toMatchObject(sheet);
  expect(result.equipmentOptions).toHaveLength(5);
  expect(result.abilities.map((a) => a.kind)).toEqual(['combat', 'utility']);
  expect(result.traits).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('returns precise validation errors to the model for a correction', async () => {
  const { equipmentOptions: _, selectedEquipmentIds: __, ...sheet } = templateCharacter('Sea warrior');
  const drafts = [{ ...sheet, abilities: [] }, sheet];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const context = JSON.parse(JSON.parse(init!.body as string).input[0].content);
    const value = context.rolledEquipment
      ? {
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
  await expect(gm.generate('sea warrior')).resolves.toMatchObject(sheet);
  const retry = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
  expect(retry.input.at(-1).content).toContain('abilities:');
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
  const valid = {
    ability: { ...target, level: 2, description: 'Guide the strike around an obstacle with finer control.' },
    description: 'Your focused strike gains finer control.',
  };
  const drafts = [{ ...valid, ability: { ...valid.ability, kind: 'utility' } }, valid];
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
  expect(request.input.at(-1).content).toContain('category and level');
  expect(target.level).toBe(1);
});
