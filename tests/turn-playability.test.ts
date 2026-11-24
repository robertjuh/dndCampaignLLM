import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { addInstinctObservations, turnPlayability } from '../server/turn-fallback';
import type { GMContext } from '../server/game';
import { actionId, type TurnAdjudication } from '../shared/turn-resolution';
import { ensureLocations } from '../shared/locations';
import { baseItem, initialScene, initialState } from '../shared/rules';
import { templateCharacter } from '../shared/schema';
import { ChatGPTGM } from '../server/providers';
import { validateAdjudication } from '../server/turn-resolution';
import type { ChatGPTAuth } from '../server/auth';
import type { GameTools } from '../server/game';

function fixture() {
  const character = templateCharacter('Reader');
  const member = {
    id: randomUUID(),
    playerId: 'player',
    playerName: 'Player',
    characterId: 'sheet',
    character,
    state: initialState(character, 'actor'),
    active: true,
  };
  const context: GMContext = {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Recovery',
      setting: 'Workshop',
      premise: '',
      tone: '',
      instructions: '',
      language: 'English',
      custom: [],
      provider: 'practice',
      model: '',
    },
    members: [member],
    scene: ensureLocations(initialScene('Workshop'), [member.id]),
    history: [],
    journal: [],
    turn: {
      id: randomUUID(),
      number: 2,
      phase: 'resolving',
      roster: [member.id],
      actions: [{ memberId: member.id, text: 'Inspect the gate.', passed: false }],
      rolls: [],
      result: null,
      error: null,
    },
  };
  const main = {
    status: 'success' as const,
    basis: 'routine' as const,
    fact: 'Reader identifies the gate mechanism.',
    reason: 'Visible mechanism.',
    eventIds: ['result'],
    receiptRefs: [],
  };
  const value: TurnAdjudication = {
    version: 2,
    turnId: context.turn.id,
    changes: [],
    journal: [],
    location: null,
    events: [],
    rewards: { xp: 0, currency: 0, reason: 'Routine.' },
    actions: [
      {
        actionId: actionId(context.turn.id, member.id),
        memberId: member.id,
        ...main,
        components: { main, minor: null },
      },
    ],
  };
  return { context, value, member };
}

