import { expect, it, vi } from 'vitest';
import { openDatabase } from '../server/db';
import { Game, type GMContext, type GameMaster, type GameTools } from '../server/game';
import { PracticeGM } from '../server/providers';
import { compileSceneTurn } from '../server/scene-turn';
import type { Investigation, InvestigationResult } from '../shared/investigation';
import { ensureLocations, memberScene } from '../shared/locations';
import { initialScene } from '../shared/rules';
import { templateCharacter } from '../shared/schema';

const knownAnswer = 'Tavi sailed north aboard a skiff with a blue heron painted on its bow.';
const newAnswer = 'The canal clerk accepted a brass token to conceal the skiff’s cargo manifest.';

async function table(build: (context: GMContext, tools: GameTools) => ReturnType<typeof compileSceneTurn>) {
  const db = openDatabase(':memory:');
  const practice = new PracticeGM();
  const adjudicate = vi.fn(async (context: GMContext, tools: GameTools) =>
    context.turn.number ? build(context, tools) : practice.adjudicate(context, tools),
  );
  const provider: GameMaster = {
    sceneTurns: true,
    adjudicate,
    narrate: vi.fn(practice.narrate.bind(practice)),
  };
  const draw = vi.fn((sides: number) => (sides === 20 ? 18 : sides));
  const game = new Game(db, () => provider, draw);
  const host = game.identify();
  const campaign = game.create(host.id, {
    name: 'Canal witness lifecycle',
    setting: 'Canalport',
    premise: 'Discover what happened to Tavi and the missing cargo.',
    tone: 'Adventure',
    instructions: '',
    custom: [],
    language: 'English',
    provider: 'chatgpt',
    model: 'test',
  });
  const players = [game.identify(), game.identify()];
  for (const [index, player] of players.entries()) {
    const character = game.saveCharacter(player.id, templateCharacter(['Lobsterano', 'Sofa king'][index]));
    game.join(campaign.inviteCode!, player.id, character.id);
    const member = game.members(campaign.id).find((member) => member.playerId === player.id)!;
    game.manageCharacter(campaign.id, player.id, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
  }
  game.start(campaign.id, host.id);
  await game.idle();
  const members = game.members(campaign.id);
  const scene = ensureLocations(
    initialScene('Canal quay'),
    members.map((member) => member.id),
  );
  scene.currencyName = 'canal marks';
  scene.encounterRisk = {
    danger: 'safe',
    reason: 'Working crews and willing witnesses share a quiet public quay.',
  };
  db.prepare('UPDATE campaigns SET scene=?,gm_memory=? WHERE id=?').run(
    JSON.stringify(scene),
    '[]',
    campaign.id,
  );
  expect(game.pending(campaign.id)?.phase).toBe('collecting');
  adjudicate.mockClear();
  draw.mockClear();
  provider.narrate = vi.fn(practice.narrate.bind(practice));
  const submit = (actions: [string, string]) => {
    const turnId = game.pending(campaign.id)!.id;
    players.forEach((player, index) =>
      game.submit(campaign.id, player.id, turnId, actions[index], !actions[index]),
    );
    return turnId;
  };
  return { db, game, host, campaign, players, members, provider, draw, adjudicate, submit };
}

function interview(
  context: GMContext,
  memberId: string,
  person = {
    id: 'new:canal-pilot',
    name: 'Canal pilot',
    description: 'A willing pilot who watched Tavi depart from this quay.',
  },
  hook = 'pilot-account',
  answer = knownAnswer,
  checked = false,
): Investigation {
  const at = memberScene(context.scene, memberId).location.id!;
  return {
    memberId,
    source: { kind: 'npc', ...person, locationId: at },
    question:
      answer === knownAnswer ? 'Where did Tavi go?' : 'What did the clerk receive for hiding the manifest?',
    preparation: context.gmMemory?.some((note) => note.id === hook)
      ? { id: hook, ...(answer === newAnswer ? { discoveries: [knownAnswer, newAnswer] } : {}) }
      : {
          id: hook,
          locationId: at,
          cause: 'PRIVATE: The cargo collector paid to obscure the departing skiff’s manifest.',
          discoveries: [answer],
          actors: `${person.name} remembers the departure.`,
          nextChange: 'The cargo office closes at sunset.',
          dueTurn: null,
          status: 'open',
        },
    answer: answer === newAnswer && context.gmMemory?.some((note) => note.id === hook) ? 1 : 0,
    success: {
      text: `The ${person.name.toLowerCase()} says, “${answer}” The original cargo manifest is kept at the desk on this quay.`,
      lead: { fact: 'The original cargo manifest is kept at the desk on this quay.', locationId: at },
    },
    failure: {
      fact: 'The witness declines to discuss the hidden payment, but identifies the cargo office.',
      text: 'The witness refuses to discuss the payment. The cargo office on this quay retains the original manifest.',
      lead: { fact: 'The cargo office on this quay retains the original manifest.', locationId: at },
    },
    check: checked
      ? {
          stat: 'CHA',
          dc: 10,
          mode: 'normal',
          lethal: false,
          reason: `Persuade the ${person.name.toLowerCase()} to reveal a concealed detail.`,
          circumstances: { favorable: false, adverse: false },
          abilityName: null,
          assistsMemberId: null,
          assistedBy: [],
        }
      : null,
  };
}

function present(context: GMContext) {
  return compileSceneTurn(context, {
    version: 3,
    summary: 'The interviews establish what these witnesses know.',
    beats: context.turn.actions
      .filter((action) => !action.passed)
      .map((action) => ({ kind: 'investigate', actor: action.memberId })),
  });
}

it('shares a witness identity before publication and rewards each new answer once across actors and sources', async () => {
  let f: Awaited<ReturnType<typeof table>>;
  const receipts: InvestigationResult[][] = [];
  f = await table((context, tools) => {
    const active = context.turn.actions.filter((action) => !action.passed);
    const turn: InvestigationResult[] = [];
    if (context.turn.number === 1) {
      for (const [index, action] of active.entries()) {
        const request = interview(context, action.memberId);
        if (index) request.source.id = 'new:pilot-second-label';
        turn.push(tools.investigate!(request));
      }
      expect(Object.keys(JSON.parse(f.game.campaign(f.campaign.id).scene!).npcs ?? {})).toEqual([]);
      expect(turn.map((result) => result.source.id)).toEqual(['new:canal-pilot', 'new:canal-pilot']);
      expect(turn[1].signature).toBe(turn[0].signature);
      expect(turn.map((result) => result.reused)).toEqual([false, true]);
    } else {
      const request = interview(
        context,
        active[0].memberId,
        {
          id: 'new:canal-clerk',
          name: 'Canal clerk',
          description: 'A clerk at the quay cargo desk.',
        },
        'clerk-account',
        context.turn.number === 2 ? knownAnswer : newAnswer,
        true,
      );
      turn.push(tools.investigate!(request));
    }
    receipts.push(turn);
    return present(context);
  });
  try {
    f.submit(['Ask the canal pilot where Tavi went.', 'Question the canal pilot about Tavi’s departure.']);
    await f.game.idle();
    let snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.history.at(-1)?.result?.xp).toBe(10);
    expect(snapshot.history.at(-1)?.rolls).toEqual([]);
    expect(snapshot.members.map((member) => member.state.xp)).toEqual([10, 10]);
    expect(Object.keys(snapshot.scene.npcs ?? {})).toEqual(['new:canal-pilot']);
    expect(snapshot.scene.npcs?.['new:canal-pilot']).toMatchObject({
      name: 'Canal pilot',
      locationId: snapshot.scene.location.id,
    });
    expect(f.draw).not.toHaveBeenCalled();

    f.submit(['Ask the canal clerk where Tavi went.', '']);
    await f.game.idle();
    snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(receipts[1][0]).toMatchObject({ source: { id: 'new:canal-clerk' }, reused: true, success: true });
    expect(receipts[1][0].rollId).toBeUndefined();
    expect(snapshot.history.at(-1)?.rolls).toEqual([]);
    expect(snapshot.history.at(-1)?.result?.xp).toBe(0);
    expect(snapshot.members.map((member) => member.state.xp)).toEqual([10, 10]);
    expect(snapshot.history.at(-1)?.result?.narration).toContain(knownAnswer);
    expect(snapshot.history.at(-1)?.result?.narration).not.toContain('pilot says');
    expect(snapshot.scene.npcs?.['new:canal-clerk']).toMatchObject({
      name: 'Canal clerk',
      locationId: snapshot.scene.location.id,
    });
    expect(f.draw).not.toHaveBeenCalled();

    f.submit(['Question the canal clerk about the payment for hiding the manifest.', '']);
    await f.game.idle();
    snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(receipts[2][0]).toMatchObject({ reused: false, success: true, finding: { fact: newAnswer } });
    expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(1);
    expect(f.draw.mock.calls.filter(([sides]) => sides === 20)).toHaveLength(1);
    expect(snapshot.history.at(-1)?.result?.xp).toBe(10);
    expect(snapshot.members.map((member) => member.state.xp)).toEqual([20, 20]);
    expect(snapshot.history.at(-1)?.result?.narration.split(newAnswer)).toHaveLength(2);
    expect(snapshot.journal.some((entry) => entry.detail.includes(newAnswer))).toBe(true);
    expect(f.adjudicate).toHaveBeenCalledTimes(3);
    expect(f.provider.narrate).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
  } finally {
    f.db.close();
  }
});

