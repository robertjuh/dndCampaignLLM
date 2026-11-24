import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openDatabase } from '../server/db';
import { Game } from '../server/game';
import { PracticeGM } from '../server/providers';
import { templateCharacter } from '../shared/schema';

async function table() {
  const db = openDatabase(':memory:');
  const gm = new PracticeGM();
  const game = new Game(
    db,
    () => gm,
    () => 12,
  );
  const host = game.identify().id;
  const campaign = game.create(host, {
    name: 'Table',
    setting: 'Harbor',
    tone: '',
    premise: '',
    instructions: '',
    language: 'English',
    custom: [],
    provider: 'practice',
  });
  const players = ['Aster', 'Finn'].map((name) => {
    const player = game.identify().id;
    const sheet = templateCharacter(name);
    sheet.selectedEquipmentIds = sheet.equipmentOptions.slice(0, 3).map((i) => i.id);
    game.join(campaign.inviteCode!, player, game.saveCharacter(player, sheet).id);
    return player;
  });
  const id = campaign.id;
  game.start(id, host);
  await game.idle();
  const snap = (player = players[0]) => game.snapshot(id, player);
  expect(snap().turn?.phase, snap().turn?.error ?? '').toBe('collecting');
  const npcId = Object.values(snap().scene.npcs ?? {}).find((n) => n.name === 'Wayfinder')!.id;
  const start = () => game.chats.command(id, players[0], { type: 'start', npcId });
  await start();
  const conversationId = snap().npcConversation!.id;
  const message = (text: string, messageId = randomUUID()) =>
    game.chats.command(id, players[0], { type: 'message', conversationId, messageId, text });
  return { game, db, gm, players, host, id, npcId, start, snap, message, conversationId };
}

it('shares live dialogue, confirms a priced offer once and publishes the resolved action', async () => {
  const {
    game,
    db,
    gm,
    players: [a, b],
    id,
    npcId,
    snap,
    message,
    conversationId,
  } = await table();
  try {
    await expect(game.chats.command(id, b, { type: 'start', npcId })).rejects.toThrow('already open');
    await expect(
      game.chats.command(id, b, { type: 'message', conversationId, messageId: randomUUID(), text: 'Hello' }),
    ).rejects.toThrow('Only the speaker');
    const [actor] = game.members(id);
    gm.npcReply = async () => ({
      text: 'Five tokens for directions.',
      offer: { action: 'Ask for directions', cost: 5 },
    });
    const messageId = randomUUID();
    await message('Can you help?', messageId);
    await message('Can you help?', messageId);
    expect(snap(b).npcConversation!.messages).toHaveLength(2);
    expect(snap(game.identify().id).npcConversation!.messages).toEqual([]);
    expect(game.members(id)[0].state.currency).toBe(0);
    const offer = snap().npcConversation!.offer!;
    const accept = () => game.chats.command(id, a, { type: 'accept', conversationId, offerId: offer.id });
    await expect(accept()).rejects.toThrow('afford');
    actor.state.currency = 5;
    db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(actor.state), actor.id);
    await accept();
    await expect(accept()).rejects.toThrow('expired');
    expect(snap().turn!.actions[0].npcDeal?.cost).toBe(5);
    game.submit(id, b, offer.turnId, '', true);
    await game.idle();
    const after = snap(b);
    expect(after.turn?.phase, after.turn?.error ?? '').toBe('collecting');
    expect(after.history.at(-1)!.actions[0].npcDeal?.cost).toBe(5);
    expect(after.npcConversation!.messages.at(-1)?.id).toBe(offer.turnId);
    expect(game.members(id)[0].state.currency).toBe(after.history.at(-1)!.result!.currency);
  } finally {
    db.close();
  }
});

it('rejects stale offers, keeps ordinary turns available, and discards a reply after the leader ends a chat', async () => {
  const {
    game,
    db,
    gm,
    players: [a, b],
    host,
    id,
    start,
    snap,
    message,
    conversationId,
  } = await table();
  try {
    await message('Can you help?');
    const offer = snap().npcConversation!.offer!;
    game.submit(id, a, offer.turnId, '', true);
    game.submit(id, b, offer.turnId, '', true);
    await game.idle();
    expect(snap().npcConversation!.offer).toBeUndefined();
    await expect(
      game.chats.command(id, a, { type: 'accept', conversationId, offerId: offer.id }),
    ).rejects.toThrow('expired');
    let finish!: () => void;
    gm.npcReply = () =>
      new Promise((resolve) => {
        finish = () => resolve({ text: 'Late reply', offer: null });
      });
    const pending = message('Still there?');
    expect(snap(b).npcConversation?.replying).toBe(true);
    await game.chats.command(id, host, { type: 'end', conversationId });
    await start();
    finish();
    await pending;
    expect(snap().npcConversation!.messages).toEqual([]);
  } finally {
    db.close();
  }
});

it('recovers the transcript after a failed reply and checks NPC presence again on confirmation', async () => {
  const {
    game,
    db,
    gm,
    players: [a, b],
    id,
    npcId,
    snap,
    message,
    conversationId,
  } = await table();
  try {
    const scriptedReply = gm.npcReply.bind(gm);
    gm.npcReply = async () => {
      throw new Error('Temporarily offline');
    };
    const requestId = randomUUID();
    await expect(message('Can you help?', requestId)).rejects.toThrow('offline');
    const reopened = new Game(db, () => gm);
    expect(reopened.snapshot(id, b).npcConversation?.messages).toHaveLength(1);
    expect(reopened.snapshot(id, a).npcConversation?.replying).toBe(false);
    gm.npcReply = scriptedReply;
    await reopened.chats.command(id, a, {
      type: 'message',
      conversationId,
      messageId: requestId,
      text: 'Can you help?',
    });
    const chat = snap().npcConversation!;
    expect(chat.messages.map((m) => m.role)).toEqual(['speaker', 'npc']);
    const scene = snap().scene;
    scene.npcs![npcId].locationId = null;
    db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), id);
    await expect(
      game.chats.command(id, a, { type: 'accept', conversationId, offerId: chat.offer!.id }),
    ).rejects.toThrow('same location');
    expect(snap().turn!.actions).toHaveLength(0);
  } finally {
    db.close();
  }
});