async function recover(context: GMContext) {
  context.sceneProtocol = true;
  context.scene.currencyName = 'credits';
  context.scene.encounterRisk = { danger: 'safe', reason: 'A public workshop.' };
  context.requestBudget = { used: 0, limit: 8 };
  const fetcher = vi.fn(
    async () =>
      new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify({ version: 3, beats: [], summary: 'Incomplete' }),
                  },
                ],
              },
            ],
          },
        })}\n\n`,
      ),
  );
  const tools = Object.assign(vi.fn(), {
    validateAdjudication: (input: unknown) => validateAdjudication(context, input),
  }) as unknown as GameTools;
  const value = await new ChatGPTGM(
    { accessToken: async () => 'test' } as unknown as ChatGPTAuth,
    'owner',
    'test',
    fetcher,
  ).adjudicate(context, tools);
  return { value, fetcher };
}

it('adds a grounded instinctive observation to an unavailable noncombat goal without completing it or granting rewards', () => {
  const { context, value, member } = fixture();
  const before = structuredClone(member.state);
  context.scene.location.atmosphere = 'A brass lever is visible beside the sealed gate.';
  value.actions[0].status = 'blocked';
  value.actions[0].basis = 'none';
  value.actions[0].components.main!.status = 'blocked';
  value.actions[0].components.main!.basis = 'none';
  const result = addInstinctObservations(context, value);
  expect(result.actions).toEqual(value.actions);
  expect(result.events.at(-1)?.fact).toContain('brass lever');
  expect(result.events.at(-1)?.dependsOn).toEqual([{ eventId: 'result', requires: 'occurrence' }]);
  expect(result.rewards).toEqual(value.rewards);
  expect(result.changes).toEqual([]);
  expect(addInstinctObservations(context, result)).toEqual(result);
  expect(member.state).toEqual(before);
});

it.each([false, true])(
  'keeps inspection recovery tied to the named target and preserves its check (success=%s)',
  async (success) => {
    const { context, member } = fixture();
    context.turn.actions[0].text = 'Inspect the signal tablet.';
    context.scene.features = {
      tablet: {
        id: 'tablet',
        name: 'Signal tablet',
        aliases: [],
        locationId: context.scene.location.id!,
        properties: { channel: 'western relay' },
        fact: 'The tablet shows the relay channel.',
      },
      cup: {
        id: 'cup',
        name: 'Golden cup',
        aliases: [],
        locationId: context.scene.location.id!,
        properties: { decorated: true },
        fact: 'A golden cup stands on a shelf.',
      },
    };
    const roll = {
      id: randomUUID(),
      memberId: member.id,
      stat: 'WIS' as const,
      dc: 10 as const,
      mode: 'normal' as const,
      dice: [success ? 18 : 1],
      modifier: 0,
      total: success ? 18 : 1,
      success,
      reason: 'Inspect the signal tablet.',
      lethal: false,
      source: 'test',
    };
    context.turn.rolls.push(roll);
    const { value, fetcher } = await recover(context);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(value.events.map((event) => event.fact).join(' ')).toContain('western relay');
    expect(value.events.map((event) => event.fact).join(' ')).not.toContain('Golden cup');
    expect(value.actions[0].components.main?.status).toBe(success ? 'success' : 'failure');
    expect(context.requestBudget?.goalRecovery?.[0]).toMatchObject({
      sourceId: 'feature:tablet',
      usefulConsequence: true,
      goalState: success ? 'progress' : 'failed',
    });
    expect(context.turn.rolls).toEqual([roll]);
  },
);

it('uses the actual NPC objection after failed persuasion instead of an unrelated environmental detail', async () => {
  const { context, member } = fixture();
  context.turn.actions[0].text = 'Convince the gatekeeper to let me through.';
  context.scene.npcs = {
    keeper: {
      id: 'keeper',
      name: 'Iven',
      aliases: ['the gatekeeper'],
      status: 'alive',
      locationId: context.scene.location.id!,
      allegiance: null,
      fact: 'Iven refuses entry without a signed permit.',
    },
  };
  context.turn.rolls.push({
    id: randomUUID(),
    memberId: member.id,
    stat: 'CHA',
    dc: 10,
    mode: 'normal',
    dice: [1],
    modifier: 0,
    total: 1,
    success: false,
    reason: 'Convince the gatekeeper.',
    lethal: false,
    source: 'test',
  });
  const { value } = await recover(context);
  expect(value.events.map((event) => event.fact).join(' ')).toContain('signed permit');
  expect(value.npcUpdates ?? []).toEqual([]);
  expect(value.actions[0].components.main?.status).toBe('failure');
  expect(context.requestBudget?.goalRecovery?.[0]).toMatchObject({
    kind: 'talk',
    sourceId: 'npc:keeper',
    goalState: 'failed',
    usefulConsequence: true,
  });
});

it.each(['English', 'Nederlands'] as const)(
  'completes a scoped successful unlock and opens its existing route (%s)',
  async (language) => {
    const { context, member } = fixture();
    context.config.language = language;
    const here = context.scene.location.id!;
    const to = randomUUID();
    context.scene.places![to] = {
      location: { id: to, name: 'Garden', atmosphere: 'A walled garden.', hazard: '' },
      encounter: null,
      loot: [],
    };
    context.scene.worldMap!.nodes[to] = { id: to, name: 'Garden', visited: true };
    context.scene.worldMap!.connections.push({
      from: here,
      to,
      label: 'Iron gate',
      blocked: true,
      bidirectional: true,
    });
    context.scene.features = {
      gate: {
        id: 'gate',
        name: 'Iron gate',
        aliases: ['ijzeren poort'],
        locationId: here,
        properties: { locked: true },
        route: { from: here, to },
        fact: 'An iron gate is locked.',
      },
    };
    const text = language === 'English' ? 'Unlock the iron gate.' : 'Ontgrendel de ijzeren poort.';
    context.turn.actions[0].text = text;
    const roll = {
      id: randomUUID(),
      memberId: member.id,
      stat: 'DEX' as const,
      dc: 10 as const,
      mode: 'normal' as const,
      dice: [18],
      modifier: 0,
      total: 18,
      success: true,
      reason: text,
      lethal: false,
      source: 'test',
    };
    context.turn.rolls.push(roll);
    const { value, fetcher } = await recover(context);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(value.featureUpdates).toContainEqual(
      expect.objectContaining({ featureId: 'gate', properties: { locked: false }, passable: true }),
    );
    expect(value.mapUpdates?.connections).toContainEqual(
      expect.objectContaining({ from: here, to, blocked: false }),
    );
    expect(value.events.some((event) => event.fact.includes('locked: true'))).toBe(false);
    expect(context.requestBudget?.goalRecovery?.[0].goalState).toBe('resolved');
    expect(context.turn.rolls).toEqual([roll]);
  },
);

it.each([
  'failed check',
  'different checked goal',
  'negated action',
  'unknown prerequisite',
  'information question',
  'NPC request',
])('keeps the lock unchanged and provides partial progress for %s', async (scenario) => {
  const { context, member } = fixture();
  context.turn.actions[0].text =
    scenario === 'negated action' ? 'Do not unlock the iron gate; inspect it.' : 'Unlock the iron gate.';
  if (scenario === 'information question') context.turn.actions[0].text = 'Can I unlock the iron gate?';
  if (scenario === 'NPC request') context.turn.actions[0].text = 'Ask the guard to unlock the iron gate.';
  context.scene.features = {
    gate: {
      id: 'gate',
      name: 'Iron gate',
      aliases: [],
      locationId: context.scene.location.id!,
      properties:
        scenario === 'unknown prerequisite' ? { locked: true, requiresKey: true } : { locked: true },
      fact: 'An iron gate is locked.',
    },
  };
  const success = scenario !== 'failed check';
  context.turn.rolls.push({
    id: randomUUID(),
    memberId: member.id,
    stat: 'DEX',
    dc: 10,
    mode: 'normal',
    dice: [success ? 18 : 1],
    modifier: 0,
    total: success ? 18 : 1,
    success,
    reason: scenario === 'different checked goal' ? 'Inspect the iron gate.' : 'Unlock the iron gate.',
    lethal: false,
    source: 'test',
  });
  const { value } = await recover(context);
  expect(value.featureUpdates ?? []).toEqual([]);
  expect(value.actions[0].components.main?.status).toBe(success ? 'success' : 'failure');
  expect(context.requestBudget?.goalRecovery?.[0].goalState).not.toBe('resolved');
  expect(value.events.map((event) => event.fact).join(' ')).toContain('Iron gate');
});

it('repairs a simple existing device after the matching successful check without inventing parts or damage', async () => {
  const { context, member } = fixture();
  context.turn.actions[0].text = 'Repair the signal lamp.';
  context.scene.features = {
    lamp: {
      id: 'lamp',
      name: 'Signal lamp',
      aliases: [],
      locationId: context.scene.location.id!,
      properties: { working: false, damaged: true },
      fact: 'A faulty signal lamp.',
    },
  };
  context.turn.rolls.push({
    id: randomUUID(),
    memberId: member.id,
    stat: 'INT',
    dc: 10,
    mode: 'normal',
    dice: [18],
    modifier: 0,
    total: 18,
    success: true,
    reason: 'Repair the signal lamp.',
    lethal: false,
    source: 'test',
  });
  const { value } = await recover(context);
  expect(value.featureUpdates?.[0].properties).toEqual({ working: true, damaged: false });
  expect(value.changes).toEqual([]);
  expect(value.rewards).toMatchObject({ xp: 0, currency: 0 });
  expect(context.requestBudget?.goalRecovery?.[0]).toMatchObject({
    goalState: 'resolved',
    sourceId: 'feature:lamp',
  });
});

it.each([false, true])(
  'recovers a known route without rerolling or choosing another actor’s action (checked=%s)',
  async (checked) => {
    const { context, member } = fixture();
    const to = randomUUID();
    context.scene.places![to] = {
      location: { id: to, name: 'Garden', atmosphere: 'A walled garden.', hazard: '' },
      encounter: null,
      loot: [],
      encounterRisk: { danger: 'safe', reason: 'A quiet garden.' },
    };
    context.scene.worldMap!.nodes[to] = { id: to, name: 'Garden', visited: true };
    context.scene.worldMap!.connections.push({
      from: context.scene.location.id!,
      to,
      label: 'Footpath',
      blocked: false,
      bidirectional: true,
    });
    context.turn.actions[0].text = 'Walk to the garden.';
    if (checked)
      context.turn.rolls.push({
        id: randomUUID(),
        memberId: member.id,
        stat: 'DEX',
        dc: 10,
        mode: 'normal',
        dice: [18],
        modifier: 0,
        total: 18,
        success: true,
        reason: 'Cross the footpath to the garden.',
        lethal: false,
        source: 'test',
      });
    const rolls = structuredClone(context.turn.rolls);
    const { value, fetcher } = await recover(context);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(value.memberLocations).toEqual([expect.objectContaining({ memberId: member.id, locationId: to })]);
    expect(context.requestBudget?.goalRecovery?.[0]).toMatchObject({ goalState: 'resolved', kind: 'travel' });
    expect(context.turn.rolls).toEqual(rolls);
  },
);

it('collects only an explicitly requested existing item through the ordinary pickup validator', async () => {
  const { context } = fixture();
  context.turn.actions[0].text = 'Take the red key.';
  context.scene.loot = [
    { ...baseItem('key', 'Red key', 'tool'), quantity: 1 },
    { ...baseItem('coin', 'Silver coin', 'tool'), quantity: 1 },
  ];
  const { value } = await recover(context);
  expect(value.pickups).toEqual([expect.objectContaining({ itemId: 'key', quantity: 1 })]);
  expect(value.actions[0].components.main?.status).toBe('success');
  expect(context.requestBudget?.goalRecovery?.[0]).toMatchObject({ kind: 'collect', goalState: 'resolved' });
  expect(context.scene.loot).toHaveLength(2); // Finalization, not recovery, changes the saved inventory.
});

it.each([
  'Do not take the red key.',
  'If it is safe, take the red key.',
  'Ask the gatekeeper to take the red key.',
  'Take the red key beside the silver ceremonial token.',
])('does not invent a pickup choice for %s', async (text) => {
  const { context } = fixture();
  context.turn.actions[0].text = text;
  context.scene.loot = [
    { ...baseItem('key', 'Red key', 'tool'), quantity: 1 },
    { ...baseItem('token', 'Silver ceremonial token', 'tool'), quantity: 1 },
  ];
  const { value } = await recover(context);
  expect(value.pickups ?? []).toEqual([]);
  expect(context.requestBudget?.goalRecovery?.[0].goalState).not.toBe('resolved');
});

it('keeps the affirmative pickup separate from another explicitly refused item', async () => {
  const { context } = fixture();
  context.turn.actions[0].text = 'Take the red key and do not take the silver ceremonial token.';
  context.scene.loot = [
    { ...baseItem('key', 'Red key', 'tool'), quantity: 1 },
    { ...baseItem('token', 'Silver ceremonial token', 'tool'), quantity: 1 },
  ];
  const { value } = await recover(context);
  expect(value.pickups?.map((pickup) => pickup.itemId)).toEqual(['key']);
});

it('keeps a refused pickup unresolved without dropping or equipping items to bypass capacity', async () => {
  const { context, member } = fixture();
  context.turn.actions[0].text = 'Take the red key.';
  member.state.inventory = Array.from({ length: 8 }, (_, index) => ({
    ...baseItem(`owned:${index}`, `Owned tool ${index}`, 'tool'),
    quantity: 1,
  }));
  context.scene.loot = [{ ...baseItem('key', 'Red key', 'tool'), quantity: 1 }];
  const before = structuredClone(member.state);
  const { value, fetcher } = await recover(context);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(value.actions[0].components.main?.status).toBe('blocked');
  expect(value.events.map((event) => event.fact).join(' ')).toContain('Backpack full');
  expect(value.events.some((event) => event.id.startsWith('fallback:observation:'))).toBe(true);
  expect(context.requestBudget?.goalRecovery?.[0]).toMatchObject({ goalState: 'unresolved' });
  expect(member.state).toEqual(before);
  expect(context.scene.loot[0].quantity).toBe(1);
});

it.each(['blocked', 'transport only', 'failed traversal'])(
  'does not bypass a %s route during local recovery',
  async (scenario) => {
    const { context, member } = fixture();
    const to = randomUUID();
    context.scene.places![to] = {
      location: { id: to, name: 'Garden', atmosphere: 'A walled garden.', hazard: '' },
      encounter: null,
      loot: [],
    };
    context.scene.worldMap!.nodes[to] = { id: to, name: 'Garden', visited: true };
    context.scene.worldMap!.connections.push({
      from: context.scene.location.id!,
      to,
      label: 'Footpath',
      bidirectional: true,
      blocked: scenario === 'blocked',
      transportOnly: scenario === 'transport only',
    });
    context.turn.actions[0].text = 'Walk to the garden.';
    if (scenario === 'failed traversal')
      context.turn.rolls.push({
        id: randomUUID(),
        memberId: member.id,
        stat: 'DEX',
        dc: 10,
        mode: 'normal',
        dice: [1],
        modifier: 0,
        total: 1,
        success: false,
        reason: 'Cross the footpath to the garden.',
        lethal: false,
        source: 'test',
      });
    const { value, fetcher } = await recover(context);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(value.memberLocations ?? []).toEqual([]);
    expect(value.mapUpdates?.connections ?? []).toEqual([]);
    expect(context.requestBudget?.goalRecovery?.[0].goalState).not.toBe('resolved');
  },
);

it('distinguishes a completed goal from a recovered successful check with only partial progress', () => {
  const { context, value, member } = fixture();
  expect(turnPlayability(context, value).unfinishedGoals).toBe(0);
  const metrics = turnPlayability(context, value, [
    { memberId: member.id, kind: 'inspect', goalState: 'progress' },
  ]);
  expect(metrics.unfinishedGoals).toBe(1);
  expect(metrics.outcomes[0]).toMatchObject({ goalState: 'progress', recovered: true });
  expect(value.actions[0].components.main?.status).toBe('success');
});

it('counts an accepted failed search’s saved lesser finding as useful while keeping its goal failed', () => {
  const { context, value } = fixture();
  value.actions[0].components.main!.status = 'failure';
  value.actions[0].search = {
    sourceId: 'tracks',
    locationId: context.scene.location.id!,
    informationEventId: 'finding',
    reward: null,
  };
  value.events.push({
    id: 'finding',
    sequence: 0,
    kind: 'world',
    memberId: null,
    actionId: null,
    phase: 'aftermath',
    result: null,
    fact: 'Dry mud under the alcove retains separate tracks.',
    receiptRefs: [],
    dependsOn: [],
  });
  expect(turnPlayability(context, value)).toMatchObject({
    unfinishedGoals: 1,
    outcomes: [
      expect.objectContaining({
        kind: 'search',
        goalState: 'failed',
        usefulConsequence: true,
        recovered: false,
      }),
    ],
  });
  value.events = [];
  expect(turnPlayability(context, value).outcomes[0].usefulConsequence).toBe(false);
});

it('records failed and deferred goals without counting a pass as an unsuccessful turn', () => {
  const { context, value, member } = fixture();
  Object.assign(value.actions[0].components.main!, { status: 'failure', basis: 'check' });
  expect(turnPlayability(context, value).outcomes[0].goalState).toBe('failed');
  value.actions[0].components.main!.status = 'success';
  value.actionOutcomes = [
    {
      memberId: member.id,
      obligationId: 'intent:0',
      request: 'Inspect gate.',
      outcome: 'deferred',
      fact: 'Inspection will continue next turn.',
      eventId: 'result',
    },
  ];
  expect(turnPlayability(context, value).outcomes[0].goalState).toBe('progress');
  context.turn.actions[0].passed = true;
  expect(turnPlayability(context, value)).toMatchObject({
    outcomes: [],
    unfinishedGoals: 0,
    repeatedInputs: 0,
  });
});

it.each(['I inspect the gate!', 'inspect the gate', 'Try again.', 'Ik probeer opnieuw.'])(
  'tracks the same actor repeating input without keeping submission text in diagnostics: %s',
  (text) => {
    const { context, value, member } = fixture();
    context.turn.actions[0].text = text;
    const metrics = turnPlayability(
      context,
      value,
      [],
      [{ memberId: member.id, text: 'Inspect the gate.', passed: false }],
    );
    expect(metrics.repeatedInputs).toBe(1);
    expect(JSON.stringify(metrics)).not.toContain(text);
    expect(metrics.outcomes[0].inputFingerprint).toMatch(/^[a-f0-9]{16}$/);
  },
);

it('does not mistake another actor, a negated request, or a legacy result for proved completion', () => {
  const { context, value, member } = fixture();
  const previous = [{ memberId: 'someone-else', text: 'Inspect the gate.', passed: false }];
  expect(turnPlayability(context, value, [], previous).repeatedInputs).toBe(0);
  context.turn.actions[0].text = 'Do not inspect the gate.';
  expect(turnPlayability(context, value, [], [{ ...previous[0], memberId: member.id }]).repeatedInputs).toBe(
    0,
  );
  expect(turnPlayability(context, undefined).outcomes[0].goalState).toBe('unassessed');
});