it('publishes a selected NPC answer after restart without repeating its provider or check', async () => {
  let chosen: InvestigationResult;
  const f = await table((context, tools) => {
    const action = context.turn.actions.find((action) => !action.passed)!;
    chosen = tools.investigate!(
      interview(context, action.memberId, undefined, 'pilot-account', knownAnswer, true),
    );
    return present(context);
  });
  try {
    f.db.exec(
      "CREATE TRIGGER interrupt_witness_publication BEFORE UPDATE OF gm_memory ON campaigns BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;",
    );
    const turnId = f.submit(['Question the canal pilot about the concealed departure.', '']);
    await f.game.idle();
    expect(f.game.pending(f.campaign.id)?.phase).toBe('failed');
    expect(f.adjudicate).toHaveBeenCalledTimes(1);
    expect(f.draw.mock.calls.filter(([sides]) => sides === 20)).toHaveLength(1);
    const saved = JSON.parse(f.game.pending(f.campaign.id)!.draft!);
    expect(saved.receipts[`investigation:${chosen!.memberId}`]).toEqual(chosen!);
    expect(saved.resolution).toBeTruthy();
    expect(Object.keys(JSON.parse(f.game.campaign(f.campaign.id).scene!).npcs ?? {})).toEqual([]);
    const draws = f.draw.mock.calls.length;
    f.db.exec('DROP TRIGGER interrupt_witness_publication');
    const restarted = new Game(f.db, () => f.provider, f.draw);
    restarted.retry(f.campaign.id, f.host.id);
    await restarted.idle();
    const snapshot = restarted.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.history.at(-1)?.id).toBe(turnId);
    expect(snapshot.history.at(-1)?.result?.narration).toContain(knownAnswer);
    expect(snapshot.history.at(-1)?.result?.xp).toBe(10);
    expect(snapshot.scene.npcs?.['new:canal-pilot']).toMatchObject({
      name: 'Canal pilot',
      locationId: snapshot.scene.location.id,
    });
    expect(f.adjudicate).toHaveBeenCalledTimes(1);
    expect(f.draw).toHaveBeenCalledTimes(draws);
    const completed = f.db.prepare('SELECT draft FROM turns WHERE id=?').get(turnId) as { draft: string };
    expect(JSON.parse(completed.draft).receipts[`investigation:${chosen!.memberId}`]).toEqual(chosen!);
    expect(JSON.parse(restarted.campaign(f.campaign.id).gm_memory)[0].revealed).toEqual([0]);
  } finally {
    f.db.close();
  }
});

