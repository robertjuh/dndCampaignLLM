import { interruptNarration } from './narration-interruption';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../server/db';
import { Game, type GameMaster, type GMContext } from '../server/game';
import { engineEvents, engineComponents, validateAdjudication } from '../server/turn-resolution';
import { normalizeCombatInput } from '../server/combat';
import { validateEnvironmentalAction } from '../server/environment';
import { migrateLocations } from '../server/location-migration';
import {
  actionId,
  aggregateComponents,
  factualNarration,
  turnAdjudicationSchema,
  type TurnAdjudication,
} from '../shared/turn-resolution';
import { adjudicationInput, ChatGPTGM } from '../server/providers';
import type { ChatGPTAuth } from '../server/auth';
import { baseItem } from '../shared/rules';
import { ensureLocations, memberScene, updateLocation } from '../shared/locations';
import {
  templateCharacter,
  enemySchema,
  type Scene,
  type Outcome,
  type EnvironmentalAction,
} from '../shared/schema';

const close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach((fn) => fn()));

function routine(context: GMContext): TurnAdjudication {
  const events = engineEvents(context);
  const actions = context.turn.actions.map((submitted) => {
    const id = actionId(context.turn.id, submitted.memberId);
    if (submitted.passed) {
      const passId = `${id}:pass`;
      const own = events.filter((event) => event.actionId === id);
      events.push({
        id: passId,
        sequence: events.length,
        kind: 'action',
        actionId: id,
        memberId: submitted.memberId,
        fact: 'The character waits.',
        receiptRefs: [],
        dependsOn: [],
        phase: null,
        result: null,
      });
      return {
        actionId: id,
        memberId: submitted.memberId,
        status: 'passed' as const,
        basis: 'none' as const,
        fact: 'The character waits.',
        reason: 'Passed.',
        receiptRefs: [...new Set(own.flatMap((event) => event.receiptRefs))],
        eventIds: [...own.map((event) => event.id), passId],
        components: { main: null, minor: null },
      };
    }
    if (context.combatResult?.participantIds?.includes(submitted.memberId)) {
      const constraints = engineComponents(context, submitted.memberId);
      const component = (phase: 'main' | 'minor') => {
        const disposition = constraints[phase];
        if (!disposition) return null;
        const own = events.filter((event) => event.actionId === id && event.phase === phase);
        return {
          ...disposition,
          fact: own.map((event) => event.fact).join(' '),
          reason: 'Saved combat outcome.',
          receiptRefs: [...new Set(own.flatMap((event) => event.receiptRefs))],
          eventIds: own.map((event) => event.id),
        };
      };
      const components = { main: component('main'), minor: component('minor') };
      const own = events.filter((event) => event.actionId === id);
      return {
        actionId: id,
        memberId: submitted.memberId,
        ...aggregateComponents(components, false),
        components,
        fact: own.map((event) => event.fact).join(' '),
        reason: 'Saved combat outcome.',
        receiptRefs: [...new Set(own.flatMap((event) => event.receiptRefs))],
        eventIds: own.map((event) => event.id),
      };
    }
    const check = context.turn.rolls.find((roll) => roll.memberId === submitted.memberId && !roll.notation);
    const own = events.filter((event) => event.actionId === id);
    const eventId = `${id}:result`;
    const fact = 'The submitted interaction resolves in the established scene.';
    const status = check && !check.success ? ('failure' as const) : ('success' as const);
    const basis = check ? ('check' as const) : ('routine' as const);
    const receiptRefs = check ? [`roll:${check.id}`] : [];
    events.push({
      id: eventId,
      sequence: events.length,
      kind: 'action',
      actionId: id,
      memberId: submitted.memberId,
      fact,
      receiptRefs,
      dependsOn: own.map((event) => ({ eventId: event.id, requires: 'occurrence' as const })),
      phase: 'main',
      result: status,
    });
    const component = {
      status,
      basis,
      fact,
      reason: 'Established circumstances.',
      receiptRefs,
      eventIds: [...own.map((event) => event.id), eventId],
    };
    return {
      actionId: id,
      memberId: submitted.memberId,
      ...component,
      components: { main: component, minor: null },
    };
  });
  if (!events.length)
    events.push({
      id: 'world:opening',
      sequence: 0,
      kind: 'world',
      actionId: null,
      memberId: null,
      fact: 'A visible passage connects the checkpoint to the bunker.',
      receiptRefs: [],
      dependsOn: [],
      phase: 'aftermath',
      result: null,
    });
  return {
    version: 2,
    turnId: context.turn.id,
    actions,
    events,
    changes: [],
    journal: [],
    location: null,
    memberLocations: [],
    rewards: { xp: 0, currency: 0, reason: 'No new achievement.' },
  };
}

function travelling(context: GMContext, movers: { id: string }[]) {
  const value = routine(context);
  value.memberLocations = movers.map((member) => {
    const event = value.events.find(
      (event) => event.memberId === member.id && event.kind === 'action' && event.phase === 'main',
    );
    if (event) event.effect = 'movement';
    return { memberId: member.id, locationId: 'destination', movementEventId: event?.id };
  });
  return value;
}

