import { expect, it, vi } from 'vitest';
import { openDatabase } from '../server/db';
import { Game, type GMContext, type GameTools } from '../server/game';
import { PracticeGM } from '../server/providers';
import { templateCharacter } from '../shared/schema';
import { equippedItems } from '../shared/rules';

it('persists public item hooks and private conflicting rumours across an opening retry', async () => {
  const db = openDatabase(':memory:');
  let fail = true;
  class StoryGM extends PracticeGM {
    generateStartingStories = vi.fn(async (context: GMContext) =>
      context.members.map((member, index) => ({
        memberId: member.id,
        itemId: equippedItems(member.state)[0].id,
        hook: 'A crescent mark on this item matches the missing vessel’s seal.',
        rumour:
          index === 0
            ? 'A dockworker told you the missing vessel sailed north.'
            : 'An innkeeper told you the missing vessel sailed south.',
      })),
    );
    async adjudicate(context: GMContext, tools: GameTools) {
      if (fail) throw new Error('Interrupted after starting stories were saved');
      return super.adjudicate(context, tools);
    }
  }
  const provider = new StoryGM();
  let game = new Game(db, () => provider);
  try {
    const host = game.identify();
    const players = [game.identify(), game.identify()];
    const campaign = game.create(host.id, {
      name: 'Missing vessel',
      setting: 'Harbor',
      premise: 'A vessel has vanished',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
    });
    for (const [index, player] of players.entries()) {
      const character = templateCharacter(`Traveller ${index}`);
      character.selectedEquipmentIds = character.equipmentOptions.slice(0, 3).map((item) => item.id);
      game.join(campaign.inviteCode!, player.id, game.saveCharacter(player.id, character).id);
    }
    game.start(campaign.id, host.id);
    await game.idle();
    expect(game.snapshot(campaign.id, host.id).turn!.phase).toBe('failed');
    expect(provider.generateStartingStories).toHaveBeenCalledOnce();
    fail = false;
    game = new Game(db, () => provider);
    game.retry(campaign.id, host.id);
    await game.idle();
    expect(game.snapshot(campaign.id, host.id).turn!.phase).toBe('collecting');
    expect(provider.generateStartingStories).toHaveBeenCalledOnce();
    const members = game.members(campaign.id);
    expect(
      members.every((member) => equippedItems(member.state).filter((item) => item.storyHook).length === 1),
    ).toBe(true);
    expect(game.snapshot(campaign.id, host.id).history[0].result!.narration).toContain('crescent mark');
    const north = members[0].state.startingRumour!;
    const south = members[1].state.startingRumour!;
    const first = JSON.stringify(game.snapshot(campaign.id, players[0].id));
    const second = JSON.stringify(game.snapshot(campaign.id, players[1].id));
    expect(first).toContain(north);
    expect(first).not.toContain(south);
    expect(second).toContain(south);
    expect(second).not.toContain(north);
    expect(JSON.stringify(game.snapshot(campaign.id, host.id))).not.toContain('told you');
  } finally {
    await game.idle();
    db.close();
  }
});