it('retains a failed interview after the conversation is saved and rolls only for a new prepared answer', async () => {
  const receipts: InvestigationResult[] = [];
  const f = await table((context, tools) => {
    const actor = context.turn.actions.find((action) => !action.passed)!.memberId;
    receipts.push(
      tools.investigate!(
        interview(
          context,
          actor,
          {
            id: 'new:canal-clerk',
            name: 'Canal clerk',
            description: 'A cautious clerk who is reluctant to reveal the skiff’s concealed destination.',
          },
          'clerk-account',
          context.turn.number < 3 ? knownAnswer : newAnswer,
          true,
        ),
      ),
    );
    return present(context);
  });
  try {
    f.draw.mockImplementation((sides) => (sides === 20 ? 1 : sides));
    f.submit(['Question the canal clerk about Tavi’s concealed destination.', '']);
    await f.game.idle();
    let snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(receipts[0]).toMatchObject({ reused: false, success: false });
    expect(snapshot.scene.npcs?.['new:canal-clerk'].fact).not.toContain('A cautious clerk');
    expect(snapshot.history.at(-1)?.result?.xp).toBe(0);
    expect(snapshot.history.at(-1)?.result?.narration).not.toContain(knownAnswer);
    expect(f.draw.mock.calls.filter(([sides]) => sides === 20)).toHaveLength(1);

    f.submit(['Question the canal clerk about Tavi’s concealed destination again.', '']);
    await f.game.idle();
    snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(receipts[1]).toMatchObject({ reused: true, success: false, signature: receipts[0].signature });
    expect(receipts[1].finding.text).toBe(receipts[0].finding.text);
    expect(receipts[1].rollId).toBeUndefined();
    expect(snapshot.history.at(-1)?.rolls).toEqual([]);
    expect(snapshot.history.at(-1)?.result?.xp).toBe(0);
    expect(f.draw.mock.calls.filter(([sides]) => sides === 20)).toHaveLength(1);

    f.draw.mockImplementation((sides) => (sides === 20 ? 18 : sides));
    f.submit(['Question the canal clerk about the payment for hiding the manifest.', '']);
    await f.game.idle();
    snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(receipts[2]).toMatchObject({
      reused: false,
      success: true,
      answer: 1,
      finding: { fact: newAnswer },
    });
    expect(f.draw.mock.calls.filter(([sides]) => sides === 20)).toHaveLength(2);
    expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(1);
    expect(snapshot.history.at(-1)?.result?.xp).toBe(10);
    expect(snapshot.history.at(-1)?.result?.narration).toContain(newAnswer);
  } finally {
    f.db.close();
  }
});