async function table() {
  const db = openDatabase(':memory:');
  close.push(() => db.close());
  const provider: GameMaster = {
    adjudicate: async (context) => routine(context),
    narrate: async (resolution, config) => factualNarration(resolution, config.language),
  };
  const game = new Game(
    db,
    () => provider,
    (sides) => Math.min(sides, 12),
  );
  const host = game.identify();
  const players = [game.identify(), game.identify()];
  const campaign = game.create(host.id, {
    name: 'Places',
    setting: 'Checkpoint',
    premise: '',
    tone: '',
    language: 'English',
    instructions: '',
    custom: [],
    provider: 'practice',
  });
  for (const [i, player] of players.entries()) {
    const character = templateCharacter(`Player ${i}`);
    character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
    const saved = game.saveCharacter(player.id, character);
    game.join(campaign.inviteCode!, player.id, saved.id);
  }
  game.start(campaign.id, host.id);
  await game.idle();
  const members = game.members(campaign.id);
  const snapshot = () => game.snapshot(campaign.id, host.id);
  const saveScene = (scene: Scene) =>
    db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), campaign.id);
  const turn = async (texts = ['Walk to the bunker.', 'Walk to the bunker.']) => {
    const id = snapshot().turn!.id;
    players.forEach((player, i) => game.submit(campaign.id, player.id, id, texts[i], !texts[i]));
    await game.idle();
    return id;
  };
  const travel = (location: NonNullable<Outcome['location']>, movers = members) => {
    provider.adjudicate = async (context) => ({
      ...travelling(context, movers),
      location,
    });
  };
  return { db, game, host, players, campaign, members, provider, snapshot, saveScene, turn, travel };
}

