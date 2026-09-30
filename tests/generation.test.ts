import { expect, it, vi } from 'vitest';
import { ChatGPTGM, readResponseStream } from '../server/providers';
import type { ChatGPTAuth } from '../server/auth';
import { templateCharacter } from '../shared/schema';

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
it('generates from subscription item events in one request', async () => {
  const sheet = templateCharacter('Sea warrior', 'Custom sea creature');
  const fetcher = vi.fn(
    async () =>
      streamedItems([{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(sheet) }] }])
        .response,
  );
  const gm = new ChatGPTGM(auth, 'owner', '', fetcher as typeof fetch);
  expect(await gm.generate('sea warrior')).toEqual(sheet);
  expect(fetcher).toHaveBeenCalledOnce();
});
it('returns precise validation errors to the model for a correction', async () => {
  const sheet = templateCharacter('Sea warrior');
  const drafts = [{ ...sheet, weaponOptions: [] }, sheet];
  const fetcher = vi.fn(
    async (_url: unknown, _init: RequestInit | undefined) =>
      streamedItems([
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(drafts.shift()) }] },
      ]).response,
  );
  const gm = new ChatGPTGM(auth, 'owner', '', fetcher as typeof fetch);
  await expect(gm.generate('sea warrior')).resolves.toEqual(sheet);
  const retry = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
  expect(retry.input.at(-1).content).toContain('weaponOptions:');
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