it.each(['explicit', 'omitted'])(
  'commits shared travel with %s movement markers in the usual three LLM calls',
  async (marker) => {
    const f = await table();
    const scene = f.snapshot().scene;
    const origin = scene.location.id!;
    const inn = crypto.randomUUID();
    scene.places![inn] = {
      location: { id: inn, name: 'Grey Pass Coaching Inn', atmosphere: 'A lit hearth.', hazard: '' },
      encounter: null,
      loot: [],
      encounterRisk: { danger: 'safe', reason: 'The coaching inn is staffed and sheltered.' },
    };
    scene.worldMap!.nodes[inn] = { id: inn, name: 'Grey Pass Coaching Inn', visited: true };
    scene.worldMap!.connections.push({
      from: origin,
      to: inn,
      label: 'Open road',
      blocked: false,
      bidirectional: true,
    });
    f.saveScene(scene);
    let current: GMContext;
    const requests: any[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      requests.push(body);
      let output: unknown;
      if (body.tools) {
        const value = travelling(current, f.members);
        value.sceneFocus = inn;
        for (const position of value.memberLocations!) {
          position.locationId = inn;
          const event = value.events.find((event) => event.id === position.movementEventId)!;
          event.locationRef = inn;
          event.fact = `${f.members.find((member) => member.id === position.memberId)!.character.name} reaches the Grey Pass Coaching Inn.`;
          if (marker === 'omitted') delete event.effect;
          const action = value.actions.find((action) => action.memberId === position.memberId)!;
          action.fact = action.components.main!.fact = event.fact;
        }
        output = value;
      } else {
        const input = JSON.parse(body.input[0].content);
        output = input.candidate
          ? { approved: true, feedback: '' }
          : factualNarration(input.resolution, 'English');
      }
      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
          },
        })}\n\n`,
      );
    }) as unknown as typeof fetch;
    const auth = { accessToken: async () => 'test' } as unknown as ChatGPTAuth;
    const gm = new ChatGPTGM(auth, 'owner', 'model', fetcher);
    f.provider.adjudicate = (context, tools) => {
      current = context;
      return gm.adjudicate(context, tools);
    };
    f.provider.narrate = gm.narrate.bind(gm);
    if (marker === 'omitted')
      f.db.exec(
        "CREATE TRIGGER interrupt_position_publication BEFORE UPDATE OF phase ON turns WHEN NEW.phase = 'complete' BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;",
      );
    const id = await f.turn(['Go to the inn.', 'Walk to the inn.']);
    expect(fetcher).toHaveBeenCalledTimes(3);
    if (marker === 'omitted') {
      expect(f.snapshot().turn?.phase).toBe('failed');
      f.db.exec('DROP TRIGGER interrupt_position_publication');
      const restarted = new Game(f.db, () => f.provider);
      restarted.retry(f.campaign.id, f.host.id);
      await restarted.idle();
      expect(fetcher).toHaveBeenCalledTimes(3);
    }
    const done = f.snapshot().history.at(-1)!;
    expect(done.id, f.snapshot().turn?.error ?? '').toBe(id);
    expect(done.rolls).toEqual([]);
    expect(done.resolution!.memberLocations).toEqual(
      Object.fromEntries(f.members.map((member) => [member.id, inn])),
    );
    expect(f.snapshot().scene.memberLocations).toEqual(done.resolution!.memberLocations);
    expect(done.result!.narration).toContain('reaches the Grey Pass Coaching Inn');
    expect(requests.map((request) => !!request.tools)).toEqual([true, false, false]);
  },
);

it('keeps loot, won encounters and spent sources at their place through travel, return and pickup', async () => {
  const f = await table();
  const scene = f.snapshot().scene;
  const checkpoint = { ...scene.location, atmosphere: 'Concrete and dust.' };
  scene.loot = [{ ...baseItem('old-loot', 'Checkpoint key', 'tool'), quantity: 1 }];
  scene.encounter = { enemies: [], initiative: [], round: 2, victory: true, escaped: false };
  scene.searchedLoot = { 'checkpoint:desk': 'Checkpoint key' };
  f.saveScene(scene);
  f.travel({ id: null, name: 'Bunker', atmosphere: 'A visible relay.', hazard: '' });
  await f.turn();
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  const bunker = f.snapshot().scene;
  expect(bunker.loot).toEqual([]);
  expect(bunker.encounter).toBeNull();
  expect(bunker.places![checkpoint.id!].loot[0].id).toBe('old-loot');
  expect(() =>
    f.game.manageCharacter(f.campaign.id, f.players[0].id, { type: 'take', itemId: 'old-loot' }),
  ).toThrow('no longer available');
  f.travel({ ...bunker.location, name: 'Renamed bunker' });
  await f.turn();
  expect(f.snapshot().scene.location.id).toBe(bunker.location.id);
  f.travel(checkpoint);
  await f.turn();
  expect(f.snapshot().scene.encounter?.victory).toBe(true);
  expect(f.snapshot().scene.searchedLoot).toEqual({ 'checkpoint:desk': 'Checkpoint key' });
  f.game.manageCharacter(f.campaign.id, f.players[0].id, { type: 'take', itemId: 'old-loot' });
  expect(f.snapshot().scene.loot).toEqual([]);
  expect(() =>
    f.game.manageCharacter(f.campaign.id, f.players[1].id, { type: 'take', itemId: 'old-loot' }),
  ).toThrow();
  expect(f.game.members(f.campaign.id)[0].state.xp).toBe(0);
});

it('preserves a split party and permits pickup only at the acting character’s location', async () => {
  const f = await table();
  const scene = f.snapshot().scene;
  const oldId = scene.location.id!;
  scene.loot = [{ ...baseItem('key', 'Key', 'tool'), quantity: 1 }];
  f.saveScene(scene);
  f.travel({ id: null, name: 'Bunker', atmosphere: 'Red light.', hazard: '' }, [f.members[0]]);
  await f.turn(['Enter the bunker.', '']);
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  const split = f.snapshot().scene;
  expect(split.memberLocations![f.members[1].id]).toBe(oldId);
  split.environment = { sources: {}, spentResources: ['bunker-only'] };
  split.searchedLoot = { 'bunker:desk': 'Spent bunker cache' };
  expect(memberScene(split, f.members[1].id).environment).toBeUndefined();
  expect(memberScene(split, f.members[1].id).searchedLoot).toBeUndefined();
  expect(memberScene(split, f.members[1].id).loot[0].id).toBe('key');
  expect(() =>
    f.game.manageCharacter(f.campaign.id, f.players[0].id, { type: 'take', itemId: 'key' }),
  ).toThrow();
  f.game.manageCharacter(f.campaign.id, f.players[1].id, { type: 'take', itemId: 'key' });
  f.game.manageCharacter(f.campaign.id, f.players[1].id, { type: 'drop', itemId: 'key' });
  expect(f.snapshot().scene.loot).toEqual([]);
  expect(memberScene(f.snapshot().scene, f.members[1].id).loot[0].id).toBe('key');
});

it('attributes a new destination discovery once and resumes finalized narration without replay', async () => {
  const f = await table();
  const oldId = f.snapshot().scene.location.id!;
  const adjudicate = vi.fn(
    async (context: GMContext, tools: Parameters<NonNullable<GameMaster['adjudicate']>>[1]) => {
      tools.offerLoot({
        memberId: f.members[0].id,
        locationId: 'destination',
        sourceId: 'bunker:desk',
        reason: 'A key on the reached desk.',
        item: {
          name: 'Desk key',
          kind: 'tool',
          description: 'A physical key.',
          scaling: [],
          hands: 1,
          light: true,
        },
      });
      return {
        ...travelling(context, f.members),
        location: { id: null, name: 'Bunker', atmosphere: 'A desk.', hazard: '' },
      };
    },
  );
  f.provider.adjudicate = adjudicate;
  const narrate = f.provider.narrate!;
  f.provider.narrate = async () => {
    interruptNarration(f.db, 'Narration interrupted');
  };
  const id = await f.turn();
  expect(f.snapshot().turn?.phase).toBe('failed');
  f.provider.narrate = narrate;
  const restarted = new Game(f.db, () => f.provider);
  restarted.retry(f.campaign.id, f.host.id);
  await restarted.idle();
  expect(f.snapshot().history.at(-1)?.id, f.snapshot().turn?.error ?? '').toBe(id);
  expect(adjudicate).toHaveBeenCalledTimes(1);
  expect(f.snapshot().scene.loot).toHaveLength(1);
  expect(f.snapshot().scene.places![oldId].loot).toEqual([]);
});

it('keeps challenge recovery after removing the rest action', async () => {
  const f = await table();
  const actor = f.game.members(f.campaign.id)[0];
  actor.state.hp -= 8;
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(actor.state), actor.id);
  f.provider.adjudicate = async (context, tools) => {
    tools({
      memberId: actor.id,
      stat: 'INT',
      dc: 5,
      mode: 'normal',
      lethal: false,
      reason: 'Alter the dossier.',
    });
    tools.completeChallenge({ memberId: actor.id, reason: 'Dossier changed.', bossEquivalent: false });
    return routine(context);
  };
  await f.turn(['Alter the dossier.', '']);
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  expect(f.game.members(f.campaign.id)[0].state.hp).toBeGreaterThan(actor.state.hp);
  const recovered = f.game.members(f.campaign.id)[0].state;
  expect(() => f.game.manageCharacter(f.campaign.id, f.players[0].id, { type: 'rest' })).toThrow(
    'Unknown character action',
  );
  expect(f.game.members(f.campaign.id)[0].state).toEqual(recovered);
  expect(f.snapshot().scene).not.toHaveProperty('safeRest');
});

it('rejects location changes for a passing or failed character', async () => {
  const f = await table();
  f.travel({ id: null, name: 'Bunker', atmosphere: 'Red light.', hazard: '' });
  await f.turn(['Enter the bunker.', '']);
  expect(f.snapshot().turn?.error).toContain('successful submitted movement');
});

it('keeps party goals optional, host-authored and locked while a saved turn finishes', async () => {
  const f = await table();
  expect(f.snapshot().config.partyGoal).toBeUndefined();
  expect(() => f.game.setPartyGoal(f.campaign.id, f.players[0].id, 'Escape.')).toThrow();
  f.game.setPartyGoal(f.campaign.id, f.host.id, 'Change our dossier.');
  expect(f.snapshot().config.partyGoal).toBe('Change our dossier.');
  f.provider.narrate = async () => {
    interruptNarration(f.db, 'Pause at saved narration');
  };
  await f.turn();
  expect(() => f.game.setPartyGoal(f.campaign.id, f.host.id, 'Another goal')).toThrow('Wait');
});

it('migrates proven legacy loot, isolates ambiguous items and preserves completed history and character state', async () => {
  const f = await table();
  const old = f.snapshot().scene;
  old.loot = [{ ...baseItem('key', 'Key', 'tool'), quantity: 1 }];
  f.saveScene(old);
  f.travel({ id: null, name: 'Bunker', atmosphere: 'Exposed wires.', hazard: 'Exposed live wires.' });
  await f.turn();
  const stale = f.snapshot().scene;
  delete stale.location.id;
  delete stale.places;
  delete stale.memberLocations;
  stale.loot = [...old.loot, { ...baseItem('unknown', 'Unknown legacy item', 'tool'), quantity: 1 }];
  f.saveScene(stale);
  const history = f.db.prepare("SELECT result,draft FROM turns WHERE phase='complete'").all();
  const members = f.game.members(f.campaign.id);
  f.db.transaction(() => migrateLocations(f.db))();
  const fixed = f.snapshot().scene;
  expect(fixed.loot).toEqual([]);
  expect(fixed.legacyLoot?.[0].id).toBe('unknown');
  expect(Object.values(fixed.places!).find((place) => place.location.name === 'Checkpoint')?.loot[0].id).toBe(
    'key',
  );
  expect(f.db.prepare("SELECT result,draft FROM turns WHERE phase='complete'").all()).toEqual(history);
  expect(f.game.members(f.campaign.id)).toEqual(members);
  const saved = JSON.stringify(fixed);
  f.db.transaction(() => migrateLocations(f.db))();
  expect(JSON.stringify(f.snapshot().scene)).toBe(saved);
});

it('preserves place identity when its display name changes', () => {
  const scene = ensureLocations({
    location: { name: 'Gate', atmosphere: '', hazard: '' },
    encounters: 0,
    encounter: null,
    loot: [],
    lethalWarning: null,
  });
  const id = scene.location.id;
  updateLocation(scene, { ...scene.location, name: 'New display name' });
  expect(scene.location.id).toBe(id);
});

it('resolves only present combatants and retains an absent character’s independent check', async () => {
  const f = await table();
  f.travel(
    { id: null, name: 'Bunker', atmosphere: 'A guard stands by the relay.', hazard: 'An armed guard.' },
    [f.members[0]],
  );
  await f.turn(['Enter the bunker.', '']);
  const scene = f.snapshot().scene;
  scene.encounter = {
    round: 1,
    victory: false,
    escaped: false,
    initiative: [
      { id: f.members[0].id, total: 20 },
      { id: 'guard', total: 1 },
    ],
    enemies: [
      {
        ...enemySchema.parse({
          id: 'guard',
          name: 'Guard',
          tier: 'normal',
          hp: 30,
          defense: 5,
          attack: 0,
          damage: '1d4',
          description: 'An armed guard.',
          tactic: 'Defend the relay.',
        }),
        maxHp: 30,
        initiative: 1,
      },
    ],
  };
  f.saveScene(scene);
  f.provider.planCombat = async (context) => {
    expect(context.members.map((member) => member.id)).toEqual([f.members[0].id]);
    expect(context.turn.actions.map((action) => action.memberId)).toEqual([f.members[0].id]);
    return normalizeCombatInput(context);
  };
  f.provider.adjudicate = async (context, tools) => {
    tools({
      memberId: f.members[1].id,
      stat: 'INT',
      dc: 5,
      mode: 'normal',
      lethal: false,
      reason: 'Examine the checkpoint desk.',
    });
    return {
      ...routine(context),
      location: { ...context.scene.location, atmosphere: 'The guard still protects the relay.' },
    };
  };
  const id = await f.turn(['Attack the guard.', 'Examine the desk at the checkpoint.']);
  expect(f.snapshot().history.at(-1)?.id, f.snapshot().turn?.error ?? '').toBe(id);
  const done = f.snapshot().history.at(-1)!;
  expect(done.resolution?.actions.find((action) => action.memberId === f.members[1].id)?.basis).toBe('check');
  expect(done.rolls.filter((roll) => roll.memberId === f.members[1].id)).toHaveLength(1);
  expect(memberScene(f.snapshot().scene, f.members[1].id).location.name).toBe('Checkpoint');
});

it('keeps spent environmental sources local and exhausted on return', async () => {
  const f = await table();
  const scene = f.snapshot().scene;
  const origin = { ...scene.location, atmosphere: 'A loaded cannon overlooks the courtyard.' };
  const profile: EnvironmentalAction = {
    sourceId: 'journal:location:Checkpoint',
    name: 'Cannon',
    evidence: origin.atmosphere,
    operation: 'attack',
    roll: 'defense',
    damage: '2d6',
    damageBonus: 0,
    consumption: 'once',
    reloadSourceId: null,
    reloadEvidence: null,
  };
  scene.environment = {
    sources: { [profile.sourceId]: { profile, ready: false } },
    spentResources: ['powder'],
  };
  scene.location = origin;
  f.saveScene(scene);
  f.travel({ id: null, name: 'Bunker', atmosphere: 'An empty room.', hazard: '' });
  await f.turn();
  const context = {
    scene: f.snapshot().scene,
    journal: [{ kind: 'location' as const, name: 'Checkpoint', detail: origin.atmosphere }],
  };
  expect(() => validateEnvironmentalAction(context, profile)).toThrow('another location');
  f.travel(origin);
  await f.turn();
  expect(f.snapshot().scene.environment?.sources[profile.sourceId].ready).toBe(false);
  expect(f.snapshot().scene.environment?.spentResources).toEqual(['powder']);
});

it('uses the same location ownership in the retained compatibility publication route', async () => {
  const f = await table();
  const scene = f.snapshot().scene;
  const origin = scene.location.id!;
  scene.loot = [{ ...baseItem('legacy-key', 'Legacy key', 'tool'), quantity: 1 }];
  f.saveScene(scene);
  delete f.provider.adjudicate;
  delete f.provider.narrate;
  f.provider.resolve = async () => ({
    narration: 'The party enters the bunker.',
    summary: 'The party is in the bunker.',
    choices: [],
    changes: [],
    journal: [],
    location: { name: 'Bunker', atmosphere: 'A quiet room.', hazard: '' },
    xp: 0,
    currency: 0,
    lethalWarning: null,
  });
  const id = await f.turn();
  expect(f.snapshot().history.at(-1)?.id, f.snapshot().turn?.error ?? '').toBe(id);
  expect(f.snapshot().scene.loot).toEqual([]);
  expect(f.snapshot().scene.places![origin].loot[0].id).toBe('legacy-key');
  expect(Object.values(f.snapshot().scene.memberLocations!)).toEqual(
    f.members.map(() => f.snapshot().scene.location.id),
  );
  expect(() =>
    f.game.manageCharacter(f.campaign.id, f.players[0].id, { type: 'take', itemId: 'legacy-key' }),
  ).toThrow();
});

it('keeps the original place snapshot when retrying an encounter introduced at a destination', async () => {
  const f = await table();
  const origin = f.snapshot().scene.location.id!;
  let interrupted = false;
  f.provider.adjudicate = async (context, tools) => {
    tools.startCombat([
      {
        id: 'guard',
        name: 'Bunker guard',
        tier: 'normal',
        hp: 12,
        defense: 10,
        attack: 2,
        damage: '1d4',
        description: 'An armed guard.',
        tactic: 'Protect the bunker.',
      },
    ]);
    if (!interrupted) {
      interrupted = true;
      throw new Error('Interrupted before adjudication was accepted');
    }
    return {
      ...travelling(context, f.members),
      location: { id: null, name: 'Bunker', atmosphere: 'A guard blocks the relay.', hazard: 'Armed guard.' },
    };
  };
  const id = await f.turn();
  expect(f.snapshot().turn?.phase).toBe('failed');
  const restarted = new Game(f.db, () => f.provider);
  restarted.retry(f.campaign.id, f.host.id);
  await restarted.idle();
  expect(f.snapshot().history.at(-1)?.id, f.snapshot().turn?.error ?? '').toBe(id);
  expect(f.snapshot().scene.encounter?.enemies[0].id).toBe('guard');
  expect(f.snapshot().scene.encounter?.round).toBe(1);
  expect(f.snapshot().scene.places![origin].encounter).toBeNull();
});

function splitArrivals(context: GMContext) {
  const value = routine(context);
  value.placeUpdates = [
    {
      ref: 'new:upper',
      location: { name: 'Upper chamber', atmosphere: 'A dry pressure console.', hazard: '' },
    },
    {
      ref: 'new:lower',
      location: {
        name: 'Lower shaft',
        atmosphere: 'A pipe valve and a tool rack.',
        hazard: 'Hot steam fills the shaft.',
      },
    },
  ];
  value.sceneFocus = 'new:upper';
  value.memberLocations = value.actions.map((action, index) => {
    const event = value.events.find((event) => event.id === action.eventIds.at(-1))!;
    event.fact = `${context.members[index].character.name} reaches the ${index ? 'lower shaft' : 'upper chamber'}.`;
    event.effect = 'movement';
    return {
      memberId: action.memberId,
      locationId: index ? 'new:lower' : 'new:upper',
      movementEventId: event.id,
    };
  });
  value.events.push({
    id: 'world:split',
    sequence: value.events.length,
    kind: 'world',
    memberId: null,
    actionId: null,
    fact: 'The branches lead to separate rooms, beyond ordinary hearing.',
    receiptRefs: [],
    dependsOn: [],
    phase: 'aftermath',
    result: null,
  });
  value.separations = [{ memberIds: [context.members[0].id, context.members[1].id], eventId: 'world:split' }];
  return value;
}

it('registers two new arrivals, local loot and distinct hazards once across a narration restart', async () => {
  const f = await table();
  const origin = f.snapshot().scene.location.id!;
  const adjudicate = vi.fn(
    async (context: GMContext, tools: Parameters<NonNullable<GameMaster['adjudicate']>>[1]) => {
      tools.offerLoot({
        memberId: f.members[1].id,
        locationId: 'new:lower',
        sourceId: 'lower:rack',
        reason: 'A valve wrench rests on the rack.',
        item: {
          name: 'Valve wrench',
          kind: 'tool',
          description: 'Fits the visible pipe valve.',
          scaling: [],
          hands: 1,
          light: true,
        },
      });
      const value = splitArrivals(context);
      const item = (context.receipts!.loot as { item: { id: string } }).item;
      value.journal = [
        {
          kind: 'fact',
          name: 'Valve wrench discovery',
          detail: 'A wrench was found on the lower rack; it fits the pipe valve.',
          itemId: item.id,
        },
      ];
      return value;
    },
  );
  f.provider.adjudicate = adjudicate;
  const narrate = f.provider.narrate!;
  f.provider.narrate = async () => {
    interruptNarration(f.db, 'Interrupted narration');
  };
  const id = await f.turn(['Walk into the upper room.', 'Walk down to the rack.']);
  expect(f.snapshot().turn?.phase).toBe('failed');
  const draft = JSON.parse(
    (f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(id) as { draft: string }).draft,
  );
  const refs = draft.placeRefs;
  expect(refs['new:upper']).not.toBe(refs['new:lower']);
  expect(draft.resolution.placeStates[refs['new:upper']].location.hazard).toBe('');
  expect(draft.resolution.placeStates[refs['new:lower']].location.hazard).toBe('Hot steam fills the shaft.');
  f.provider.narrate = narrate;
  const restarted = new Game(f.db, () => f.provider);
  restarted.retry(f.campaign.id, f.host.id);
  await restarted.idle();
  expect(f.snapshot().history.at(-1)?.id, f.snapshot().turn?.error ?? '').toBe(id);
  expect(adjudicate).toHaveBeenCalledTimes(1);
  const scene = f.snapshot().scene;
  expect(scene.location.id).toBe(refs['new:upper']);
  expect(scene.memberLocations).toMatchObject({
    [f.members[0].id]: refs['new:upper'],
    [f.members[1].id]: refs['new:lower'],
  });
  expect(scene.places![origin].loot).toEqual([]);
  const itemId = memberScene(scene, f.members[1].id).loot[0].id;
  expect(() => restarted.manageCharacter(f.campaign.id, f.players[0].id, { type: 'take', itemId })).toThrow(
    'no longer available',
  );
  restarted.manageCharacter(f.campaign.id, f.players[1].id, { type: 'take', itemId });
  expect(f.snapshot().journal.find((entry) => entry.itemId === itemId)?.itemStatus).toContain(
    f.members[1].character.name,
  );
  restarted.manageCharacter(f.campaign.id, f.players[1].id, { type: 'drop', itemId });
  expect(f.snapshot().journal.find((entry) => entry.itemId === itemId)?.itemStatus).toContain('Lower shaft');
  restarted.manageCharacter(f.campaign.id, f.players[1].id, { type: 'take', itemId });
  expect(
    restarted.members(f.campaign.id)[1].state.inventory.filter((item) => item.id === itemId),
  ).toHaveLength(1);
});

it('accepts opening placement but rejects fabricated separation and unrelated successes as movement', async () => {
  const f = await table();
  const opening = f.snapshot().history[0];
  const context: GMContext = {
    config: f.snapshot().config,
    scene: f.snapshot().scene,
    members: f.game.members(f.campaign.id),
    turn: { ...opening, number: 0, actions: [] },
    journal: [],
    history: [],
  };
  const value = splitArrivals({
    ...context,
    turn: {
      ...context.turn,
      number: 1,
      actions: f.members.map((member) => ({
        memberId: member.id,
        text: 'Walk along my branch.',
        passed: false,
      })),
    },
  });
  const placement = { ...value, actions: [], events: routine(context).events, separations: [] };
  expect(validateAdjudication(context, placement).memberLocations).toHaveLength(2);
  const movingContext = {
    ...context,
    turn: {
      ...context.turn,
      number: 1,
      actions: f.members.map((member) => ({
        memberId: member.id,
        text: 'Walk along my branch.',
        passed: false,
      })),
    },
  };
  expect(() => validateAdjudication(movingContext, value)).not.toThrow();
  const search = structuredClone(value);
  delete search.events[0].effect;
  expect(() => validateAdjudication(movingContext, search)).toThrow('explicit movement effect');
  const coalesced = structuredClone(value);
  coalesced.memberLocations![1].locationId = 'new:upper';
  coalesced.placeUpdates = coalesced.placeUpdates!.slice(0, 1);
  expect(() => validateAdjudication(movingContext, coalesced)).toThrow('distinct saved places');
});

it('keeps routine arrival before a failed stunt and reuses the single saved check on restart', async () => {
  const f = await table();
  const adjudicate = vi.fn(
    async (context: GMContext, tools: Parameters<NonNullable<GameMaster['adjudicate']>>[1]) => {
      tools({
        memberId: f.members[0].id,
        stat: 'DEX',
        dc: 20,
        mode: 'normal',
        lethal: false,
        reason: 'Backflip after following the open passage.',
      });
      const value = routine(context);
      const action = value.actions[0];
      const roll = context.turn.rolls[0];
      const eventId = 'action:arrival';
      const fact = 'Player 0 reaches the end of the open passage before the failed backflip.';
      value.events.push({
        id: eventId,
        sequence: value.events.length,
        kind: 'action',
        actionId: action.actionId,
        memberId: action.memberId,
        phase: 'movement',
        result: 'success',
        beforeEventId: `check:${roll.id}`,
        fact,
        receiptRefs: [],
        dependsOn: [],
      });
      action.components.movement = {
        status: 'success',
        basis: 'routine',
        fact,
        reason: 'Ordinary traversal precedes the stunt.',
        eventIds: [eventId],
        receiptRefs: [],
      };
      action.eventIds = [...action.eventIds, eventId];
      action.status = 'partial';
      value.sceneFocus = 'new:exit';
      value.placeUpdates = [
        {
          ref: 'new:exit',
          location: { name: 'Exit chamber', atmosphere: 'An open shelter entrance.', hazard: '' },
        },
      ];
      value.memberLocations = [
        { memberId: action.memberId, locationId: 'new:exit', movementEventId: eventId },
      ];
      return value;
    },
  );
  f.provider.adjudicate = adjudicate;
  const narrate = f.provider.narrate!;
  f.provider.narrate = async () => {
    interruptNarration(f.db, 'Interrupted');
  };
  const id = await f.turn(['Follow the open passage, then backflip.', '']);
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('failed');
  const draft = JSON.parse(
    (f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(id) as { draft: string }).draft,
  );
  expect(draft.resolution, f.snapshot().turn?.error ?? '').toBeDefined();
  expect(draft.resolution.actions[0].components.main.status).toBe('failure');
  expect(draft.resolution.actions[0].status).toBe('partial');
  expect(draft.resolution.events[0].id).toBe('action:arrival');
  expect(draft.resolution.events[1].id).toMatch(/^check:/);
  f.provider.narrate = narrate;
  const restarted = new Game(f.db, () => f.provider);
  restarted.retry(f.campaign.id, f.host.id);
  await restarted.idle();
  expect(f.snapshot().history.at(-1)?.id, f.snapshot().turn?.error ?? '').toBe(id);
  expect(adjudicate).toHaveBeenCalledTimes(1);
  expect(f.snapshot().history.at(-1)?.rolls).toHaveLength(1);
  expect(memberScene(f.snapshot().scene, f.members[0].id).location.name).toBe('Exit chamber');
});

it('orders arrival before a destination Mend and resumes narration without spending it again', async () => {
  const f = await table();
  const actor = f.members[0];
  actor.character.abilities.push({
    name: 'Field Mend',
    description: 'Mend your wounds.',
    kind: 'utility',
    effect: 'mend',
    level: 1,
    stat: 'WIS',
    dice: '1d6',
  });
  actor.state.hp -= 4;
  f.db
    .prepare('UPDATE members SET sheet=?, state=? WHERE id=?')
    .run(JSON.stringify(actor.character), JSON.stringify(actor.state), actor.id);
  const scene = f.snapshot().scene;
  const destination = 'da4772b5-fd8c-4610-a7a8-f573f5bfe50d';
  scene.places![destination] = {
    location: { id: destination, name: 'Shelter', atmosphere: 'A dry bench.', hazard: '' },
    encounter: null,
    loot: [],
  };
  scene.worldMap!.nodes[destination] = { id: destination, name: 'Shelter', visited: true };
  scene.worldMap!.connections.push({
    from: scene.location.id!,
    to: destination,
    label: 'Open path',
    blocked: false,
    bidirectional: true,
  });
  f.saveScene(scene);
  const adjudicate = vi.fn(
    async (context: GMContext, tools: Parameters<NonNullable<GameMaster['adjudicate']>>[1]) => {
      tools.useResource!({ memberId: actor.id, itemId: null, abilityName: 'Field Mend', targetId: null });
      const example = adjudicationInput(context).schemaExample;
      const value = turnAdjudicationSchema.parse({
        ...example,
        events: [...engineEvents(context), ...example.events],
      });
      const action = value.actions[0];
      const moveId = 'action:shelter';
      const fact = 'Player 0 walks to the shelter and sits on its dry bench.';
      value.events.push({
        id: moveId,
        sequence: value.events.length,
        kind: 'action',
        memberId: actor.id,
        actionId: action.actionId,
        phase: 'movement',
        result: 'success',
        locationRef: destination,
        beforeEventId: action.components.main!.eventIds[0],
        fact,
        receiptRefs: [],
        dependsOn: [],
      });
      action.components.movement = {
        status: 'success',
        basis: 'routine',
        fact,
        reason: 'The path to the shelter is open.',
        receiptRefs: [],
        eventIds: [moveId],
      };
      action.eventIds = [...action.eventIds, moveId];
      action.fact = `${fact} ${action.components.main!.fact}`;
      value.memberLocations = [{ memberId: actor.id, locationId: destination, movementEventId: moveId }];
      value.events.push({
        id: 'world:shelter-safety',
        sequence: value.events.length,
        kind: 'world',
        memberId: null,
        actionId: null,
        phase: 'aftermath',
        result: null,
        locationRef: destination,
        fact: 'An attended watch post keeps the dry shelter secure.',
        receiptRefs: [],
        dependsOn: [],
      });
      value.encounterRisks = [
        {
          locationId: destination,
          eventId: 'world:shelter-safety',
          danger: 'safe',
          reason: 'The attended watch post secures the shelter.',
        },
      ];
      return value;
    },
  );
  f.provider.adjudicate = adjudicate;
  const narrate = f.provider.narrate!;
  f.provider.narrate = async () => {
    interruptNarration(f.db, 'Interrupted narration');
  };
  const id = await f.turn(['Walk to the shelter, then use Field Mend on myself.', '']);
  expect(f.snapshot().turn?.phase).toBe('failed');
  const draft = JSON.parse(
    (f.db.prepare('SELECT draft FROM turns WHERE id=?').get(id) as { draft: string }).draft,
  );
  expect(draft.resolution, f.snapshot().turn?.error ?? '').toBeDefined();
  expect(draft.resolution.events[0].id).toBe('action:shelter');
  expect(draft.resolution.events[1].id).toBe(`resource:ability:${actor.id}`);
  const healed = draft.members[0].state.hp;
  const rolls = f.snapshot().turn!.rolls;
  f.provider.narrate = narrate;
  const restarted = new Game(f.db, () => f.provider);
  restarted.retry(f.campaign.id, f.host.id);
  await restarted.idle();
  const done = f.snapshot().history.at(-1)!;
  expect(done.id, f.snapshot().turn?.error ?? '').toBe(id);
  expect(adjudicate).toHaveBeenCalledTimes(1);
  expect(done.resolution).toEqual(draft.resolution);
  expect(done.rolls).toEqual(rolls);
  expect(f.game.members(f.campaign.id)[0].state).toMatchObject({
    hp: healed,
    abilityUses: { 'Field Mend': 1 },
  });
  expect(memberScene(f.snapshot().scene, actor.id).location.id).toBe(destination);
  expect(done.result!.narration.indexOf('walks to the shelter')).toBeLessThan(
    done.result!.narration.indexOf('Field Mend'),
  );
});

it('answers an information-only request without activating a selected utility card and audits readiness', async () => {
  const f = await table();
  const before = f.game.members(f.campaign.id)[0].state;
  f.provider.adjudicate = async (context) => {
    const value = routine(context);
    value.actions[0].intent = 'orientation';
    value.events[0].fact =
      'The visible pressure console has worn valve markings; the passage behind remains open.';
    return value;
  };
  const id = f.snapshot().turn!.id;
  const ability = f.members[0].character.abilities.find((ability) => ability.kind === 'utility')!.name;
  f.game.submit(f.campaign.id, f.players[0].id, id, 'Wat moet ik doen?', false, false, ability);
  expect(f.snapshot().turn!.actions[0].submittedAt).toMatch(/^\d{4}-/);
  f.game.submit(f.campaign.id, f.players[1].id, id, '', true);
  await f.game.idle();
  expect(f.snapshot().history.at(-1)?.id, f.snapshot().turn?.error ?? '').toBe(id);
  expect(f.snapshot().history.at(-1)?.rolls).toEqual([]);
  expect(f.game.members(f.campaign.id)[0].state).toMatchObject({
    xp: before.xp,
    abilityUses: before.abilityUses,
    inventory: before.inventory,
  });
  const diagnostics = f.db
    .prepare("SELECT payload FROM events WHERE turn_id = ? AND kind = 'stage:adjudication'")
    .get(id) as { payload: string };
  expect(JSON.parse(diagnostics.payload).buildId).toMatch(/^[0-9a-f]{16}$/);
  const scene = f.snapshot().scene;
  scene.loot = [{ ...baseItem('wrench', 'Wrench', 'tool'), quantity: 1 }];
  f.saveScene(scene);
  const next = f.snapshot().turn!.id;
  f.game.submit(f.campaign.id, f.players[1].id, next, 'Wait here.', false);
  expect(() =>
    f.game.manageCharacter(f.campaign.id, f.players[1].id, { type: 'take', itemId: 'wrench' }),
  ).toThrow('submitted');
  f.game.manageCharacter(f.campaign.id, f.players[0].id, { type: 'take', itemId: 'wrench' });
});

it('keeps a combat GM question informational with a selected card while enemies still act', async () => {
  const f = await table();
  const scene = f.snapshot().scene;
  scene.encounter = {
    round: 1,
    victory: false,
    escaped: false,
    initiative: [
      { id: f.members[0].id, total: 20 },
      { id: 'guard', total: 1 },
    ],
    enemies: [
      {
        ...enemySchema.parse({
          id: 'guard',
          name: 'Guard',
          tier: 'normal',
          hp: 30,
          defense: 5,
          attack: 15,
          damage: '1d4',
          description: 'An armed guard.',
          tactic: 'Recapture the prisoners.',
        }),
        maxHp: 30,
        initiative: 1,
      },
    ],
  };
  f.saveScene(scene);
  f.provider.planCombat = async (context) =>
    normalizeCombatInput(context, { actions: [{ memberId: f.members[0].id, intent: 'orientation' }] });
  f.provider.adjudicate = async (context) => {
    const value = routine(context);
    value.actions[0].intent = 'orientation';
    return value;
  };
  const id = f.snapshot().turn!.id;
  const before = f.game.members(f.campaign.id)[0].state;
  f.game.submit(
    f.campaign.id,
    f.players[0].id,
    id,
    'What can I see?',
    false,
    false,
    f.members[0].character.abilities[1].name,
  );
  f.game.submit(f.campaign.id, f.players[1].id, id, '', true);
  await f.game.idle();
  expect(f.snapshot().history.at(-1)?.id, f.snapshot().turn?.error ?? '').toBe(id);
  expect(f.snapshot().scene.encounter?.enemies[0].hp).toBe(30);
  expect(f.snapshot().scene.encounter?.round).toBe(2);
  expect(f.game.members(f.campaign.id)[0].state.abilityUses).toEqual(before.abilityUses);
  expect(
    f
      .snapshot()
      .history.at(-1)
      ?.rolls.some((roll) => roll.memberId === 'guard'),
  ).toBe(true);
});
