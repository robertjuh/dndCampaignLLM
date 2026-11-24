import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import tower from './fixtures/darknessworld-tower.json';
import recordedCombats from './fixtures/darknessworld-combat.json';
import vaalTravel from './fixtures/vaal-travel.json';
import vaalReferences from './fixtures/vaal-location-references.json';
import vaalGathering from './fixtures/vaal-gathering.json';
import wreckSearch from './fixtures/akoedabar-search.json';
import crookedMileOpenings from './fixtures/crooked-mile-opening.json';
import { compileSceneTurn, mergeScenePatch, type SceneTurn } from '../server/scene-turn';
import { applyFeatureUpdates } from '../server/scene-state';
import { decodeStructuredOutput, modelSchema } from '../server/model-schema';
import { ChatGPTGM, PracticeGM, adjudicationInput } from '../server/providers';
import { Game, ToolBudgetError, type GMContext, type GameTools, type GameMaster, type CombatReceipt } from '../server/game';
import { engineEvents, validateAdjudication } from '../server/turn-resolution';
import { normalizeCombatInput } from '../server/combat';
import { openDatabase } from '../server/db';
import { initialState, initialScene, baseItem } from '../shared/rules';
import { ensureLocations, memberScene } from '../shared/locations';
import { gmMemorySchema, updateGMMemory, prepareGMNotes } from '../shared/gm-memory';
import { enemySchema, templateCharacter, type Encounter, type Scene } from '../shared/schema';
import type { ChatGPTAuth } from '../server/auth';
import { investigationSchema, type Investigation, type InvestigationResult } from '../shared/investigation';
import { bindInvestigationSource } from '../server/investigations';
import { factionExample } from '../server/factions';
import { applyNPCUpdates } from '../server/npcs';
import { requestsPickup } from '../server/turn-pickups';
import { submittedTravel, locationReferences, actorReferences, resolveActorReference, normalizeAdjudicationReferences } from '../server/world-map';
import { submittedActionObligations } from '../server/action-intent';

function fixture(): GMContext {
  const members = tower.members.map((saved) => {
    const character = templateCharacter(saved.name);
    return {
      id: saved.id,
      playerId: randomUUID(),
      playerName: saved.name,
      characterId: randomUUID(),
      character,
      state: initialState(character, saved.id),
      active: true,
    };
  });
  return {
    sceneProtocol: true,
    gmMemory: [],
    config: {
      ruleset: 'roguelike-v1',
      name: 'Recorded tower',
      setting: 'Darknessworld',
      premise: 'Investigate the eldritch interference.',
      tone: 'Horror',
      instructions: '',
      language: 'English',
      custom: [],
      provider: 'chatgpt',
      model: 'test',
    },
    members,
    startingMembers: structuredClone(members),
    scene: structuredClone(tower.scene) as Scene,
    journal: structuredClone(tower.journal) as GMContext['journal'],
    history: [],
    receipts: {},
    turn: {
      id: randomUUID(),
      number: 6,
      phase: 'resolving',
      roster: members.map((member) => member.id),
      actions: tower.members.map((saved) => ({ memberId: saved.id, text: saved.action, passed: false })),
      rolls: [],
      result: null,
      error: null,
    },
  };
}
function wreckContext(): GMContext {
  const context = fixture();
  context.members = wreckSearch.members.map((member, index) => {
    const character = { ...templateCharacter(member.name), stats: member.stats };
    return {
      ...context.members[index],
      id: member.id,
      character,
      state: initialState(character, member.id),
    };
  });
  context.startingMembers = structuredClone(context.members);
  context.scene = structuredClone(wreckSearch.scene) as Scene;
  context.journal = structuredClone(wreckSearch.journal) as GMContext['journal'];
  context.gmMemory = gmMemorySchema.parse(wreckSearch.gmMemory);
  context.turn = {
    ...context.turn,
    ...structuredClone(wreckSearch.turn),
    roster: context.members.map((member) => member.id),
  } as GMContext['turn'];
  context.receipts = structuredClone(wreckSearch.receipts);
  return context;
}

function correctedWreck(success = true): SceneTurn {
  const corrected = structuredClone(wreckSearch.response) as SceneTurn;
  const move = corrected.beats[1];
  if (move.kind !== 'move') throw new Error('Expected the recorded arrival.');
  move.fact = 'Lobsterano enters the wreck through the stern gap.';
  move.text = 'Lobsterano squeezes through the stern gap into the flooded interior.';
  move.place!.deadEnd = 'The cramped compartment ends at the hull; the stern gap is its only exit.';
  corrected.beats.push({
    kind: 'act',
    actor: move.actor,
    slot: 'main',
    intent: 'search',
    fact: success
      ? 'Lobsterano finds the Mammago tool case behind a loose maintenance panel.'
      : 'Lobsterano cannot find the tool case in the shifting water.',
    text: success
      ? 'Steadying himself against the current, Lobsterano finds the case behind a loose panel.'
      : 'The shifting water defeats the search, but an exposed maintenance panel gives him another opening.',
    finding: {
      source: 'wreck-interior:tool-case',
      fact: success
        ? 'The missing Mammago tool case lies behind a loose maintenance panel.'
        : 'An exposed maintenance panel can be opened from inside the wreck.',
    },
  });
  return corrected;
}

function descent(context: GMContext): SceneTurn {
  const moryan = context.members.find((member) => member.character.name === 'Moryan')!;
  const companion = context.members.find((member) => member.id !== moryan.id)!;
  return {
    version: 3,
    currencyName: 'night marks',
    notes: [],
    summary: 'Moryan reaches the lower chamber. Iven explains the levy.',
    beats: [
      {
        kind: 'move',
        actor: moryan.id,
        to: 'new:lower-chamber',
        fact: 'Moryan descends the iron stair into the dry lower chamber.',
        text: 'Moryan takes the iron stairs down. In the dry chamber, dust jumps with each pulse beneath the hollow shaft.',
        route: 'Iron stair',
        exits: [{ to: 'new:pump-room', name: 'Pump room', label: 'East service passage', blocked: false, bidirectional: true }],
        place: {
          name: 'Bell Tower Lower Chamber',
          atmosphere:
            'A hollow shaft stands in a dry stone chamber. The iron stair returns to Bell Tower Lane; an east service passage leads to the pump room.',
          hazard: 'Vibration comes from beneath the floor.',
          danger: 'dangerous',
          riskReason: 'The open shaft is deep, and the unknown machinery beneath the floor is active.',
        },
      },
      {
        kind: 'act',
        actor: companion.id,
        slot: 'main',
        intent: 'action',
        fact: 'Iven explains that collectors take households marked on the levy rolls.',
        text: '“The collectors take the marked households,” Iven says through the inner doorway.',
        npcs: [{ npcId: 'iven', name: 'Iven' }],
      },
    ],
  };
}
const auth = { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth;
function response(value: unknown) {
  if (value && typeof value === 'object' && 'version' in value && value.version === 3)
    value = { currencyName: 'night marks', ...value };
  return new Response(
    `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] } })}\n\n`,
  );
}
function tools(context: GMContext): GameTools {
  return Object.assign(vi.fn(), {
    startCombat: vi.fn(),
    combat: vi.fn(),
    offerLoot: vi.fn(),
    completeChallenge: vi.fn(),
  });
}

it('resumes the recorded Crooked Mile opening repairs after restart and publishes only a validated scene', async () => {
  const db = openDatabase(':memory:');
  const practice = new PracticeGM();
  const generateFactions = vi.fn(practice.generateFactions.bind(practice));
  const generateStartingStories = vi.fn(practice.generateStartingStories.bind(practice));
  const [firstDraft, retryDraft] = structuredClone(crookedMileOpenings);
  const shapeRepair = (draft: typeof retryDraft) => ({
    version: 3,
    opening: {
      npcs: draft.opening.npcs.map((npc) => 'npcId' in npc ? npc.npcId : npc.id),
      features: draft.opening.features.map((feature) => 'featureId' in feature ? feature.featureId : feature.id),
      quests: [],
      mysteries: draft.opening.mysteries.map((mystery) => mystery.id),
    },
    patches: [{
      index: 0,
      beat: {
        journal: { kind: 'fact', name: 'The delayed coach' },
        ...('progress' in draft.beats[0] ? { progress: { thread: 'premise', kind: 'threat' } } : {}),
      },
    }],
  });
  const repairedDraft = { ...retryDraft, opening: shapeRepair(retryDraft).opening,
    beats: [{ ...retryDraft.beats[0], ...shapeRepair(retryDraft).patches[0].beat }] };
  const replies = [
    firstDraft,
    shapeRepair(firstDraft),
    { version: 3, patches: [{ index: 0, remove: true }], append: repairedDraft.beats,
      opening: repairedDraft.opening, notes: repairedDraft.notes, summary: repairedDraft.summary,
      currencyName: repairedDraft.currencyName },
    retryDraft, // A full rewrite in patch mode must leave the retained draft intact.
    { version: 3, patches: [{ index: 0, unset: ['progress'], beat: { factions: [] } }] },
  ];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(init!.body as string);
    const index = fetcher.mock.calls.length - 1;
    if (index === 2) {
      retryDraft.beats[0].factions[0].factionId = JSON.parse(request.input[0].content).factions.factions[0].id;
    }
    return response(replies[index]);
  });
  const gm = new ChatGPTGM(auth, 'owner', 'test', fetcher);
  const provider: GameMaster = {
    sceneTurns: true,
    adjudicate: gm.adjudicate.bind(gm),
    narrate: practice.narrate.bind(practice),
    generateFactions,
    generateStartingStories,
  };
  let game = new Game(db, () => provider, () => 50);
  try {
    const host = game.identify();
    const player = game.identify();
    const campaign = game.create(host.id, { ...fixture().config, name: 'Crooked Mile', setting: 'Brindlefen' });
    const character = templateCharacter('Traveller');
    character.selectedEquipmentIds = character.equipmentOptions.slice(0, 3).map((item) => item.id);
    game.join(campaign.inviteCode!, player.id, game.saveCharacter(player.id, character).id);
    game.start(campaign.id, host.id);
    await game.idle();
    const failed = game.snapshot(campaign.id, host.id);
    expect(failed.history).toEqual([]);
    expect(failed.turn).toMatchObject({
      number: 0, phase: 'failed', rolls: [], actions: [],
      error: 'The GM couldn’t finish preparing the opening. Your campaign is saved.',
    });
    expect(failed.scene.encounterRisk).toBeUndefined();
    const diagnostics = failed.turn?.diagnostics?.join('\n');
    expect(diagnostics).toContain('beats.0.journal: Expected object, received array');
    expect(diagnostics).toContain('lacks its saved state update');
    expect(diagnostics).not.toContain('Supply encounterRisks');
    expect(game.snapshot(campaign.id, player.id).turn?.diagnostics).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
    const formats = fetcher.mock.calls.map(([, init]) => JSON.parse(init!.body as string).text.format);
    expect(formats.map((format) => format.name)).toEqual(['opening_scene', 'opening_patch', 'opening_patch']);
    expect(formats.every((format) => format.strict === true)).toBe(true);
    const openingSchema = formats[0].schema;
    expect(openingSchema.properties.opening.properties.npcs.items).toMatchObject({ type: 'string', maxLength: 100 });
    const beatSchema = openingSchema.properties.beats.items;
    expect(beatSchema.required).toEqual(Object.keys(beatSchema.properties));
    expect(beatSchema.properties.$optional.items.anyOf).toContainEqual(expect.objectContaining({ required: ['journal'] }));
    expect(formats[1].schema.properties.patches.items.anyOf[0].properties.beat.properties.$optional).toBeDefined();

    game = new Game(db, () => provider, () => 50);
    game.retry(campaign.id, host.id);
    await game.idle();
    expect(fetcher).toHaveBeenCalledTimes(5);
    const requests = fetcher.mock.calls.slice(3).map(([, init]) => JSON.parse(init!.body as string).input);
    expect(JSON.parse(requests[0][1].content)).toEqual(repairedDraft);
    expect(requests[0][2].content).toContain('Discovery requires a story event identifying the faction by name.');
    expect(JSON.parse(requests[1][1].content)).toEqual(repairedDraft);
    expect(requests[1][2].content).toContain('Return a patch for the retained opening');
    const completed = game.snapshot(campaign.id, host.id);
    expect(completed.turn).toMatchObject({ number: 1, phase: 'collecting' });
    expect(completed.history[0]).toMatchObject({ id: failed.turn!.id, phase: 'complete', rolls: [] });
    expect(completed.history[0].result?.narration).toContain('The inn floor unrolls toward the marsh');
    expect(completed.scene.encounterRisk?.danger).toBe('dangerous');
    expect(Object.values(completed.scene.features ?? {}).map((feature) => feature.name)).toContain('Stamped hearthstone');
    expect(game.export(campaign.id, host.id).gmMemory[0].discoveries).toContain('There are two seals on the deed.');
    expect(JSON.stringify(completed)).not.toContain('There are two seals on the deed.');
    expect(generateFactions).toHaveBeenCalledOnce();
    expect(generateStartingStories).toHaveBeenCalledOnce();
  } finally {
    await game.idle();
    db.close();
  }
});

const cameraHack = 'Probe the camera security system and try to get access to the camera controls';
function deniedCameraHack(actor: string): SceneTurn {
  // Recorded failure: cyberpunk world, turn 8. No camera check or prior physical blocker.
  return {
    version: 3,
    notes: [],
    summary: 'Niko cannot access camera controls.',
    beats: [{
      kind: 'act', actor, slot: 'main', intent: 'action',
      fact: 'Niko Venn probes the visible camera system but gains no access to its controls.',
      text: 'The security network does not yield access: its control traffic remains behind the protected internal network.',
    }],
  };
}

it('rejects the recorded unrolled camera denial and an invented blocker, while preserving grounded exemptions', () => {
  const context = fixture();
  const actor = context.members[0];
  context.members = [actor];
  context.turn.roster = [actor.id];
  context.turn.actions = [{ memberId: actor.id, text: cameraHack, passed: false }];
  const scene = deniedCameraHack(actor.id);
  expect(() => compileSceneTurn(context, scene)).toThrow(/roll_check/);
  const beat = scene.beats[0];
  if (beat.kind !== 'act') throw new Error('Expected intrusion act.');
  beat.blocked = 'The cameras are disconnected from every interface.';
  expect(() => compileSceneTurn(context, scene)).toThrow(/roll_check/);
  const at = memberScene(context.scene, actor.id);
  beat.withoutCheck = {
    sourceId: `scene:${at.location.name}:hazard`,
    evidence: 'The cameras are disconnected from every interface.',
  };
  expect(() => compileSceneTurn(context, scene)).toThrow(/roll_check/);
  at.location.hazard = beat.withoutCheck.evidence;
  const blocked = compileSceneTurn(context, scene);
  expect(blocked.actions[0]).toMatchObject({ status: 'blocked', basis: 'none' });

  delete beat.blocked;
  context.scene.features = {
    cameras: {
      id: 'cameras', name: 'Camera controls', aliases: [], locationId: at.location.id!,
      properties: { operator: actor.character.name, access: 'granted' },
      fact: `${actor.character.name} already has authorized access to the camera controls.`,
    },
  };
  beat.fact = beat.text = context.scene.features.cameras.fact;
  beat.withoutCheck = { sourceId: 'feature:cameras', evidence: beat.fact };
  expect(compileSceneTurn(context, scene).actions[0]).toMatchObject({ status: 'success', basis: 'routine' });
  context.scene.features.cameras.locationId = randomUUID();
  expect(() => compileSceneTurn(context, scene)).toThrow(/roll_check/);
  actor.state.inventory.push({
    ...baseItem('camera-key', 'Camera access key', 'tool'),
    description: 'Grants authorized access to the camera controls.', quantity: 1,
  });
  beat.withoutCheck = { sourceId: 'item:camera-key', evidence: 'Grants authorized access to the camera controls.' };
  expect(compileSceneTurn(context, scene).actions[0]).toMatchObject({ status: 'success', basis: 'routine' });
  actor.state.inventory = [];
  expect(() => compileSceneTurn(context, scene)).toThrow(/roll_check/);
});

it.each([true, false])('rolls Niko’s camera intrusion (success: %s), saves access only on success, and reuses granted controls', async (success) => {
  const saved = {
    scene: initialScene('Freight-yard approach'),
    members: [{ id: 'niko', name: 'Niko Venn', action: cameraHack }],
    journal: [],
  };
  ensureLocations(saved.scene, ['niko']);
  saved.scene.encounterRisk = { danger: 'safe', reason: 'The public approach is outside the perimeter.' };
  const f = await table((context, call) => {
    const actor = context.members[0];
    if (context.turn.number === 6) {
      if (call === 1) return deniedCameraHack(actor.id);
      if (call === 2) return toolResponse('roll_check', {
        memberId: actorAlias(context, actor.id), stat: 'INT', dc: 15,
        reason: 'Niko uses his cyberdeck to overcome the camera network’s access protection.',
        mode: 'normal', circumstances: { favorable: false, adverse: false },
        lethal: false, abilityName: null, assistsMemberId: null, assistedBy: [],
      });
      return {
        version: 3, summary: success ? 'Niko gains camera access.' : 'Niko fails to gain camera access.',
        beats: [{
          kind: 'act', actor: actor.id,
          fact: success
            ? 'Niko gains feed access and shutdown control of the Freight-yard cameras. The cameras remain online.'
            : 'Niko fails to gain camera access; authentication rejects his attempt and the cameras remain online.',
          text: success ? 'The camera feeds open on Niko’s cyberdeck, alongside their shutdown controls.' : 'An authentication challenge rejects Niko’s intrusion.',
          ...(success ? {
            features: [{ featureId: 'yard-cameras', name: 'Freight-yard cameras', properties: {
              operator: actor.character.name, can_view: true, can_shutdown: true, online: true,
            } }],
            journal: { kind: 'fact', name: 'Camera access' },
          } : {}),
        }],
      };
    }
    expect(context.scene.features?.['yard-cameras'].properties).toMatchObject({
      operator: 'Niko Venn', can_view: true, can_shutdown: true, online: true,
    });
    const shutdown = context.turn.number === 8;
    return {
      version: 3, summary: shutdown ? 'The cameras are offline.' : 'Niko views the feeds.',
      beats: [{
        kind: 'act', actor: actor.id,
        fact: shutdown ? 'Niko uses his granted controls to shut the cameras down.' : 'Niko sees two guards covering the loading apron in the live camera feeds.',
        text: shutdown ? 'Niko sends the shutdown command and the lenses go dark.' : 'The loading-apron feed shows two guards watching the vehicle lanes.',
        features: shutdown ? [{ featureId: 'yard-cameras', name: 'Freight-yard cameras', properties: { online: false } }] : [],
        journal: { kind: 'fact', name: shutdown ? 'Cameras offline' : 'Camera feed observations' },
      }],
    };
  }, saved);
  try {
    f.draw.mockImplementation((sides) => Math.min(success ? 20 : 1, sides));
    const turnId = f.submit();
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    const feedback = f.db.prepare("SELECT payload FROM events WHERE turn_id = ? AND kind = 'stage:adjudication'").all(turnId) as { payload: string }[];
    expect(snapshot.turn?.phase, JSON.stringify(feedback.map((row) => JSON.parse(row.payload).corrections))).toBe('collecting');
    const turn = snapshot.history.find((turn) => turn.id === turnId)!;
    expect(turn.rolls).toEqual([expect.objectContaining({ stat: 'INT', dc: 15, success })]);
    expect(turn.resolution?.actions[0]).toMatchObject({ status: success ? 'success' : 'failure', basis: 'check' });
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(snapshot.members[0].state.abilityUses).toEqual({});
    if (!success) {
      expect(snapshot.scene.features?.['yard-cameras']).toBeUndefined();
      return;
    }
    const draws = f.draw.mock.calls.length;
    const restarted = new Game(f.db, () => f.provider, f.draw);
    expect(restarted.snapshot(f.campaign.id, f.host.id).scene.features?.['yard-cameras'].properties).toMatchObject({
      operator: 'Niko Venn', can_view: true, can_shutdown: true, online: true,
    });
    for (const action of ['View the camera feeds', 'Shut down the cameras using my access']) {
      restarted.submit(f.campaign.id, f.players[0].id, restarted.pending(f.campaign.id)!.id, action, false);
      await restarted.idle();
      const current = restarted.snapshot(f.campaign.id, f.host.id);
      expect(current.turn?.phase, current.turn?.error ?? '').toBe('collecting');
      expect(current.history.at(-1)?.rolls).toEqual([]);
    }
    const current = restarted.snapshot(f.campaign.id, f.host.id);
    expect(current.scene.features?.['yard-cameras'].properties).toMatchObject({ online: false, can_view: true, can_shutdown: true });
    expect(current.journal.find((entry) => entry.name === 'Camera feed observations')?.detail).toContain('two guards');
    expect(f.draw).toHaveBeenCalledTimes(draws);
    expect(f.narrate).not.toHaveBeenCalled();
  } finally {
    f.db.close();
  }
});

function caravan(): GMContext {
  const context = fixture();
  context.scene = structuredClone(vaalTravel.scene) as Scene;
  context.members = vaalTravel.members.map((saved, index) => ({
    ...context.members[index],
    id: saved.id,
    character: templateCharacter(saved.name),
  }));
  context.startingMembers = structuredClone(context.members);
  context.turn.number = 16;
  context.turn.roster = context.members.map((member) => member.id);
  context.turn.actions = vaalTravel.members.map((saved) => ({
    memberId: saved.id,
    text: saved.action,
    passed: false,
  }));
  context.journal = [];
  return context;
}

function caravanDeparture(context: GMContext): SceneTurn {
  const gemling = context.members[0];
  const xulath = context.members[1];
  return {
    version: 3,
    notes: [{ id: 'cart-journey', locationId: 'current', cause: 'The cart carries goods to North Road.', discoveries: ['The delivery ends at North Road.'], actors: 'The cart driver.', nextChange: 'The cart reaches the gates before North Road.', dueTurn: null, status: 'open', journey: { memberId: gemling.id, destination: 'North Road', completion: 'Reach North Road.', remainingStages: 2 } }],
    summary: 'Xulath reaches the avenue; Gemling escorts the cart to the gates.',
    beats: [
      {
        kind: 'move',
        actor: xulath.id,
        to: memberScene(context.scene, gemling.id).location.id!,
        fact: 'Xulath leaves Sunward Steps and reaches Gemling on Processional Avenue before the cart departs.',
        text: 'Xulath reaches the avenue and joins Gemling before the cart moves on.',
      },
      {
        kind: 'move',
        actor: gemling.id,
        journeyId: 'cart-journey',
        to: 'new:ceremonial-gates',
        route: 'North along the avenue',
        fact: 'Gemling escorts the cart north from Processional Avenue to the ceremonial gates.',
        text: 'Gemling follows the cart to the ceremonial gates. Beyond the forecourt an open road leads north.',
        place: {
          name: 'Ceremonial Gates',
          atmosphere: 'A guarded forecourt lies between the avenue and the north road.',
          hazard: 'Cart traffic passes through the gates.',
          danger: 'safe',
          riskReason: 'Traffic moves in an orderly line.',
        },
        exits: [
          {
            to: 'new:north-road',
            name: 'North Road',
            label: 'Open road north',
            blocked: false,
            bidirectional: true,
          },
        ],
      },
      {
        kind: 'act',
        actor: gemling.id,
        slot: 'main',
        intent: 'action',
        fact: 'Gemling tells Tovek about the hazard he helped stop at Sunward Steps.',
        text: 'At the gates Gemling tells Tovek about the counterweight and the bureaucratic delay.',
        npcs: [{ npcId: 'tovek', name: 'Tovek', locationId: 'new:ceremonial-gates' }],
      },
    ],
  };
}

function referenceCaravan() {
  const context = caravan();
  context.scene = structuredClone(vaalReferences.scene) as Scene;
  context.turn.number = 19;
  context.turn.actions = vaalReferences.members.map((saved) => ({
    memberId: saved.id,
    text: saved.action,
    passed: false,
  }));
  return context;
}
function validReferenceScene(): SceneTurn {
  const scene = structuredClone(vaalReferences.response) as SceneTurn;
  const move = scene.beats[0];
  if (move.kind !== 'move') throw new Error('Expected the recorded caravan travel.');
  move.journeyId = 'recorded-cart-journey';
  scene.notes.push({ id: move.journeyId, locationId: 'current', cause: 'The cart has a fixed delivery stop.', discoveries: ['The delivery ends beyond the canal works.'], actors: 'The caravan crew.', nextChange: 'The cart reaches its delivery stop.', dueTurn: null, status: 'open', journey: { memberId: move.actor, destination: move.place!.name, completion: 'Reach the delivery stop.', remainingStages: 1 } });
  // Keep the recorded malformed references, while giving the submitted conversation
  // its own action and stable participant under the current scene contract.
  move.fact = 'Gemling legionaire continues north with the caravan onto the road beyond the canal works, scanning the traffic. No immediate danger becomes apparent.';
  move.text = 'The caravan leaves North Road and continues past irrigated fields and a roadside waystation. Gemling watches the traffic beside the wagons.';
  scene.beats.push({
    kind: 'meet',
    actor: move.actor,
    person: { npcId: 'caravan-crewman', name: 'Caravan crewman' },
    fact: 'Gemling legionaire exchanges small talk with a caravan crewman. No useful new information emerges.',
    text: 'A crewman trades a few ordinary remarks with Gemling as the wagons continue past the fields.',
  });
  return scene;
}
function locationAlias(context: GMContext, id: string) {
  return Object.entries(locationReferences(context)).find(([, place]) => place.id === id)![0];
}
function actorAlias(context: GMContext, id: string) {
  return Object.entries(actorReferences(context)).find(([, actor]) => actor.id === id)![0];
}

it('moves registered caravan companions with their escort and retains conversations at both ends', () => {
  const context = caravan();
  const actor = context.members[0];
  const origin = memberScene(context.scene, actor.id).location.id!;
  context.scene.npcs = {
    broker: {
      id: 'broker',
      name: 'Oren Vask',
      aliases: [],
      locationId: origin,
      status: 'alive',
      allegiance: null,
      fact: 'Oren travels with the caravan.',
    },
    driver: {
      id: 'driver',
      name: 'Tovek',
      aliases: [],
      locationId: origin,
      status: 'alive',
      allegiance: null,
      followingMemberId: actor.id,
      fact: 'Tovek drives the cart.',
    },
  };
  const scene = caravanDeparture(context);
  const move = scene.beats.find((beat) => beat.kind === 'move' && beat.actor === actor.id)!;
  if (move.kind !== 'move') throw new Error('Expected travel.');
  move.with = ['Oren Vask'];
  const value = compileSceneTurn(context, scene);
  const to = move.to;
  expect([
    ...new Set(value.npcUpdates?.filter((update) => update.locationId === to).map((update) => update.npcId)),
  ]).toEqual(['broker', 'driver']);
  applyNPCUpdates(context.scene, value, (ref) => ref);
  expect(context.scene.npcs.broker).toMatchObject({ locationId: to, followingMemberId: actor.id });
  expect(context.scene.npcs.driver).toMatchObject({ locationId: to, followingMemberId: actor.id });
  // The relationship is saved once; later movement omits with and still carries the same people.
  context.scene.memberLocations![actor.id] = origin;
  for (const npc of Object.values(context.scene.npcs)) npc.locationId = origin;
  delete move.with;
  const again = compileSceneTurn(context, scene);
  expect([
    ...new Set(again.npcUpdates?.filter((update) => update.locationId === to).map((update) => update.npcId)),
  ]).toEqual(['broker', 'driver']);
});

it('preserves an NPC introduction before travel and their later conversation as separate observed states', () => {
  const context = fixture();
  const actor = context.members[0];
  const at = memberScene(context.scene, actor.id).location.id!;
  context.turn.actions[0].text = 'Meet the guide, then walk downstairs.';
  const scene = descent(context);
  scene.beats.unshift({
    kind: 'meet',
    actor: actor.id,
    person: { npcId: 'guide-sella', name: 'Guide Sella', followingMemberId: 'actor:1' },
    fact: 'Guide Sella introduces herself and agrees to travel with Moryan.',
    text: '“Sella,” says the guide. “I will come with you.”',
  });
  const move = scene.beats.find((beat) => beat.kind === 'move')!;
  if (move.kind !== 'move') throw new Error('Expected travel.');
  scene.beats.splice(2, 0, {
    kind: 'world',
    at: move.to,
    fact: 'Guide Sella points out the maintenance lever.',
    text: 'Sella points to the lever.',
    npcs: [{ npcId: 'guide-sella', name: 'Guide Sella' }],
  });
  const value = compileSceneTurn(context, scene);
  expect(
    value.npcUpdates?.filter((update) => update.npcId === 'guide-sella').map((update) => update.locationId),
  ).toEqual([at, move.to]);
  applyNPCUpdates(context.scene, value, (ref) => ref);
  expect(context.scene.npcs?.['guide-sella']).toMatchObject({
    locationId: move.to,
    followingMemberId: actor.id,
  });
});

it.each(['remote', 'dead', 'fighting'])('refuses an unsupported %s travelling companion', (kind) => {
  const context = caravan();
  const actor = context.members[0];
  const origin = memberScene(context.scene, actor.id).location.id!;
  const name = 'Travelling guard';
  context.scene.npcs = {
    guard: {
      id: 'guard',
      name,
      aliases: [],
      locationId: kind === 'remote' ? context.scene.location.id! : origin,
      status: kind === 'dead' ? 'dead' : 'alive',
      allegiance: null,
      fact: 'A guard.',
    },
  };
  if (kind === 'fighting') {
    const enemy = enemySchema.parse({
      id: 'guard',
      name,
      hp: 12,
      defense: 10,
      attack: 1,
      damage: '1d4',
      tier: 'normal',
      description: 'A guard.',
      tactic: 'Fight.',
    });
    context.scene.places![origin].encounter = {
      enemies: [{ ...enemy, maxHp: 12, initiative: 10 }],
      round: 1,
      initiative: [],
      victory: false,
      escaped: false,
    };
  }
  const scene = caravanDeparture(context);
  const move = scene.beats.find((beat) => beat.kind === 'move' && beat.actor === actor.id)!;
  if (move.kind !== 'move') throw new Error('Expected travel.');
  move.with = ['guard'];
  expect(() => compileSceneTurn(context, scene)).toThrow();
});

it.each([
  ['I take the notice and submit myself for "private medical consultation".', true],
  ['Attack the nearest guard while yelling "take that idiot!"', false],
  ['I shout “take the tag!” at the guard.', false],
  ["I say 'take Oren's ring'.", false],
  ['I take the notice while yelling "take that idiot!"', true],
  ['I take "the Silver Key".', true],
  ['I take the stairs down.', false],
  ['Take a look at the notice.', false],
  ['Ik neem de trap naar beneden.', false],
  ['Ik neem het briefje mee.', true],
  ["I don't take the notice.", false],
  ['Pick up the pace.', false],
])('distinguishes object collection from movement and observation: %s', (text, wanted) => {
  expect(requestsPickup(text)).toBe(wanted);
});

it('rejects silently omitted collection while allowing the GM to generate the described ordinary item', () => {
  const context = fixture();
  const actor = context.members[0];
  context.turn.actions[0].text = 'I take the notice and go downstairs.';
  const scene = descent(context);
  expect(() => compileSceneTurn(context, scene)).toThrow('submitted object collection');
  scene.beats.unshift({
    kind: 'take',
    actor: actor.id,
    item: {
      source: 'consultation-notice',
      name: 'Consultation notice',
      description: 'A paper notice offering private medical consultations in the screened ritual court.',
    },
    fact: 'Moryan takes the consultation notice.',
    text: 'Moryan folds the notice and takes it along.',
  });
  const value = compileSceneTurn(context, scene);
  expect(value.storyItems).toContainEqual(
    expect.objectContaining({
      name: 'Consultation notice',
      locationId: memberScene(context.scene, actor.id).location.id,
    }),
  );
  expect(value.pickups).toHaveLength(1);
  expect(value.memberLocations).toContainEqual(
    expect.objectContaining({ memberId: actor.id, locationId: 'new:lower-chamber' }),
  );
});

it('saves a generated notice before travel and resumes publication without creating a second copy', async () => {
  const f = await table((context) => {
    const scene = descent(context);
    const actor = context.members.find((member) => member.character.name === 'Moryan')!;
    scene.beats = scene.beats.filter((beat) => 'actor' in beat && beat.actor === actor.id);
    scene.beats.unshift({
      kind: 'take',
      actor: actor.id,
      item: {
        source: 'consultation-notice',
        name: 'Consultation notice',
        description: 'A notice offering private medical consultations in the screened ritual court.',
      },
      fact: 'Moryan takes the consultation notice.',
      text: 'Moryan folds the consultation notice and takes it along.',
    });
    return scene;
  });
  try {
    f.db.exec(
      "CREATE TRIGGER interrupt_notice BEFORE UPDATE OF gm_memory ON campaigns BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;",
    );
    const turnId = f.submit({ Moryan: 'I take the notice and go downstairs.', Katooluman: '' });
    await f.game.idle();
    expect(f.game.pending(f.campaign.id)?.phase).toBe('failed');
    const saved = JSON.parse(f.game.pending(f.campaign.id)!.draft!);
    expect(saved.resolution).toBeDefined();
    const draws = f.draw.mock.calls.length;
    f.db.exec('DROP TRIGGER interrupt_notice');
    const game = new Game(f.db, () => f.provider, f.draw);
    game.retry(f.campaign.id, f.host.id);
    await game.idle();
    const snapshot = game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    const actor = snapshot.members.find((member) => member.character.name === 'Moryan')!;
    const items = actor.state.inventory.filter((item) => item.name === 'Consultation notice');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tool',
      quantity: 1,
      description: expect.stringContaining('private medical consultations'),
    });
    expect(memberScene(snapshot.scene, actor.id).location.name).toBe('Bell Tower Lower Chamber');
    expect(snapshot.history.at(-1)?.id).toBe(turnId);
    expect(snapshot.history.at(-1)?.result?.narration).toContain('notice');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.draw).toHaveBeenCalledTimes(draws);
  } finally {
    f.db.close();
  }
});

it('keeps a caravan companion attached across publication, restart and another journey without repeated instructions', async () => {
  let origin: string;
  const f = await table((context) => {
    const actor = context.members.find((member) => member.character.name === 'Moryan')!;
    if (context.turn.number === 6) {
      const scene = descent(context);
      scene.beats = scene.beats.filter((beat) => 'actor' in beat && beat.actor === actor.id);
      const move = scene.beats[0];
      if (move.kind !== 'move') throw new Error('Expected travel.');
      move.with = ['Oren Vask'];
      return scene;
    }
    return {
      version: 3,
      summary: 'The escort returns upstairs.',
      beats: [
        {
          kind: 'move',
          actor: actor.id,
          to: origin,
          fact: 'Moryan goes back upstairs.',
          text: 'Moryan returns upstairs with the caravan broker.',
        },
      ],
    };
  });
  try {
    const actor = f.members.find((member) => member.character.name === 'Moryan')!;
    const scene: Scene = JSON.parse(f.game.campaign(f.campaign.id).scene!);
    origin = memberScene(scene, actor.id).location.id!;
    scene.npcs ??= {};
    scene.npcs.broker = {
      id: 'broker',
      name: 'Oren Vask',
      aliases: [],
      locationId: origin,
      status: 'alive',
      allegiance: 'Caravan crew',
      fact: 'Oren has agreed to travel with the escort.',
    };
    f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), f.campaign.id);
    f.submit({ Moryan: 'Go downstairs with Oren.', Katooluman: '' });
    await f.game.idle();
    let snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.scene.npcs?.broker).toMatchObject({
      locationId: memberScene(snapshot.scene, actor.id).location.id,
      followingMemberId: actor.id,
    });
    const game = new Game(f.db, () => f.provider, f.draw);
    const turn = game.pending(f.campaign.id)!;
    for (const member of f.members)
      game.submit(
        f.campaign.id,
        member.playerId,
        turn.id,
        member.id === actor.id ? 'Go upstairs.' : '',
        member.id !== actor.id,
      );
    await game.idle();
    snapshot = game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.scene.npcs?.broker).toMatchObject({
      locationId: origin!,
      followingMemberId: actor.id,
      allegiance: 'Caravan crew',
    });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.narrate).not.toHaveBeenCalled();
  } finally {
    f.db.close();
  }
});

it('persists an invented successful finding as a physical change that enables the next submitted action', async () => {
  const destination = randomUUID();
  const f = await table((context) => {
    const actor = context.members.find((member) => member.character.name === 'Moryan')!;
    if (context.turn.number === 6)
      return {
        version: 3,
        summary: 'Moryan finds and releases the hidden latch.',
        beats: [
          {
            kind: 'act',
            actor: actor.id,
            fact: 'Moryan finds a hidden counterweight latch and releases the iron gate.',
            text: 'Behind the worn relief, Moryan finds a recessed latch. Pulling it lifts the iron gate.',
            features: [
              { featureId: 'iron-gate', name: 'Iron gate', properties: { latched: false }, passable: true },
            ],
            journal: { kind: 'fact', name: 'Hidden gate latch' },
            progress: { thread: 'premise', kind: 'discovery' },
          },
        ],
      };
    expect(context.scene.features?.['iron-gate'].properties.latched).toBe(false);
    expect(context.scene.worldMap?.connections.find((edge) => edge.to === destination)?.blocked).toBe(false);
    return {
      version: 3,
      summary: 'Moryan walks through the opened gate.',
      beats: [
        {
          kind: 'move',
          actor: actor.id,
          to: destination,
          fact: 'Moryan walks through the open iron gate into the garden.',
          text: 'Moryan steps through the raised gate into the garden.',
        },
      ],
    };
  });
  try {
    const actor = f.members.find((member) => member.character.name === 'Moryan')!;
    const scene: Scene = JSON.parse(f.game.campaign(f.campaign.id).scene!);
    const origin = memberScene(scene, actor.id).location.id!;
    scene.places![destination] = {
      location: { id: destination, name: 'Garden', atmosphere: 'A quiet garden.', hazard: '' },
      encounter: null,
      loot: [],
      encounterRisk: { danger: 'safe', reason: 'An enclosed garden.' },
    };
    scene.worldMap!.nodes[destination] = { id: destination, name: 'Garden', visited: true };
    scene.worldMap!.connections.push({
      from: origin,
      to: destination,
      blocked: true,
      bidirectional: true,
      label: 'Iron gate',
    });
    scene.features = {
      ...scene.features,
      'iron-gate': {
        id: 'iron-gate',
        name: 'Iron gate',
        aliases: [],
        locationId: origin,
        properties: { latched: true },
        route: { from: origin, to: destination },
        fact: 'The iron gate is shut.',
      },
    };
    f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), f.campaign.id);
    const adjudicate = f.provider.adjudicate!;
    f.provider.adjudicate = async (context, tools) => {
      if (context.turn.number === 6)
        tools({
          memberId: actor.id,
          stat: 'INT',
          dc: 10,
          mode: 'normal',
          lethal: false,
          reason: 'Find the concealed gate mechanism and release it.',
        });
      return adjudicate(context, tools);
    };
    f.draw.mockImplementation((sides) => (sides === 20 ? 18 : sides));
    f.submit({ Moryan: 'Find the hidden mechanism and open the iron gate.', Katooluman: '' });
    await f.game.idle();
    expect(f.game.snapshot(f.campaign.id, f.host.id).turn?.phase).toBe('collecting');
    f.submit({ Moryan: 'Walk to the Garden.', Katooluman: '' });
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(memberScene(snapshot.scene, actor.id).location.id).toBe(destination);
    expect(snapshot.journal.find((entry) => entry.name === 'Hidden gate latch')?.detail).toContain(
      'hidden counterweight latch',
    );
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  } finally {
    f.db.close();
  }
});

it('accepts the recorded eight-attempt location failure in one response by repairing its unique named reference', async () => {
  const context = referenceCaravan();
  context.requestBudget = { used: 0, limit: 1 };
  const original = structuredClone(vaalReferences.response);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const input = JSON.parse(JSON.parse(init!.body as string).input[0].content);
    const alias = locationAlias(context, context.scene.memberLocations![context.members[0].id]);
    expect(input.members[0].locationId).toBe(alias);
    expect(input.scene.worldMap.nodes[alias].id).toBe(alias);
    expect(input.locationRefs[alias]).toEqual({ id: alias, name: 'North Road' });
    expect(input.members[0].id).toBe(actorAlias(context, context.members[0].id));
    expect(input.actorRefs[input.members[0].id]).toEqual({ id: input.members[0].id, name: context.members[0].character.name });
    return response(validReferenceScene());
  });
  const value = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
  expect(fetcher).toHaveBeenCalledTimes(1);
  const causeway = Object.values(context.scene.worldMap!.nodes).find(
    (node) => node.name === 'North Causeway',
  )!;
  expect(value.mapUpdates?.connections).toContainEqual(
    expect.objectContaining({
      from: 'new:north-road-beyond',
      to: causeway.id,
    }),
  );
  expect(value.mapUpdates?.locations).toEqual([]);
  expect(value.memberLocations?.[0].locationId).toBe('new:north-road-beyond');
  expect(value.memberLocations?.[1].locationId).toBe(
    Object.values(context.scene.worldMap!.nodes).find((node) => node.name === 'Canal Loading Yard')!.id,
  );
  expect(value.npcUpdates).toContainEqual(expect.objectContaining({
    npcId: 'caravan-crewman', locationId: 'new:north-road-beyond',
  }));
  expect(context.turn.rolls).toEqual([]);
  expect(vaalReferences.response).toEqual(original);
});

it('reports all unresolved scene references together so one correction replaces the broken references', async () => {
  const context = referenceCaravan();
  context.requestBudget = { used: 0, limit: 2 };
  const unnamed = validReferenceScene();
  const broken = vaalReferences.response.beats[0].exits[1].to;
  for (const beat of unnamed.beats)
    if ('exits' in beat) for (const exit of beat.exits ?? []) if (exit.to === broken) delete exit.name;
  const fixed = validReferenceScene();
  const causeway = Object.values(context.scene.worldMap!.nodes).find(
    (node) => node.name === 'North Causeway',
  )!;
  for (const beat of fixed.beats)
    if ('exits' in beat)
      for (const exit of beat.exits ?? []) if (exit.to === broken) exit.to = locationAlias(context, causeway.id);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (fetcher.mock.calls.length === 1) return response(unnamed);
    const feedback = JSON.parse(init!.body as string).input.at(-1).content;
    expect(feedback).toContain('beats[0].exits[1].to');
    expect(feedback).toContain('beats[1].exits[0].to');
    expect(feedback).toContain('North Causeway');
    expect(feedback).toContain(locationAlias(context, causeway.id));
    return response(fixed);
  });
  const value = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(value.memberLocations).toHaveLength(2);
});

it('normalizes only location fields in scene beats, notes and nested updates', () => {
  const context = referenceCaravan();
  const from = context.scene.memberLocations![context.members[0].id];
  const to = context.scene.memberLocations![context.members[1].id];
  const alias = locationAlias(context, from);
  const raw = {
    version: 3,
    beats: [
      {
        kind: 'world',
        at: alias,
        fact: alias,
        npcs: [
          { npcId: alias, locationId: alias },
          { npcId: 'lost', locationId: null },
        ],
        features: [
          {
            featureId: alias,
            route: { from: alias, to: locationAlias(context, to) },
            properties: { text: alias },
          },
        ],
        exits: [{ to: 'new:preview', name: 'New waystation' }],
      },
      { kind: 'take', actor: alias, itemId: alias },
    ],
    notes: [{ id: alias, locationId: alias }],
  };
  const before = structuredClone(raw);
  const value = normalizeAdjudicationReferences(context, raw) as typeof raw;
  expect(value.beats[0]).toMatchObject({
    at: from,
    fact: alias,
    npcs: [
      { npcId: alias, locationId: from },
      { npcId: 'lost', locationId: null },
    ],
    features: [{ featureId: alias, route: { from, to }, properties: { text: alias } }],
    exits: [{ to: 'new:preview' }],
  });
  expect(value.beats[1]).toEqual(raw.beats[1]);
  expect(value.notes).toEqual([{ id: alias, locationId: from }]);
  expect(raw).toEqual(before);
});

it('refuses to guess between duplicate or conflicting place identities', () => {
  const context = referenceCaravan();
  const causeway = Object.values(context.scene.worldMap!.nodes).find(
    (node) => node.name === 'North Causeway',
  )!;
  context.scene.worldMap!.nodes['other-causeway'] = {
    id: 'other-causeway',
    name: causeway.name,
    visited: false,
  };
  expect(() => compileSceneTurn(context, vaalReferences.response)).toThrow('Unknown location references');
  delete context.scene.worldMap!.nodes['other-causeway'];
  const conflicting = structuredClone(vaalReferences.response);
  conflicting.beats[1].exits[0].name = 'North Road';
  expect(() => compileSceneTurn(context, conflicting)).toThrow('Conflicting named location references');
  const separate = structuredClone(vaalReferences.response);
  separate.beats[0].place.name = 'North Road';
  const normalized = normalizeAdjudicationReferences(context, separate) as typeof separate;
  expect(normalized.beats[0].to).toBe('new:north-road-beyond');
});

it('publishes the recorded location-reference failure in an isolated game with one scene response', async () => {
  const f = await table(
    (context) => {
      const actors = new Map(
        vaalReferences.members.map((saved) => [
          saved.id,
          context.members.find((member) => member.character.name === saved.name)!.id,
        ]),
      );
      return JSON.parse(
        JSON.stringify(validReferenceScene(), (_key, value) =>
          typeof value === 'string' ? (actors.get(value) ?? value) : value,
        ),
      );
    },
    { scene: vaalReferences.scene as Scene, members: vaalReferences.members, journal: [] },
  );
  try {
    f.db.prepare('UPDATE turns SET number=19 WHERE id=?').run(f.game.pending(f.campaign.id)!.id);
    f.submit();
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.turn?.number).toBe(20);
    const gemling = snapshot.members.find((member) => member.character.name === 'Gemling legionaire')!;
    const xulath = snapshot.members.find((member) => member.character.name === 'Xulath')!;
    expect(memberScene(snapshot.scene, gemling.id).location.name).toBe('Outer North Road');
    expect(memberScene(snapshot.scene, xulath.id).location.name).toBe('Canal Loading Yard');
    expect(snapshot.scene.npcs?.['caravan-crewman']).toMatchObject({
      name: 'Caravan crewman', locationId: memberScene(snapshot.scene, gemling.id).location.id,
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.narrate).not.toHaveBeenCalled();
    expect(snapshot.history.at(-1)?.rolls).toEqual([]);
  } finally {
    f.db.close();
  }
});

it.each(['start_combat', 'investigate'])(
  'resolves scene location aliases before %s and returns aliases in its receipt',
  async (name) => {
    const context = fixture();
    context.requestBudget = { used: 0, limit: 2 };
    const at = context.scene.location.id!;
    const alias = locationAlias(context, at);
    const finding = investigate(context, false);
    finding.source = { kind: 'place', id: alias, locationId: alias };
    finding.preparation.locationId = alias;
    finding.success.lead.locationId = alias;
    finding.failure.lead.locationId = alias;
    const receipt = { memberId: finding.memberId, locationId: at, source: { kind: 'place', id: at, locationId: at } };
    const gameTools = Object.assign(tools(context), { investigate: vi.fn(() => receipt) });
    vi.mocked(gameTools.startCombat).mockReturnValue(receipt as never);
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (fetcher.mock.calls.length === 1)
        return toolResponse(
          name,
          name === 'investigate'
            ? { ...finding, memberId: actorAlias(context, finding.memberId) }
            : { locationId: alias, enemies: [], introduction: 'Sentries bar the road.' },
        );
      const output = JSON.parse(init!.body as string).input.find(
        (item: { type?: string }) => item.type === 'function_call_output',
      );
      expect(JSON.parse(output.output)).toEqual({
        memberId: actorAlias(context, finding.memberId),
        locationId: alias,
        source: { kind: 'place', id: alias, locationId: alias },
      });
      return response(descent(context));
    });
    await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, gameTools);
    expect(fetcher).toHaveBeenCalledTimes(2);
    if (name === 'start_combat')
      expect(gameTools.startCombat).toHaveBeenCalledExactlyOnceWith([], at, 'Sentries bar the road.');
    else
      expect(gameTools.investigate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          memberId: finding.memberId,
          source: { kind: 'place', id: at, locationId: at },
          preparation: expect.objectContaining({ locationId: at }),
          success: expect.objectContaining({ lead: expect.objectContaining({ locationId: at }) }),
          failure: expect.objectContaining({ lead: expect.objectContaining({ locationId: at }) }),
        }),
      );
  },
);

it.each(['roll_check', 'use_resource'])(
  'round-trips short character references through %s without changing item IDs or prose',
  async (name) => {
    const context = fixture();
    context.requestBudget = { used: 0, limit: 2 };
    const [actor, target] = context.members;
    const acting = actorAlias(context, actor.id);
    const helping = actorAlias(context, target.id);
    const receipt = { memberId: actor.id, targetId: target.id, itemId: acting, fact: helping };
    const gameTools = tools(context);
    vi.mocked(gameTools).mockReturnValue(receipt as never);
    gameTools.useResource = vi.fn(() => receipt as never);
    const args =
      name === 'roll_check'
        ? {
            memberId: acting,
            assistsMemberId: helping,
            assistedBy: [helping],
            stat: 'WIS',
            dc: 10,
            mode: 'normal',
            reason: 'Read the markings.',
          }
        : { memberId: acting, targetId: helping, itemId: acting, abilityName: null };
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (fetcher.mock.calls.length === 1) return toolResponse(name, args);
      const output = JSON.parse(init!.body as string).input.find(
        (item: { type?: string }) => item.type === 'function_call_output',
      );
      expect(JSON.parse(output.output)).toEqual({
        memberId: acting,
        targetId: helping,
        itemId: acting,
        fact: helping,
      });
      const scene = descent(context);
      for (const beat of scene.beats) if ('actor' in beat) beat.actor = actorAlias(context, beat.actor);
      return response(scene);
    });
    const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, gameTools);
    expect(fetcher).toHaveBeenCalledTimes(2);
    if (name === 'roll_check')
      expect(gameTools).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          memberId: actor.id,
          assistsMemberId: target.id,
          assistedBy: [target.id],
        }),
      );
    else
      expect(gameTools.useResource).toHaveBeenCalledExactlyOnceWith({
        memberId: actor.id,
        targetId: target.id,
        itemId: acting,
        abilityName: null,
      });
    expect(accepted.actions.map((action) => action.memberId)).toEqual(
      context.turn.actions.map((action) => action.memberId),
    );
  },
);

it.each([false, true])(
  'publishes new gathering scenes and persistent surprises without another writer, including restart=%s',
  async (interrupted) => {
    const middle = vaalGathering.turn.actions.find((action) => action.gathering)!.gathering!.route[1];
    const strange = 'A stone marker unfolds into a mouth and demands its maker’s name.';
    const f = await table(
      (context) => {
        expect(context.sceneProtocol).toBe(true);
        const joiner = context.turn.actions.find((action) => action.gathering)!;
        return {
          version: 3,
          summary: 'Xulath reaches the talking marker.',
          beats: [
            {
              kind: 'gather',
              actor: actorAlias(context, joiner.memberId),
              text: 'Xulath follows the familiar road beyond the waystation.',
              stop: { at: middle, fact: strange, text: strange },
            },
            {
              kind: 'world',
              at: middle,
              fact: 'The speaking marker blocks the road.',
              text: 'Its carved letters move like lips.',
              features: [
                {
                  featureId: 'speaking-marker',
                  name: 'Speaking marker',
                  properties: { demand: 'Its maker’s name.' },
                },
              ],
              place: {
                name: context.scene.places![middle].location.name,
                atmosphere: 'A stone marker speaks beside the irrigation channels.',
                hazard: 'The marker bars the way.',
                danger: 'dangerous',
                riskReason: 'The awakened stone blocks travellers.',
              },
            },
          ],
          notes: [
            {
              id: 'speaking-marker',
              locationId: middle,
              cause: 'PRIVATE: An old road ward responds to imperial couriers.',
              discoveries: ['The maker’s name is carved underneath.'],
              actors: 'The road ward awaits an answer.',
              nextChange: 'The ward asks again.',
              dueTurn: context.turn.number + 2,
              status: 'open',
            },
          ],
        };
      },
      {
        scene: vaalGathering.scene as Scene,
        members: vaalGathering.members.map((member) => ({ ...member, action: '' })),
        journal: [],
      },
    );
    try {
      const gemling = f.members.find((member) => member.character.name === 'Gemling legionaire')!;
      const xulath = f.members.find((member) => member.id !== gemling.id)!;
      const turn = f.game.pending(f.campaign.id)!;
      f.game.callGathering(f.campaign.id, gemling.playerId, turn.id);
      const gathering = f.game.snapshot(f.campaign.id, f.host.id).scene.gathering!;
      if (interrupted)
        f.db.exec(
          "CREATE TRIGGER interrupt_gather BEFORE UPDATE OF gm_memory ON campaigns BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;",
        );
      f.game.submit(f.campaign.id, xulath.playerId, turn.id, '', false, false, null, null, gathering.id);
      f.game.submit(f.campaign.id, gemling.playerId, turn.id, '', true);
      await f.game.idle();
      let game = f.game;
      if (interrupted) {
        expect(game.pending(f.campaign.id)?.phase).toBe('failed');
        const checkpoint = JSON.parse(game.pending(f.campaign.id)!.draft!);
        expect(checkpoint.adjudication.sceneDraft).toBeDefined();
        expect(game.snapshot(f.campaign.id, f.host.id).scene.features?.['speaking-marker']).toBeUndefined();
        const draws = f.draw.mock.calls.length;
        f.db.exec('DROP TRIGGER interrupt_gather');
        game = new Game(f.db, () => f.provider, f.draw);
        game.retry(f.campaign.id, f.host.id);
        await game.idle();
        expect(f.draw).toHaveBeenCalledTimes(draws);
      }
      const snapshot = game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      expect(memberScene(snapshot.scene, xulath.id).location.id).toBe(middle);
      expect(memberScene(snapshot.scene, gemling.id).location.id).toBe(gathering.locationId);
      expect(snapshot.scene.features?.['speaking-marker']).toMatchObject({
        locationId: middle,
        properties: { demand: 'Its maker’s name.' },
      });
      expect(snapshot.journal).toContainEqual(expect.objectContaining({ detail: strange }));
      expect(snapshot.history.at(-1)?.result?.narration).toContain(strange);
      expect(snapshot.history.at(-1)?.result?.xp).toBe(0);
      expect(
        snapshot.history.at(-1)?.rolls.filter((roll) => roll.reason === 'Random encounter'),
      ).toHaveLength(1);
      expect(JSON.parse(game.campaign(f.campaign.id).gm_memory)[0].cause).toContain('PRIVATE');
      expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(f.narrate).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  },
);

it('repairs the recorded cart turn without dropping onward travel or joining at the shared focus', async () => {
  const context = caravan();
  const fixed = caravanDeparture(context);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    const input = JSON.parse(body.input[0].content);
    expect(input.members[0].locationId).toBe(locationAlias(context, context.scene.memberLocations![context.members[0].id]));
    expect(input.submittedTravel[actorAlias(context, context.members[0].id)]).toEqual({ onward: true });
    expect(input.submittedTravel[actorAlias(context, context.members[1].id)]).toMatchObject({
      goalId: locationAlias(context, context.scene.memberLocations![context.members[0].id]),
      companionId: actorAlias(context, context.members[0].id),
    });
    const call = fetcher.mock.calls.length;
    if (call === 1) return response(vaalTravel.sameLocationMove);
    if (call === 2) {
      expect(body.input.at(-1).content).toContain('Preserve submitted onward travel');
      return response(vaalTravel.droppedTravel);
    }
    expect(body.input.at(-1).content).toContain('submitted travel');
    return response(fixed);
  });
  const value = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(value.memberLocations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ memberId: context.members[0].id, locationId: 'new:ceremonial-gates' }),
      expect.objectContaining({
        memberId: context.members[1].id,
        locationId: context.scene.memberLocations![context.members[0].id],
      }),
    ]),
  );
  expect(value.actions.find((action) => action.memberId === context.members[1].id)?.travel?.goalId).toBe(
    memberScene(context.scene, context.members[0].id).location.id,
  );
  expect(value.mapUpdates?.connections).toContainEqual(
    expect.objectContaining({
      from: 'new:ceremonial-gates',
      to: 'new:north-road',
      blocked: false,
    }),
  );
});

it('requires a move for each explicit travel request even when conversation fails', () => {
  const context = caravan();
  context.turn.actions[1].passed = true;
  context.turn.rolls.push({
    id: 'failed-conversation',
    memberId: context.members[0].id,
    stat: 'CHA',
    dc: 10,
    mode: 'normal',
    dice: [2],
    modifier: 0,
    total: 2,
    success: false,
    reason: 'The driver is distracted.',
    lethal: false,
    source: 'test',
  });
  const stationary = structuredClone(vaalTravel.droppedTravel);
  stationary.beats = stationary.beats.filter((beat) => beat.actor === context.members[0].id);
  expect(() => compileSceneTurn(context, stationary)).toThrow('submitted travel');
  const moving = caravanDeparture(context);
  moving.beats.shift();
  const value = compileSceneTurn(context, moving);
  expect(value.actions[0]).toMatchObject({
    status: 'partial',
    components: { movement: { status: 'success' }, main: { status: 'failure' } },
  });
  expect(value.memberLocations?.[0].locationId).toBe('new:ceremonial-gates');
});

it('requires first-arrival routes while permitting an explicitly described dead end', () => {
  const context = caravan();
  const proposal = caravanDeparture(context);
  const move = proposal.beats[1];
  if (move.kind !== 'move') throw new Error('fixture');
  delete move.exits;
  expect(() => compileSceneTurn(context, proposal)).toThrow('needs explicit exits');
  move.exits = [];
  expect(() => compileSceneTurn(context, proposal)).toThrow('onward exit');
  move.place!.deadEnd = 'The forecourt ends at the barred gate; the avenue is the only way back.';
  move.text = 'Gemling reaches the forecourt, where a barred gate closes the road ahead.';
  const value = compileSceneTurn(context, proposal);
  expect(value.placeUpdates?.find((place) => place.ref === 'new:ceremonial-gates')?.location.hazard)
    .toContain(move.place!.deadEnd);
  expect(value.memberLocations?.some((position) => position.locationId === 'new:ceremonial-gates')).toBe(
    true,
  );
});

it('takes one reachable hop toward a distant companion and leaves that companion in place', () => {
  const context = caravan();
  const gemling = context.members[0];
  const xulath = context.members[1];
  const steps = context.scene.location.id!;
  const temple = Object.values(context.scene.worldMap!.nodes).find(
    (node) => node.name === 'The Temple Ward',
  )!;
  context.scene.memberLocations![xulath.id] = temple.id;
  context.turn.actions[0].passed = true;
  const proposal = caravanDeparture(context);
  proposal.notes = [];
  proposal.beats = [
    {
      kind: 'move',
      actor: xulath.id,
      to: steps,
      fact: 'Xulath travels from Temple Ward to Sunward Steps on his way to Gemling on the avenue.',
      text: 'Xulath reaches Sunward Steps; Gemling is still farther along the route.',
    },
  ];
  const value = compileSceneTurn(context, proposal);
  expect(value.memberLocations).toEqual([
    expect.objectContaining({ memberId: xulath.id, locationId: steps }),
  ]);
  expect(value.actions.find((action) => action.memberId === xulath.id)?.travel?.goalId).toBe(
    memberScene(context.scene, gemling.id).location.id,
  );
});

it('retains a real blocked journey without inventing an arrival', () => {
  const context = caravan();
  context.turn.actions[1].passed = true;
  const value = compileSceneTurn(context, {
    version: 3,
    notes: [],
    summary: 'The cart stops at a newly lowered barrier.',
    beats: [
      {
        kind: 'act',
        actor: context.members[0].id,
        slot: 'main',
        blocked: 'Guards have lowered a barrier across the lane ahead of the cart.',
        fact: 'The cart stops before the lowered barrier; Gemling remains on Processional Avenue.',
        text: 'Guards lower a barrier across the lane, bringing the cart to a halt.',
      },
    ],
  });
  expect(value.actions[0].status).toBe('blocked');
  expect(value.memberLocations).toEqual([]);
});

it.each([
  ['Join gemling', 'companion'],
  ['Go to the avenue, search around along the way', 'goal'],
  ['Ask him about the ledger, while proceeding to follow the cart', 'onward'],
  ['Volg de kar naar de volgende locatie', 'onward'],
  ['Ik sluit me aan bij Gemling', 'companion'],
  ['I do not follow the cart; I wait here.', null],
  ['I say "follow the cart to the next area" and stay here.', null],
  ["I follow the cart driver's instructions.", null],
  ['Follow the cart around the same area.', null],
  ['Ask where Gemling went.', null],
])('recognizes explicit travel without interpreting dialogue or local footwork: %s', (text, kind) => {
  const context = caravan();
  context.turn.actions[1].text = text;
  const journey = submittedTravel(context, context.members[1].id);
  if (!kind) expect(journey).toBeUndefined();
  else if (kind === 'onward') expect(journey).toEqual({ onward: true });
  else expect(journey?.goalId).toBe(memberScene(context.scene, context.members[0].id).location.id);
});

it.each([true, false])(
  'supplies focused openings, party gathering, observed NPCs and relevant factions in both protocols (scene=%s)',
  async (sceneProtocol) => {
    const context = fixture();
    context.sceneProtocol = sceneProtocol;
    context.turn.number = 0;
    context.turn.actions = [];
    context.factions = factionExample(['wardens', 'traders', 'scholars'], context.config.setting, [], 0);
    const relevantFaction = context.factions.factions[0];
    const at = context.scene.location.id!;
    context.scene.memberLocations = Object.fromEntries(context.members.map((member) => [member.id, at]));
    const opening: SceneTurn = {
      version: 3,
      opening: { npcs: ['new:watchman', 'new:bellkeeper'], features: ['sluice'], quests: [], mysteries: [] },
      notes: [],
      summary: 'A flood threatens the lane; the sluice workshop is accessible.',
      beats: [
        {
          kind: 'world',
          at,
          fact: 'A broken sluice is flooding Bell Tower Lane. A bell warns the residents. An open eastward passage reaches the sluice workshop.',
          features: [{ featureId: 'sluice', name: 'Broken sluice', properties: { broken: true } }],
          text: 'A warning bell rings as water pours through the broken sluice into Bell Tower Lane. To the east, an open passage leads to the sluice workshop.',
          place: {
            name: context.scene.location.name,
            atmosphere: 'Floodwater runs beneath the tower as the warning bell rings.',
            hazard: 'A broken sluice floods the lane.',
            danger: 'dangerous',
            riskReason: 'Water from the broken sluice threatens the lane.',
          },
          exits: [
            {
              to: 'new:workshop',
              name: 'Sluice workshop',
              label: 'East passage',
              blocked: false,
              bidirectional: true,
            },
          ],
        },
        {
          kind: 'world',
          at,
          fact: `The party met at the bell tower after their ferry stopped here. ${context.members.map((member) => `${member.character.name}: ${member.character.concept}.`).join(' ')}`,
          text: `The same interrupted ferry journey brought you to the bell tower. ${context.members.map((member) => `${member.character.name}: ${member.character.concept}.`).join(' ')}`,
          journal: { kind: 'fact', name: 'How the party met' },
        },
        {
          kind: 'world',
          at,
          fact: 'A mud-streaked watchman holds a broken rope while an elderly bellkeeper rings the warning bell.',
          text: 'A mud-streaked watchman holds a broken rope; beside him an elderly bellkeeper rings the warning bell.',
          npcs: [
            { npcId: 'new:watchman', name: 'Mud-streaked watchman' },
            { npcId: 'new:bellkeeper', name: 'Elderly bellkeeper' },
          ],
        },
        {
          kind: 'world',
          at,
          fact: `${relevantFaction.name}: ${relevantFaction.identity}. Their warning bell alerts the residents.`,
          text: `The warning bell of ${relevantFaction.name} carries across the rising water.`,
          factions: [
            { type: 'discover', factionId: relevantFaction.id, knownDescription: relevantFaction.identity },
          ],
        },
      ],
    };
    const compiled = compileSceneTurn(context, opening);
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.instructions).toContain('80–120 words TOTAL across two or three short paragraphs');
      expect(body.instructions).toContain('Explain the party gathering in one short sentence');
      expect(body.instructions).toContain('invent a plausible recent shared circumstance');
      expect(body.instructions).toContain('Character cards already identify the party');
      expect(body.instructions).toContain('Autonomous constructs use NPC identities');
      expect(body.instructions).toContain('Make two or three available people, objects or routes concrete');
      expect(body.instructions).toContain('On the first actual player interaction with a previously only observed NPC');
      expect(body.instructions).toContain('Reuse the same NPC ID');
      expect(body.instructions).toContain('who or what is affected, and why delay matters');
      expect(body.instructions).toContain('Fuller public descriptions belong in the journal for optional reading');
      expect(body.instructions).not.toContain('EVERY supplied faction');
      expect(body.instructions).not.toContain('short individual introduction');
      expect(body.instructions).toContain('at least one open onward route beyond the way back');
      expect(body.instructions).not.toContain('Opening turn0 can reveal zero');
      return response(sceneProtocol ? opening : compiled);
    });
    const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
    expect(accepted.actions).toEqual([]);
    expect(accepted.rewards).toMatchObject({ xp: 0, currency: 0 });
    expect(accepted.factionEffects?.map((effect) => effect.factionId)).toEqual([
      'wardens',
    ]);
    expect(accepted.journal).toContainEqual(expect.objectContaining({ kind: 'fact', name: 'How the party met' }));
    expect(accepted.npcUpdates?.map((npc) => npc.npcId)).toEqual(['new:watchman', 'new:bellkeeper']);
    const facts = accepted.events.map((event) => event.fact).join(' ');
    for (const member of context.members) expect(facts).toContain(member.character.name);
    expect(facts).toContain(relevantFaction.identity);
    for (const faction of context.factions.factions.slice(1)) {
      expect(facts).not.toContain(faction.name);
      expect(facts).not.toContain(faction.privateAgenda);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

function recordedCombat(saved = recordedCombats[0]): GMContext {
  const context = fixture();
  const actor = context.members.find((member) => member.character.name === 'Katooluman')!;
  actor.id = saved.memberId;
  Object.assign(actor.state, structuredClone(saved.after));
  for (const member of context.members) member.active = member.id === actor.id;
  context.startingMembers = structuredClone(context.members);
  Object.assign(
    context.startingMembers.find((member) => member.id === actor.id)!.state,
    structuredClone(saved.before),
  );
  context.scene = ensureLocations(
    {
      ...initialScene(saved.location.name),
      location: structuredClone(saved.location),
      encounter: structuredClone(saved.encounter) as Encounter,
      encounterRisk: { ...saved.encounterRisk, danger: 'dangerous' },
    },
    context.members.map((member) => member.id),
  );
  context.turn.id = saved.turnId;
  context.turn.number = saved.number;
  context.turn.roster = [actor.id];
  context.turn.actions = [{ memberId: actor.id, text: 'I attack Shadow Wight.', passed: false }];
  const combat: CombatReceipt = {
    participantIds: [actor.id],
    events: structuredClone(saved.events) as CombatReceipt['events'],
    logs: saved.events.map((event) => event.fact),
    encounter: context.scene.encounter!,
    characters: [],
    loot: [],
  };
  context.combatResult = combat;
  context.receipts = { combat, combatByLocation: { [saved.location.id]: combat } };
  return context;
}

it('appends a saved story combat cause as its own local scene event', () => {
  const context = fixture();
  const at = 'new:lower-chamber';
  const introduction =
    'The Chamber keeper emerges from the shaft to drive intruders away from the machinery.';
  context.receipts = {
    startCombatByLocation: { [at]: recordedCombat().scene.encounter! },
    combatIntroductionsByLocation: { [at]: introduction },
  };
  const accepted = compileSceneTurn(context, descent(context));
  const event = accepted.events.find((event) => event.fact === introduction)!;
  expect(event).toMatchObject({
    kind: 'world',
    phase: 'aftermath',
    locationRef: at,
    receiptRefs: ['tool:startCombatByLocation'],
  });
  expect(accepted.sceneDraft?.passages).toContainEqual({ eventIds: [event.id], text: introduction });
  expect(
    accepted.actions.find((action) => action.memberId === context.members[0].id)?.components.movement?.status,
  ).toBe('success');
});

it('binds paraphrased outcome metadata to its actual owning event without another correction', () => {
  const context = fixture();
  const scene = descent(context);
  const act = scene.beats[1];
  if (act.kind !== 'act') throw new Error('Expected the recorded conversation.');
  context.turn.actions.find((action) => action.memberId === act.actor)!.text = 'Ask Iven about the levy.';
  const fact = 'Iven says that collectors take households marked on the levy rolls.';
  act.resolves = [{ id: 'intent:0', outcome: 'resolved', fact }];
  expect(compileSceneTurn(context, scene).actionOutcomes).toContainEqual(
    expect.objectContaining({ memberId: act.actor, obligationId: 'intent:0', fact: act.fact }),
  );
  act.fact = fact;
  expect(compileSceneTurn(context, scene).actionOutcomes).toContainEqual(
    expect.objectContaining({ memberId: act.actor, obligationId: 'intent:0', fact }),
  );
});

it('repairs an introduction mistaken for a resolved combat round without executing an attack', async () => {
  const context = recordedCombat();
  const at = context.scene.location.id!;
  const introduction = 'The Shadow Wight emerges to bar the way.';
  context.combatResult = undefined;
  context.receipts = {
    startCombatByLocation: { [at]: structuredClone(context.scene.encounter!) },
    combatIntroductionsByLocation: { [at]: introduction },
  };
  const before = structuredClone(context);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    const input = JSON.parse(body.input[0].content);
    expect(input.startedLocations).toEqual([locationAlias(context, at)]);
    expect(input.mechanics).toEqual([]);
    if (fetcher.mock.calls.length === 1)
      return response({
        version: 3,
        summary: 'The fight begins.',
        beats: [{ kind: 'combat', at, text: introduction }],
      });
    expect(JSON.stringify(body.input)).toContain('No combat round has been resolved');
    expect(JSON.stringify(body.input)).toContain('separate act for every submitted actor');
    return response({
      version: 3,
      summary: 'The wight blocks the way; the first round has not begun.',
      beats: [{
        kind: 'act',
        actor: context.turn.actions[0].memberId,
        blocked: 'The wight has just appeared; the first combat round has not begun.',
        fact: 'Katooluman cannot strike before the confrontation begins; his attack has not executed.',
        text: 'Katooluman faces the newly emerged wight, his cudgel ready. His blow has yet to fall.',
      }],
    });
  });
  const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(accepted.actions[0].components.main).toMatchObject({ status: 'blocked', basis: 'none' });
  expect(accepted.events.some((event) => event.kind === 'combat')).toBe(false);
  expect(accepted.sceneDraft?.passages.filter((passage) => passage.text === introduction)).toHaveLength(1);
  expect(context).toEqual(before);
});

it.each(recordedCombats)(
  'compiles recorded combat turn $number without model-authored mechanical references',
  async (saved) => {
    const context = recordedCombat(saved);
    const mechanics = engineEvents(context);
    const before = structuredClone(context);
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      const input = JSON.parse(body.input[0].content);
      expect(input.combatState[locationAlias(context, saved.location.id)]).toMatchObject({ victory: false, enemies: [{ hp: 18 }] });
      expect(input.mechanics.map((event: { at: string }) => event.at)).toEqual(
        mechanics.map((event) => locationAlias(context, event.locationRef!)),
      );
      expect(body.instructions).toContain('kind:"combat"');
      return response({
        version: 3,
        summary: 'The Shadow Wight remains alive in the Outer Ward.',
        beats: [
          {
            kind: 'combat',
            at: saved.location.id,
            text: `Katooluman's cudgel cuts through empty darkness. ${
              saved.number === 27
                ? 'The Shadow Wight also misses, while the fire on Katooluman burns on.'
                : 'The Shadow Wight catches him in reply, leaving him wounded.'
            }`,
          },
        ],
      });
    });
    const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(context).toEqual(before);
    expect(accepted.events).toEqual(mechanics);
    expect(accepted.actions[0]).toMatchObject({
      status: 'failure',
      components: { main: { status: 'failure', basis: 'engine', eventIds: ['combat:0'] }, minor: null },
    });
    expect(accepted.actions[0].eventIds).toEqual(['combat:0']);
    expect(accepted.events.filter((event) => event.actionId === null).map((event) => event.id)).toEqual(
      mechanics.slice(1).map((event) => event.id),
    );
    expect(accepted.sceneDraft?.passages).toHaveLength(1);
    expect(accepted.sceneDraft?.passages[0].eventIds).toEqual(mechanics.map((event) => event.id));
  },
);

it('retains a missed combat main action alongside a successful healing minor', () => {
  const context = recordedCombat();
  const receipt = context.combatResult!;
  receipt.events!.splice(1, 0, {
    actorId: context.turn.actions[0].memberId,
    phase: 'minor',
    status: 'success',
    fact: 'Katooluman drinks a healing potion, recovering 4 HP.',
    locationId: context.scene.location.id,
  });
  const accepted = compileSceneTurn(context, {
    version: 3,
    summary: 'The fight continues.',
    beats: [
      {
        kind: 'combat',
        at: 'current',
        text: 'Katooluman misses, then drinks his potion before the wight strikes.',
      },
    ],
  });
  expect(accepted.actions[0]).toMatchObject({
    status: 'partial',
    components: {
      main: { status: 'failure', eventIds: ['combat:0'] },
      minor: { status: 'success', eventIds: ['combat:1'] },
    },
  });
});

it('keeps mechanical combat outcomes immutable and rejects false victory prose', () => {
  const context = recordedCombat();
  const beat = { kind: 'combat', at: 'current', text: 'The Shadow Wight is dead.' };
  expect(() =>
    compileSceneTurn(context, { version: 3, summary: 'The fight continues.', beats: [beat] }),
  ).toThrow(/18\/18 HP/);
  expect(() =>
    compileSceneTurn(context, {
      version: 3,
      summary: 'The fight continues.',
      beats: [
        {
          ...beat,
          text: 'Katooluman misses.',
          eventIds: ['combat:0'],
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    compileSceneTurn(context, {
      version: 3,
      summary: 'The fight continues.',
      beats: [
        {
          kind: 'act',
          actor: context.turn.actions[0].memberId,
          fact: 'Katooluman hits the wight.',
          text: 'Katooluman hits the wight.',
        },
      ],
    }),
  ).toThrow(/combat beat/);
});

it('keeps simultaneous fights separate without requiring enemy-event ownership from the GM', () => {
  const context = recordedCombat();
  const actor = context.members.find((member) => member.id === context.turn.actions[0].memberId)!;
  const companion = context.members.find((member) => member.id !== actor.id)!;
  companion.active = true;
  const at = randomUUID();
  context.scene.places![at] = {
    location: { ...context.scene.location, id: at, name: 'Other alley' },
    encounter: structuredClone(context.scene.encounter),
    loot: [],
    encounterRisk: context.scene.encounterRisk,
  };
  context.scene.memberLocations![companion.id] = at;
  context.scene.worldMap!.nodes[at] = { id: at, name: 'Other alley', visited: true };
  context.turn.actions.push({ memberId: companion.id, text: 'Attack the wight here.', passed: false });
  context.turn.roster.push(companion.id);
  const other = structuredClone(context.combatResult!);
  other.participantIds = [companion.id];
  other.events = other.events!.map((event) => ({
    ...event,
    actorId: event.actorId === actor.id ? companion.id : null,
    locationId: at,
    fact: event.fact.replaceAll(actor.character.name, companion.character.name),
  }));
  (context.receipts!.combatByLocation as Record<string, CombatReceipt>)[at] = other;
  const first = context.combatResult!;
  context.combatResult = {
    ...first,
    participantIds: [actor.id, companion.id],
    events: [...first.events!, ...other.events!],
    encounters: { [context.scene.location.id!]: first.encounter, [at]: other.encounter },
  };
  context.receipts!.combat = context.combatResult;
  const accepted = compileSceneTurn(context, {
    version: 3,
    summary: 'Both fights continue.',
    beats: [
      { kind: 'combat', at: 'current', text: 'Katooluman misses; the Shadow Wight wounds him.' },
      { kind: 'combat', at, text: 'Moryan misses in the other alley; the Shadow Wight strikes back.' },
    ],
  });
  expect(accepted.actions.map((action) => action.eventIds)).toEqual([['combat:0'], ['combat:3']]);
  expect(accepted.sceneDraft?.passages.map((passage) => passage.eventIds)).toEqual([
    ['combat:0', 'combat:1', 'combat:2'],
    ['combat:3', 'combat:4', 'combat:5'],
  ]);
});

it('does not duplicate an engine-resolved combat pass', () => {
  const context = recordedCombat();
  context.turn.actions[0] = { ...context.turn.actions[0], text: '', passed: true };
  context.combatResult!.events![0] = {
    ...context.combatResult!.events![0],
    fact: 'Katooluman holds position.',
    status: null,
  };
  const events = engineEvents(context);
  const accepted = compileSceneTurn(context, {
    version: 3,
    summary: 'The fight continues.',
    beats: [
      {
        kind: 'combat',
        at: 'current',
        text: 'Katooluman holds position, and the wight strikes him.',
      },
    ],
  });
  expect(accepted.events).toEqual(events);
  expect(accepted.actions[0]).toMatchObject({ status: 'passed', components: { main: null, minor: null } });
});

it('allows another character to arrive while preserving the already executed combat', () => {
  const context = recordedCombat();
  const companion = context.members.find((member) => member.id !== context.turn.actions[0].memberId)!;
  const origin = randomUUID();
  companion.active = true;
  context.scene.places![origin] = {
    location: { ...context.scene.location, id: origin, name: 'Side alley' },
    encounter: null,
    loot: [],
    encounterRisk: { danger: 'safe', reason: 'A sheltered empty passage.' },
  };
  context.scene.memberLocations![companion.id] = origin;
  context.scene.worldMap!.nodes[origin] = { id: origin, name: 'Side alley', visited: true };
  context.scene.worldMap!.connections.push({
    from: origin,
    to: context.scene.location.id!,
    label: 'Open passage',
    blocked: false,
    bidirectional: true,
  });
  context.turn.roster.push(companion.id);
  context.turn.actions.push({ memberId: companion.id, text: 'Go to the Outer Ward.', passed: false });
  const mechanics = engineEvents(context);
  const accepted = compileSceneTurn(context, {
    version: 3,
    summary: 'Moryan joins Katooluman in the Outer Ward.',
    beats: [
      { kind: 'combat', at: 'current', text: 'Katooluman misses and the wight wounds him.' },
      {
        kind: 'move',
        actor: companion.id,
        to: context.scene.location.id,
        fact: 'Moryan follows the open passage into the Outer Ward.',
        text: 'Moryan arrives from the side alley as the clash continues.',
      },
    ],
  });
  expect(accepted.events.slice(0, mechanics.length)).toEqual(mechanics);
  expect(accepted.actions.find((action) => action.memberId === companion.id)?.components).toMatchObject({
    main: null,
    movement: { status: 'success', basis: 'routine' },
  });
  expect(accepted.memberLocations).toContainEqual(
    expect.objectContaining({ memberId: companion.id, locationId: context.scene.location.id }),
  );
});

it('records an engine-resolved escape as main movement without executing it again', () => {
  const context = recordedCombat();
  const actor = context.members.find((member) => member.id === context.turn.actions[0].memberId)!;
  const destination = randomUUID();
  actor.state.conditions = ['Escaped'];
  context.scene.places![destination] = {
    location: { ...context.scene.location, id: destination, name: 'Sheltered alley' },
    encounter: null,
    loot: [],
    encounterRisk: { danger: 'safe', reason: 'The alley is sheltered from the fight.' },
  };
  context.scene.worldMap!.nodes[destination] = { id: destination, name: 'Sheltered alley', visited: true };
  context.scene.worldMap!.connections.push({
    from: context.scene.location.id!,
    to: destination,
    label: 'Open passage',
    blocked: false,
    bidirectional: true,
  });
  context.turn.actions[0].text = 'Escape into the sheltered alley.';
  context.combatResult!.encounter.escaped = true;
  context.combatResult!.events = [
    {
      actorId: actor.id,
      phase: 'main',
      status: 'success',
      locationId: context.scene.location.id,
      fact: 'Katooluman escapes the fight.',
    },
  ];
  const accepted = compileSceneTurn(context, {
    version: 3,
    summary: 'Katooluman reaches the sheltered alley.',
    beats: [
      { kind: 'combat', at: 'current', text: 'Katooluman slips away from the Shadow Wight.' },
      {
        kind: 'move',
        actor: actor.id,
        to: destination,
        checked: true,
        fact: 'Katooluman reaches the sheltered alley through the open passage.',
        text: 'He reaches the sheltered alley.',
      },
    ],
  });
  expect(accepted.actions[0].components).toMatchObject({ main: { status: 'success', basis: 'engine' } });
  expect(accepted.actions[0].components.movement).toBeUndefined();
  expect(accepted.memberLocations).toContainEqual(
    expect.objectContaining({ memberId: actor.id, locationId: destination }),
  );
});

it('compiles the recorded stair descent without model-generated evidence or repairs', async () => {
  const context = fixture();
  const fetcher = vi.fn(async () => response(descent(context)));
  const gm = new ChatGPTGM(auth, 'owner', 'test', fetcher);
  const value = await gm.adjudicate(context, tools(context));
  const actor = context.members.find((member) => member.character.name === 'Moryan')!;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(value.actions.find((action) => action.memberId === actor.id)?.components.movement).toMatchObject({
    status: 'success',
    basis: 'routine',
  });
  expect(value.memberLocations).toContainEqual(
    expect.objectContaining({ memberId: actor.id, locationId: 'new:lower-chamber' }),
  );
  expect(value.arrivals).toHaveLength(1);
  expect(value.mapUpdates?.connections).toContainEqual(
    expect.objectContaining({ to: 'new:lower-chamber', blocked: false }),
  );
  expect(value.encounterRisks).toContainEqual(
    expect.objectContaining({ locationId: 'new:lower-chamber', danger: 'dangerous' }),
  );
  expect(value.npcUpdates).toContainEqual(expect.objectContaining({ npcId: 'iven' }));
});

it('preserves ordinary arrival when a destination investigation fails', () => {
  const context = fixture();
  const proposal = descent(context);
  const move = proposal.beats[0];
  if (move.kind !== 'move') throw new Error('fixture');
  context.turn.actions.find((action) => action.memberId === move.actor)!.text =
    'Go downstairs and inspect the pulse source.';
  context.turn.rolls.push({
    id: 'saved-check',
    memberId: move.actor,
    stat: 'WIS',
    dc: 10,
    mode: 'normal',
    dice: [2],
    modifier: 0,
    total: 2,
    success: false,
    reason: 'The machinery is obscured by the shaft.',
    lethal: false,
    source: 'test',
  });
  proposal.beats.splice(1, 0, {
    kind: 'act',
    actor: move.actor,
    slot: 'main',
    intent: 'search',
    fact: 'Moryan cannot identify the machinery through the shaft.',
    text: 'The shaft conceals the source, but an exposed maintenance lever is within reach.',
    finding: {
      source: 'lower-chamber:machinery',
      fact: 'An exposed maintenance lever beside the shaft can stop the moving floor panels.',
    },
  });
  const value = compileSceneTurn(context, proposal);
  expect(value.actions.find((action) => action.memberId === move.actor)).toMatchObject({
    status: 'partial',
    components: { movement: { status: 'success' }, main: { status: 'failure', basis: 'check' } },
  });
  expect(value.memberLocations?.find((position) => position.memberId === move.actor)?.locationId).toBe(
    'new:lower-chamber',
  );
  expect(value.events[0].phase).toBe('movement');
  expect(context.turn.rolls[0].dice).toEqual([2]);
});

it.each([true, false])(
  'repairs the recorded wreck arrival/search together in one correction, preserving success=%s',
  async (success) => {
    const context = wreckContext();
    const receipts = context.receipts!;
    const check = context.turn.rolls[0];
    if (!success) {
      Object.assign(check, { success: false, dice: [2, 9], total: 3 });
      delete receipts.loot;
      receipts.executionEvents = (receipts.executionEvents as { id: string }[]).filter(
        (event) => event.id !== 'loot',
      );
    }
    const before = structuredClone({ turn: context.turn, receipts: context.receipts, scene: context.scene });
    context.requestBudget = { used: 0, limit: 2 };
    const corrected = correctedWreck(success);
    const gameTools = tools(context);
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const wire = JSON.parse(init!.body as string);
      const input = JSON.parse(wire.input[0].content);
      expect(input.savedLoot?.item.id).toBe(success ? wreckSearch.receipts.loot.item.id : undefined);
      expect(wire.instructions).toContain('need TWO operations');
      expect(wire.instructions).toContain('deadEnd:string');
      if (fetcher.mock.calls.length === 1) return response(wreckSearch.response);
      const feedback = wire.input.filter((item: { role?: string }) => item.role === 'user').at(-1).content;
      expect(feedback).toContain('Lobsterano (actor:2) is missing its main act');
      expect(feedback).toContain(`saved WIS check (${success ? 'success' : 'failure'}`);
      expect(feedback).toContain('Wreck Interior (place:7)');
      expect(feedback).toContain('place.deadEnd');
      expect(feedback).toContain('changing fact/text alone');
      return response(corrected);
    });
    const value = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, gameTools);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(gameTools).not.toHaveBeenCalled();
    expect(gameTools.offerLoot).not.toHaveBeenCalled();
    expect(value.actions.find((action) => action.memberId === check.memberId)).toMatchObject({
      status: success ? 'success' : 'partial',
      components: {
        main: { basis: 'check', status: success ? 'success' : 'failure', receiptRefs: [`roll:${check.id}`] },
        movement: { basis: 'routine', status: 'success', receiptRefs: [] },
      },
    });
    expect(value.memberLocations).toContainEqual(
      expect.objectContaining({ memberId: check.memberId, locationId: wreckSearch.receipts.loot.locationId }),
    );
    expect(value.pickups).toEqual([]);
    expect({ turn: context.turn, receipts: context.receipts, scene: context.scene }).toEqual(before);
  },
);

it('restarts the recorded failed wreck checkpoint and publishes one tool case with the original check', async () => {
  const db = openDatabase(':memory:');
  try {
    const context = wreckContext();
    const fetcher = vi.fn(async () =>
      response(fetcher.mock.calls.length === 1 ? wreckSearch.response : correctedWreck()),
    );
    const gm = new ChatGPTGM(auth, 'owner', 'test', fetcher);
    const provider: GameMaster = {
      sceneTurns: true,
      adjudicate: gm.adjudicate.bind(gm),
      narrate: new PracticeGM().narrate,
    };
    const draw = vi.fn((sides: number) => sides);
    let game = new Game(db, () => provider, draw);
    const host = game.identify();
    const campaign = game.create(host.id, context.config);
    for (const member of context.members) {
      const player = game.identify();
      const character = game.saveCharacter(player.id, member.character);
      game.join(campaign.inviteCode!, player.id, character.id);
      db.prepare('UPDATE members SET id=?,state=? WHERE campaign_id=? AND player_id=?').run(
        member.id, JSON.stringify(member.state), campaign.id, player.id,
      );
    }
    context.members = game.members(campaign.id);
    context.startingMembers = structuredClone(context.members);
    const draft = {
      context, members: context.members, startingMembers: context.startingMembers,
      scene: context.scene, gmMemory: context.gmMemory, receipts: context.receipts, pipelineVersion: 1,
    };
    db.prepare("UPDATE campaigns SET status='active',scene=? WHERE id=?").run(
      JSON.stringify(context.scene), campaign.id,
    );
    db.prepare('INSERT INTO turns(id,campaign_id,number,phase,roster,draft) VALUES(?,?,?,?,?,?)').run(
      context.turn.id, campaign.id, 7, 'failed', JSON.stringify(context.turn.roster), JSON.stringify(draft),
    );
    for (const action of context.turn.actions)
      db.prepare('INSERT INTO actions(turn_id,member_id,text,passed) VALUES(?,?,?,0)').run(
        context.turn.id, action.memberId, action.text,
      );
    const check = context.turn.rolls[0];
    db.prepare('INSERT INTO rolls VALUES(?,?,?,?,?)').run(
      check.id, context.turn.id, check.memberId, '{}', JSON.stringify(check),
    );
    game = new Game(db, () => provider, draw);
    game.retry(campaign.id, host.id);
    await game.idle();
    const snapshot = game.snapshot(campaign.id, host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.turn?.number).toBe(8);
    expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toEqual([check]);
    expect(draw.mock.calls.filter(([sides]) => sides === 20)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const place = memberScene(snapshot.scene, check.memberId);
    expect(place.location.id).toBe(wreckSearch.receipts.loot.locationId);
    expect(place.loot.filter((item) => item.name === wreckSearch.receipts.loot.item.name)).toEqual([
      expect.objectContaining({ id: wreckSearch.receipts.loot.item.id }),
    ]);
    expect(snapshot.members.flatMap((member) => member.state.inventory).some(
      (item) => item.id === wreckSearch.receipts.loot.item.id,
    )).toBe(false);
  } finally {
    db.close();
  }
});

it('rejects teleportation, blocked routes and actions for passing players', () => {
  const context = fixture();
  const value = descent(context);
  const move = value.beats[0];
  if (move.kind !== 'move') throw new Error('fixture');
  const origin = memberScene(context.scene, move.actor).location.id!;
  const edge = context.scene.worldMap!.connections.find(
    (edge) => edge.from === origin || edge.to === origin,
  )!;
  move.to = edge.from === origin ? edge.to : edge.from;
  edge.blocked = true;
  expect(() => compileSceneTurn(context, value)).toThrow(/route/);
  move.to = 'new:lower-chamber';
  context.turn.actions.find((action) => action.memberId === move.actor)!.passed = true;
  expect(() => compileSceneTurn(context, value)).toThrow(/nonpassing/);
});

it('keeps repeated malformed scenes retryable without inventing a fictional refusal', async () => {
  const context = fixture();
  context.requestBudget = { used: 0, limit: 3 };
  const fetcher = vi.fn(async () => response({ version: 3, beats: [], summary: 'Incomplete' }));
  const result = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(result.actions.every((action) => action.components.main?.processingFailure)).toBe(true);
  expect(result.events.filter((event) => event.id.startsWith('fallback:observation:'))).toHaveLength(context.turn.actions.length);
  expect(result.changes).toEqual([]);
  expect(result.memberLocations).toEqual([]);
  expect(result.rewards).toMatchObject({ xp: 0, currency: 0 });
  expect(context.requestBudget.fallback).toContain('without further correction');
});

it.each([false, true])('preserves independently valid travel when recovery stops (tool cap=%s)', async (toolCap) => {
  const context = fixture();
  context.requestBudget = { used: 0, limit: 8 };
  const incomplete = descent(context);
  const move = incomplete.beats[0];
  if (move.kind !== 'move') throw new Error('Expected move.');
  incomplete.beats = [move];
  const fetcher = vi.fn(async () => {
    if (toolCap && fetcher.mock.calls.length === 2)
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
        output: Array.from({ length: 21 }, (_, index) => ({ type: 'function_call', name: 'unknown_tool',
          call_id: `invalid-${index}`, arguments: '{}' })),
      } })}\n\n`);
    return response(incomplete);
  });
  const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
  expect(fetcher).toHaveBeenCalledTimes(toolCap ? 3 : 2);
  expect(accepted.memberLocations).toContainEqual(expect.objectContaining({ memberId: move.actor, locationId: move.to }));
  expect(accepted.actions.some((action) => action.memberId !== move.actor && action.components.main?.processingFailure)).toBe(true);
  expect(accepted.events.filter((event) => event.id === `fallback:observation:${move.actor}`)).toEqual([]);
});

it('ends repeated tool-only rounds without replaying a saved check or waiting for the request limit', async () => {
  const context = fixture();
  context.requestBudget = { used: 0, limit: 8 };
  context.turn.actions.forEach((action) => { action.text = 'Inspect the wall.'; });
  const saved = { id: 'fallback-check', memberId: context.members[0].id, stat: 'WIS' as const,
    dc: 10 as const, mode: 'normal' as const, dice: [1], modifier: 0, total: 1,
    success: false, reason: 'The wall markings are worn.', lethal: false, source: 'test' };
  context.turn.rolls.push(saved);
  const gameTools = tools(context);
  vi.mocked(gameTools).mockReturnValue(saved);
  const fetcher = vi.fn(async () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
    output: [{ type: 'function_call', name: 'roll_check', call_id: `repeat-${fetcher.mock.calls.length}`,
      arguments: JSON.stringify({ memberId: saved.memberId, stat: saved.stat, dc: saved.dc, mode: saved.mode, reason: saved.reason }) }],
  } })}\n\n`));
  const value = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, gameTools);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(gameTools).toHaveBeenCalledTimes(1);
  expect(context.turn.rolls).toEqual([saved]);
  expect(value.actions[0].components.main?.status).toBe('failure');
  expect(value.events.some((event) => event.id.startsWith('fallback:observation:'))).toBe(true);
});

it('preserves independent scene progress when the provider disconnects during repair', async () => {
  const context = fixture();
  context.requestBudget = { used: 0, limit: 8 };
  const incomplete = descent(context);
  const move = incomplete.beats[0];
  if (move.kind !== 'move') throw new Error('Expected move.');
  incomplete.beats = [move];
  const gameTools = tools(context);
  gameTools.checkpointAdjudication = vi.fn();
  const fetcher = vi.fn(async () => {
    if (fetcher.mock.calls.length === 1) return response(incomplete);
    throw new TypeError('Connection lost during scene repair.');
  });
  const result = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, gameTools);
  expect(gameTools.checkpointAdjudication).toHaveBeenCalledTimes(1);
  expect(result.memberLocations).toContainEqual(expect.objectContaining({ memberId: move.actor, locationId: move.to }));
  expect(result.actions.some((action) => action.memberId !== move.actor && action.components.main?.processingFailure)).toBe(true);
});

it.each([true, false])('recovers at the twenty-tool cap without running the extra resource call (scene=%s)', async (sceneProtocol) => {
  const context = fixture();
  context.sceneProtocol = sceneProtocol;
  context.requestBudget = { used: 0, limit: 8 };
  const actor = context.members[0];
  const potion = { ...baseItem('unspent-gel', 'Rescue Gel', 'consumable'), healing: 6, quantity: 1 };
  actor.state.inventory.push(potion);
  context.turn.actions.forEach((action) => { action.text = 'Inspect the wall.'; });
  const saved = { id: randomUUID(), memberId: actor.id, stat: 'WIS' as const, dc: 10 as const,
    mode: 'normal' as const, dice: [2], modifier: 0, total: 2, success: false,
    reason: 'The wall markings are worn.', lethal: false, source: 'test' };
  const gameTools = tools(context);
  vi.mocked(gameTools).mockImplementation(() => {
    if (!context.turn.rolls.length) context.turn.rolls.push(saved);
    return saved;
  });
  gameTools.useResource = vi.fn();
  const calls = Array.from({ length: 20 }, (_, index) => ({
    type: 'function_call', name: 'roll_check', call_id: `check-${index}`,
    arguments: JSON.stringify({ memberId: actor.id, stat: 'WIS', dc: 10, mode: 'normal', reason: `Inspect marking ${index}.` }),
  }));
  calls.push({ type: 'function_call', name: 'use_resource', call_id: 'must-not-spend',
    arguments: JSON.stringify({ memberId: actor.id, itemId: potion.id, abilityName: null, targetId: null }) });
  const fetcher = vi.fn(async () => new Response(`data: ${JSON.stringify({ type: 'response.completed',
    response: { output: calls } })}\n\n`));
  const value = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, gameTools);
  expect(fetcher).toHaveBeenCalledTimes(sceneProtocol ? 2 : 1);
  expect(gameTools).toHaveBeenCalledTimes(20);
  expect(gameTools.useResource).not.toHaveBeenCalled();
  expect(context.turn.rolls).toEqual([saved]);
  expect(actor.state.inventory).toContainEqual(potion);
  expect(value.actions.find((action) => action.memberId === actor.id)?.components.main)
    .toMatchObject({ status: 'failure', basis: 'check' });
  expect(value.actions.filter((action) => action.memberId !== actor.id).every((action) => action.components.main?.processingFailure)).toBe(true);
  expect(value.rewards).toMatchObject({ xp: 0, currency: 0 });
  expect(context.requestBudget.fallback).toContain('twenty-tool limit');
});

it.each([true, false])('recovers when the engine exhausts the shared budget before the provider cap (scene=%s)', async (sceneProtocol) => {
  const context = fixture();
  context.sceneProtocol = sceneProtocol;
  context.requestBudget = { used: 0, limit: 8 };
  context.turn.actions.forEach((action) => { action.text = 'Inspect the wall.'; });
  const gameTools = tools(context);
  vi.mocked(gameTools).mockImplementation(() => { throw new ToolBudgetError(); });
  const fetcher = vi.fn(async () => toolResponse('roll_check', { memberId: context.members[0].id,
    stat: 'WIS', dc: 10, mode: 'normal', reason: 'Inspect the wall.' }));
  const value = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, gameTools);
  expect(fetcher).toHaveBeenCalledTimes(sceneProtocol ? 2 : 1);
  expect(gameTools).toHaveBeenCalledTimes(1);
  expect(context.turn.rolls).toEqual([]);
  expect(value.actions.every((action) => action.components.main?.processingFailure)).toBe(true);
  expect(context.requestBudget.fallback).toContain('twenty-tool limit');
});

it('recovers a compatibility turn at the tool cap without consuming a saved item twice', async () => {
  const context = fixture();
  context.requestBudget = { used: 0, limit: 8 };
  const [healer, reader] = context.members;
  const potion = { ...baseItem('saved-gel', 'Rescue Gel', 'consumable'), healing: 6, quantity: 1 };
  healer.state.hp = 10;
  healer.state.inventory.push(potion);
  context.turn.actions.find((action) => action.memberId === healer.id)!.text = 'Drink Rescue Gel.';
  context.turn.actions.find((action) => action.memberId === reader.id)!.text = 'Inspect the wall.';
  const saved = { id: randomUUID(), memberId: reader.id, stat: 'WIS' as const, dc: 10 as const,
    mode: 'normal' as const, dice: [2], modifier: 0, total: 2, success: false,
    reason: 'The wall markings are worn.', lethal: false, source: 'test' };
  const gameTools = tools(context);
  vi.mocked(gameTools).mockReturnValue(saved);
  gameTools.useResource = vi.fn(() => {
    healer.state.hp = 16;
    healer.state.inventory = healer.state.inventory.filter((item) => item.id !== potion.id);
    return { memberId: healer.id, itemId: potion.id, abilityName: null, targetId: healer.id,
      sourceName: potion.name, restored: 6, state: structuredClone(healer.state), targetState: structuredClone(healer.state) };
  });
  gameTools.validateResolution = vi.fn();
  const use = { type: 'function_call', name: 'use_resource', call_id: 'heal',
    arguments: JSON.stringify({ memberId: healer.id, itemId: potion.id, abilityName: null, targetId: null }) };
  const calls = [use, ...Array.from({ length: 19 }, (_, index) => ({
    type: 'function_call', name: 'roll_check', call_id: `check-${index}`,
    arguments: JSON.stringify({ memberId: reader.id, stat: 'WIS', dc: 10, mode: 'normal', reason: `Inspect marking ${index}.` }),
  })), { ...use, call_id: 'must-not-heal-twice' }];
  const fetcher = vi.fn(async () => new Response(`data: ${JSON.stringify({ type: 'response.completed',
    response: { output: calls } })}\n\n`));
  const value = await new ChatGPTGM(auth, 'owner', 'test', fetcher).resolve(context, gameTools);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(gameTools).toHaveBeenCalledTimes(19);
  expect(gameTools.useResource).toHaveBeenCalledTimes(1);
  expect(gameTools.validateResolution).toHaveBeenCalledWith(value);
  expect(healer.state.hp).toBe(16);
  expect(healer.state.inventory.some((item) => item.id === potion.id)).toBe(false);
  expect(value.narration).toContain('Rescue Gel');
  expect(value.narration).toContain('fails');
  expect(value).toMatchObject({ xp: 0, currency: 0 });
});

it('keeps an oversized scene retryable without spending more model requests', async () => {
  const context = fixture();
  context.requestBudget = { used: 0, limit: 8 };
  const fetcher = vi.fn(async () => response({ padding: 'x'.repeat(2_000_001) }));
  const value = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(value.actions.every((action) => action.components.main?.processingFailure)).toBe(true);
  expect(value.events.some((event) => event.id.startsWith('fallback:observation:'))).toBe(true);
  expect(context.requestBudget.fallback).toContain('Scene recovery');
});

it('repairs invalid NPC status once and derives a feature introduction from its typed declaration', async () => {
  const context = fixture();
  context.requestBudget = { used: 0, limit: 3 };
  const scene = descent(context);
  const move = scene.beats[0];
  const conversation = scene.beats[1];
  if (move.kind !== 'move' || conversation.kind !== 'act') throw new Error('fixture');
  move.fact += ' A telephone hangs beside the door.';
  move.features = [{
    featureId: 'new:internal-telephone', name: 'Internal ship telephone',
    properties: { working: true },
  }];
  conversation.npcs![0].status = 'alive';
  const invalidStatus = structuredClone(scene);
  const invalidConversation = invalidStatus.beats[1];
  if (invalidConversation.kind !== 'act') throw new Error('fixture');
  Object.assign(invalidConversation.npcs![0], { status: 'Alive; explains the levy.' });
  const corrected = structuredClone(scene);
  const correctedMove = corrected.beats[0];
  if (correctedMove.kind !== 'move') throw new Error('fixture');
  correctedMove.features![0].aliases = ['telephone'];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    expect(body.instructions).toContain('status?:"alive"|"withdrawn"|"surrendered"|"dead"');
    expect(body.instructions).toContain('Put NPC role, activity and other descriptive details in fact/text');
    const call = fetcher.mock.calls.length;
    if (call === 1) return response(invalidStatus);
    const feedback = body.input.at(-1).content;
    if (call === 2) {
      expect(feedback).toContain('invalid_enum_value');
      return response(scene);
    }
    expect(feedback).toContain('new:internal-telephone');
    expect(feedback).toContain('Internal ship telephone');
    expect(feedback).toContain('exact name or an accurate declared alias');
    expect(feedback).not.toContain('at an observed place');
    return response(corrected);
  });
  const gameTools = tools(context);
  const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, gameTools);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(gameTools).not.toHaveBeenCalled();
  expect(accepted.npcUpdates).toContainEqual(expect.objectContaining({ npcId: 'iven', status: 'alive' }));
  expect(accepted.featureUpdates).toContainEqual(expect.objectContaining({
    featureId: 'new:internal-telephone', properties: { working: true },
  }));
  const introduced = accepted.featureUpdates!.find((feature) => feature.featureId === 'new:internal-telephone')!;
  expect(accepted.events.find((event) => event.id === introduced.eventId)?.fact).toContain('Internal ship telephone');
});

it('keeps recent complete NPC facts within the existing journal limit across scenes', () => {
  const context = fixture();
  const oldest = `Iven remembers the old levy. ${'x'.repeat(850)}`;
  const retained = `Iven names the current collector. ${'y'.repeat(350)}`;
  context.journal.push({ kind: 'npc', name: 'Iven', detail: `${oldest}\n${retained}` });
  for (let turn = 0; turn < 20; turn++) {
    const scene = descent(context);
    const exchange = scene.beats.find((beat) => beat.kind === 'act');
    if (!exchange || exchange.kind !== 'act') throw new Error('fixture');
    exchange.fact = `Iven reports levy development ${turn}. ${'z'.repeat(300)}`;
    const accepted = compileSceneTurn(context, scene);
    const entry = accepted.journal.find((entry) => entry.name === 'Iven')!;
    expect(entry.detail.length).toBeLessThanOrEqual(1500);
    expect(entry.detail).toContain(exchange.fact);
    if (turn === 0) {
      expect(entry.detail).not.toContain(oldest);
      expect(entry.detail).toContain(retained);
    }
    expect(accepted.events).toContainEqual(expect.objectContaining({ fact: exchange.fact }));
    context.journal = accepted.journal;
  }
});

it('bounds repair context to the latest rejected scene and paired tool round, preserving saved rolls', async () => {
  const context = fixture();
  const complete = descent(context);
  const move = complete.beats[0];
  if (move.kind !== 'move') throw new Error('fixture');
  context.turn.actions.find((action) => action.memberId === move.actor)!.text =
    'Go downstairs and inspect the pulse source.';
  const saved = {
    id: 'saved-check',
    memberId: move.actor,
    stat: 'WIS' as const,
    dc: 10 as const,
    mode: 'normal' as const,
    dice: [2],
    modifier: 0,
    total: 2,
    success: false,
    reason: 'The machinery is obscured by the shaft.',
    lethal: false,
    source: 'test',
  };
  context.turn.rolls.push(saved);
  complete.beats.splice(1, 0, {
    kind: 'act',
    actor: move.actor,
    slot: 'main',
    intent: 'search',
    fact: 'Moryan cannot identify the machinery through the shaft.',
    text: 'The shaft conceals the source, but an exposed maintenance lever is within reach.',
    finding: { source: 'lower-chamber:machinery', fact: 'An exposed maintenance lever is within reach.' },
  });
  const missingFinding = structuredClone(complete);
  const search = missingFinding.beats[1];
  if (search.kind !== 'act') throw new Error('fixture');
  delete search.finding;
  const missingPlace = structuredClone(complete);
  const arrival = missingPlace.beats[0];
  if (arrival.kind !== 'move') throw new Error('fixture');
  delete arrival.place;
  const gameTools = tools(context);
  vi.mocked(gameTools).mockReturnValue(saved);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const call = fetcher.mock.calls.length;
    const input = JSON.parse(init!.body as string).input.slice(1);
    const compact = (scene: SceneTurn) => ({ ...scene, beats: scene.beats.map(({ text: _text, ...beat }: Record<string, unknown>, index) => ({ index, ...beat })) });
    const scenes = input.flatMap((item: { role?: string; content?: unknown }) =>
      item.role === 'assistant' && typeof item.content === 'string' ? [JSON.parse(item.content)] : [],
    );
    const feedback = input
      .filter((item: { role?: string }) => item.role === 'user')
      .map((item: { content: string }) => item.content)
      .join(' ');
    if (call > 1 && call <= 4) {
      expect(scenes).toContainEqual(compact(missingFinding));
      expect(feedback).toContain('An investigation needs');
    }
    if (call === 3 || call === 4) {
      const previous = call - 1;
      expect(input).toContainEqual(
        expect.objectContaining({ type: 'function_call', call_id: `saved-${previous}` }),
      );
      expect(input).toContainEqual(
        expect.objectContaining({
          type: 'function_call_output',
          call_id: `saved-${previous}`,
          output: JSON.stringify({ ...saved, memberId: actorAlias(context, saved.memberId) }),
        }),
      );
    }
    if (call >= 4) expect(input).not.toContainEqual(expect.objectContaining({ call_id: 'saved-2' }));
    if (call === 1) return response(missingFinding);
    if (call === 2 || call === 3)
      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'function_call',
                namespace: 'game',
                name: 'roll_check',
                call_id: `saved-${call}`,
                arguments: JSON.stringify({
                  memberId: move.actor,
                  stat: saved.stat,
                  dc: saved.dc,
                  mode: saved.mode,
                  reason: saved.reason,
                }),
              },
            ],
          },
        })}\n\n`,
      );
    if (call === 4) return response(missingPlace);
    expect(scenes).toHaveLength(1);
    expect(scenes).not.toContainEqual(compact(missingFinding));
    expect(scenes).toContainEqual(compact(missingPlace));
    expect(feedback).toContain('move.place');
    return response(complete);
  });
  const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, gameTools);
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(gameTools).toHaveBeenCalledTimes(1);
  expect(context.turn.rolls).toEqual([saved]);
  expect(accepted.actions.find((action) => action.memberId === move.actor)?.components).toMatchObject({
    movement: { status: 'success' },
    main: { status: 'failure', basis: 'check' },
  });
  expect(accepted.memberLocations).toContainEqual(
    expect.objectContaining({ memberId: move.actor, locationId: move.to }),
  );
});

it('preserves a prepared cause and supplies due activities without exposing notes in prose', async () => {
  const context = fixture();
  const at = memberScene(context.scene, context.members[0].id).location.id!;
  context.gmMemory = [
    {
      id: 'pulses',
      locationId: at,
      cause: 'PRIVATE: a worn governor drives a buried engine.',
      discoveries: ['The governor can be disengaged.'],
      actors: 'A keeper wants the engine running.',
      nextChange: 'The keeper returns to service it.',
      dueTurn: 6,
      status: 'open',
    },
  ];
  expect(() =>
    updateGMMemory(context.gmMemory!, [{ ...context.gmMemory![0], cause: 'A different mystery.' }]),
  ).toThrow(/cause/);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const input = JSON.parse(JSON.parse(init!.body as string).input[0].content);
    expect(input.dueActivities).toEqual(context.gmMemory!.map((note) => ({
      ...note, locationId: locationAlias(context, note.locationId),
    })));
    return response(descent(context));
  });
  const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
  expect(JSON.stringify(accepted.sceneDraft)).not.toContain('PRIVATE');
  expect(gmMemorySchema.parse(context.gmMemory)).toHaveLength(1);
});

it('publishes one creative response and persists private preparation atomically in the game', async () => {
  const db = openDatabase(':memory:');
  const practice = new PracticeGM();
  let current: GMContext;
  const fetcher = vi.fn(async () => {
    const actor = current.members[0];
    return response({
      version: 3,
      summary: 'The keeper answers.',
      notes: [
        {
          id: 'engine',
          locationId: current.scene.location.id!,
          cause: 'PRIVATE governor failure.',
          discoveries: ['An accessible lever disengages it.'],
          actors: 'The keeper repairs it.',
          nextChange: 'The keeper inspects the governor.',
          dueTurn: current.turn.number + 1,
          status: 'open',
        },
      ],
      beats: [
        {
          kind: 'meet',
          actor: actor.id,
          person: { npcId: 'workshop-keeper', name: 'The keeper' },
          fact: 'The keeper explains the accessible lever.',
          text: '“That lever disengages the governor,” the keeper says.',
        },
      ],
    });
  });
  const gm = new ChatGPTGM(auth, 'owner', 'test', fetcher);
  const narrate = vi.fn(practice.narrate.bind(practice));
  const provider: GameMaster = {
    sceneTurns: true,
    adjudicate: async (context, gameTools) => {
      if (!context.turn.number) return practice.adjudicate(context, gameTools);
      current = context;
      return gm.adjudicate(context, gameTools);
    },
    narrate,
  };
  const game = new Game(
    db,
    () => provider,
    () => 4,
  );
  try {
    const host = game.identify();
    const campaign = game.create(host.id, fixture().config);
    const character = game.saveCharacter(host.id, templateCharacter('Moryan'));
    game.join(campaign.inviteCode!, host.id, character.id);
    const member = game.members(campaign.id)[0];
    game.manageCharacter(campaign.id, host.id, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 3).map((item) => item.id),
    });
    game.start(campaign.id, host.id);
    await game.idle();
    const state = ensureLocations(initialScene('Workshop'), [member.id]);
    state.encounterRisk = { danger: 'safe', reason: 'The keeper controls the disconnected workshop.' };
    db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(state), campaign.id);
    narrate.mockClear();
    game.submit(
      campaign.id,
      host.id,
      game.pending(campaign.id)!.id,
      'Ask the keeper about the engine.',
      false,
    );
    await game.idle();
    const snapshot = game.snapshot(campaign.id, host.id);
    expect(snapshot.history.at(-1)?.result?.narration).toContain('That lever disengages');
    expect(snapshot.turn?.phase).toBe('collecting');
    expect(snapshot.scene.npcs?.['workshop-keeper']).toMatchObject({
      name: 'The keeper', locationId: memberScene(snapshot.scene, member.id).location.id,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(narrate).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
    expect(JSON.parse(game.campaign(campaign.id).gm_memory)[0].cause).toBe('PRIVATE governor failure.');
    expect(game.export(campaign.id, host.id).gmMemory[0].cause).toBe('PRIVATE governor failure.');
  } finally {
    db.close();
  }
});

async function table(build: (context: GMContext, call: number) => unknown, saved = {
  scene: tower.scene as Scene, members: tower.members, journal: tower.journal,
}) {
  const db = openDatabase(':memory:');
  const practice = new PracticeGM();
  let current: GMContext;
  const fetcher = vi.fn(async (_url?: unknown, init?: RequestInit) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).input[0].content);
    if (data.candidate && data.resolution)
      return response({ storyApproved: true, summaryApproved: true, closingApproved: true, feedback: '' });
    const built = build(current, fetcher.mock.calls.length);
    return built instanceof Response ? built : response(built);
  });
  const gm = new ChatGPTGM(auth, 'owner', 'test', fetcher);
  const narrate = vi.fn(practice.narrate.bind(practice));
  const provider: GameMaster = {
    sceneTurns: true,
    adjudicate: async (context, tools) => {
      if (!context.turn.number) return practice.adjudicate(context, tools);
      current = context;
      return gm.adjudicate(context, tools);
    },
    narrate,
    reviewSceneNarration: vi.fn(gm.reviewSceneNarration.bind(gm)),
  };
  const draw = vi.fn((sides: number) => Math.min(4, sides));
  const game = new Game(db, () => provider, draw);
  const host = game.identify();
  const campaign = game.create(host.id, fixture().config);
  const players = saved.members.map(() => game.identify());
  for (const [index, player] of players.entries()) {
    const character = game.saveCharacter(player.id, templateCharacter(saved.members[index].name));
    game.join(campaign.inviteCode!, player.id, character.id);
    const member = game.members(campaign.id).find((member) => member.playerId === player.id)!;
    game.manageCharacter(campaign.id, player.id, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 3).map((item) => item.id),
    });
  }
  game.start(campaign.id, host.id);
  await game.idle();
  const members = game.members(campaign.id);
  const mapping = new Map(
    saved.members.map((entry) => [
      entry.id,
      members.find((member) => member.character.name === entry.name)!.id,
    ]),
  );
  const scene = JSON.parse(
    JSON.stringify(saved.scene, (_key, value) =>
      typeof value === 'string' ? (mapping.get(value) ?? value) : value,
    ),
  );
  scene.memberLocations = Object.fromEntries(
    Object.entries(saved.scene.memberLocations!).map(([id, at]) => [mapping.get(id), at]),
  );
  db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), campaign.id);
  db.prepare('UPDATE turns SET number=6 WHERE id=?').run(game.pending(campaign.id)!.id);
  for (const entry of saved.journal)
    db.prepare(
      'INSERT INTO journal(campaign_id,kind,name,detail) VALUES(?,?,?,?) ON CONFLICT(campaign_id,kind,name) DO UPDATE SET detail=excluded.detail',
    ).run(campaign.id, entry.kind, entry.name, entry.detail);
  narrate.mockClear();
  draw.mockClear();
  const submit = (actions?: Record<string, string>) => {
    const turn = game.pending(campaign.id)!;
    for (const player of players) {
      const member = members.find((member) => member.playerId === player.id)!;
      const text =
        actions?.[member.character.name] ??
        saved.members.find((entry) => entry.name === member.character.name)!.action;
      game.submit(campaign.id, player.id, turn.id, text, !text.trim());
    }
    return turn.id;
  };
  return { db, game, host, campaign, players, members, fetcher, narrate, draw, provider, submit };
}

function investigate(context: GMContext, check = true): Investigation {
  const actor = context.members.find((member) => member.character.name === 'Moryan')!;
  const at = memberScene(context.scene, actor.id).location.id!;
  return {
    memberId: actor.id,
    source: {
      kind: 'feature',
      id: 'new:registration-notice',
      name: 'Registration notice',
      description: 'A posted registration notice bears a faded list of residents.',
      locationId: at,
    },
    question: 'What names are on the registration notice?',
    preparation: context.gmMemory?.some((note) => note.id === 'registration')
      ? { id: 'registration' }
      : {
          id: 'registration',
          locationId: at,
          cause: 'PRIVATE: The collector forged the registration.',
          discoveries: ['The notice names Sella Venn and Iven Marr.'],
          actors: 'The collector hides the original ledger.',
          nextChange: 'The clerk checks the posted copy.',
          dueTurn: 8,
          status: 'open',
        },
    answer: 0,
    success: {
      text: 'The faded names resolve clearly: Sella Venn and Iven Marr. The clerk’s counter in this ward holds the original ledger.',
      lead: { fact: 'The clerk’s counter in this ward holds the original ledger.', locationId: at },
    },
    failure: {
      fact: 'The faded names resist deciphering, but the clerk’s seal is clear.',
      text: 'The ink runs together. The clerk’s seal remains legible. The clerk’s counter in this ward has an intact original ledger.',
      lead: { fact: 'The clerk’s counter in this ward has an intact original ledger.', locationId: at },
    },
    check: check
      ? {
          stat: 'INT',
          dc: 10,
          mode: 'normal',
          circumstances: { favorable: false, adverse: false },
          reason: 'Moryan deciphers the faded registration notice.',
          lethal: false,
          abilityName: null,
          assistsMemberId: null,
          assistedBy: [],
        }
      : null,
  };
}
function toolResponse(name: string, args: unknown) {
  return new Response(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [
          {
            type: 'function_call',
            namespace: 'game',
            name,
            call_id: randomUUID(),
            arguments: JSON.stringify(args),
          },
        ],
      },
    })}\n\n`,
  );
}

it.each(['missing', 'empty', 'repair'])('publishes a place investigation and conversation with their original intent bindings (annotations=%s)', async (annotation) => {
  const f = await table((context, call) => {
    const actor = context.members.find((member) => member.character.name === 'Moryan')!;
    const intents = submittedActionObligations(context, actor.id);
    const at = memberScene(context.scene, actor.id).location.id!;
    if (call === 1) {
      const request = investigate(context, false);
      request.intentId = intents.find((intent) => intent.kind === 'inspect')!.id;
      request.source = { kind: 'place', id: at, locationId: at };
      request.question = 'Where do the old trolley grooves lead?';
      request.preparation = { id: 'grooves', locationId: at, cause: 'Old trolleys used the workshop.',
        discoveries: ['Old trolley grooves converge at the workshop wall.'], actors: 'The workshop crew.',
        nextChange: 'The grooves remain visible.', dueTurn: null, status: 'open' };
      request.success = { text: 'Old trolley grooves converge at the wall.',
        lead: { fact: 'The grooves can be followed to the wall.', locationId: at } };
      return toolResponse('investigate', request);
    }
    return { version: 3, summary: 'Moryan notices the old grooves and speaks briefly with Iven.', beats: [
      { kind: 'investigate', actor: actor.id, ...(annotation === 'empty' ? { resolves: [] } : annotation === 'repair' && call === 2 ? { resolves: [{
        id: intents.find((intent) => intent.kind === 'talk')!.id, outcome: 'resolved',
        fact: 'The finding is wrongly assigned to the conversation.',
      }] } : {}) },
      { kind: 'act', actor: actor.id, slot: 'minor', fact: 'Iven tells Moryan that he is waiting here.',
        text: '“I am waiting here,” Iven tells Moryan.', npcs: [{ npcId: 'iven', name: 'Iven' }],
        resolves: [{ id: intents.find((intent) => intent.kind === 'talk')!.id, outcome: 'resolved',
          fact: 'Iven tells Moryan that he is waiting here.' }] },
    ] };
  });
  try {
    f.submit(Object.fromEntries(f.members.map((member) => [member.character.name,
      member.character.name === 'Moryan' ? 'Inspect the surroundings, then talk to Iven.' : ''])));
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(f.fetcher).toHaveBeenCalledTimes(annotation === 'repair' ? 3 : 2);
    expect(snapshot.history.at(-1)?.rolls).toEqual([]);
    const turn = f.db.prepare('SELECT draft FROM turns WHERE campaign_id=? AND phase=\'complete\' ORDER BY number DESC LIMIT 1')
      .get(f.campaign.id) as { draft: string };
    const draft = JSON.parse(turn.draft);
    const finding = Object.entries(draft.receipts).find(([key]) => key.startsWith('investigation:'))![1] as InvestigationResult;
    expect(finding.source.kind).toBe('place');
    expect(draft.adjudication.actionOutcomes).toContainEqual(expect.objectContaining({ obligationId: finding.intentId, outcome: 'resolved' }));
    if (annotation === 'repair') {
      const stage = f.db.prepare("SELECT payload FROM events WHERE turn_id=? AND kind='stage:adjudication'")
        .get(draft.context.turn.id) as { payload: string };
      expect(JSON.parse(stage.payload).corrections[0].feedback).toContain('saved investigation belongs to');
    }
  } finally { f.db.close(); }
});

it.each([false, true])(
  'handles available information and repeat requested abilities without unnecessary dice or charges (ability=%s)',
  async (ability) => {
    const f = await table((context, call) => {
      const request = investigate(context, ability);
      if (ability) request.check!.abilityName = 'Keen observation';
      return call % 2 === 1
        ? toolResponse('investigate', request)
        : {
            version: 3,
            summary: 'The names are known.',
            beats: [{ kind: 'investigate', actor: request.memberId }],
          };
    });
    try {
      f.draw.mockImplementation((sides) => (sides === 20 ? 14 : sides === 100 ? 100 : Math.min(4, sides)));
      const text = ability
        ? 'Use Keen observation to read the registration notice.'
        : 'Read the legible registration notice.';
      f.submit({ Moryan: text, Katooluman: '' });
      await f.game.idle();
      let snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      const actor = snapshot.members.find((member) => member.character.name === 'Moryan')!;
      expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(ability ? 1 : 0);
      expect(snapshot.history.at(-1)?.result?.xp).toBe(10);
      expect(
        snapshot.scene.worldProgression?.places[memberScene(snapshot.scene, actor.id).location.id!]
          ?.stalledTurns,
      ).toBe(0);
      expect(Object.values(actor.state.abilityUses ?? {}).reduce((sum, uses) => sum + uses, 0)).toBe(
        ability ? 1 : 0,
      );
      f.draw.mockClear();
      f.submit({ Moryan: text, Katooluman: '' });
      await f.game.idle();
      snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(0);
      expect(snapshot.members.find((member) => member.id === actor.id)?.state.abilityUses).toEqual(
        actor.state.abilityUses,
      );
      expect(snapshot.history.at(-1)?.result?.xp).toBe(0);
      expect(f.draw.mock.calls.filter(([sides]) => sides === 20 || sides === 100)).toHaveLength(0);
    } finally {
      f.db.close();
    }
  },
);

it('remembers earlier failed questions when another question is investigated at the same source', async () => {
  let attempt = 0;
  const f = await table((context, call) => {
    const request = investigate(context);
    if (call % 2 === 1) {
      attempt++;
      if (attempt === 2) {
        request.preparation = {
          id: 'registration',
          discoveries: [
            'The notice names Sella Venn and Iven Marr.',
            'The clerk signed the registration notice.',
          ],
        };
        request.answer = 1;
        request.question = 'Who signed the registration notice?';
      }
      return toolResponse('investigate', request);
    }
    return {
      version: 3,
      summary: 'The faded notice resists reading.',
      beats: [{ kind: 'investigate', actor: request.memberId }],
    };
  });
  try {
    f.draw.mockImplementation((sides) => (sides === 20 ? 1 : Math.min(4, sides)));
    for (const [index, text] of [
      'Decipher the names on the registration notice.',
      'Decipher who signed the registration notice.',
      'Try reading the names on the registration notice again.',
    ].entries()) {
      f.submit({ Moryan: text, Katooluman: '' });
      await f.game.idle();
      const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(
        index === 2 ? 0 : 1,
      );
      expect(snapshot.history.at(-1)?.result?.xp).toBe(0);
    }
  } finally {
    f.db.close();
  }
});

it('keeps a newly explored place’s failed investigation after temporary references become saved IDs', async () => {
  const f = await table((context, call) => {
    const request = investigate(context);
    const first = context.turn.number === 6;
    const move = descent(context).beats[0];
    if (move.kind !== 'move') throw new Error('Expected the recorded descent.');
    const at = first ? move.to : memberScene(context.scene, request.memberId).location.id!;
    request.source = { kind: 'place', id: at, locationId: at, name: move.place!.name };
    if (first) request.preparation.locationId = at;
    request.success.lead.locationId = at;
    request.failure.lead.locationId = at;
    if (call % 2 === 1) return toolResponse('investigate', request);
    return {
      version: 3,
      summary: 'Moryan examines the lower chamber.',
      beats: [...(first ? [move] : []), { kind: 'investigate', actor: request.memberId }],
    };
  });
  try {
    f.draw.mockImplementation((sides) => (sides === 20 ? 1 : Math.min(4, sides)));
    for (let index = 0; index < 2; index++) {
      f.submit({
        Moryan: index
          ? 'Search this chamber again for the registered names.'
          : 'Descend the stair and search the chamber for the registered names.',
        Katooluman: '',
      });
      await f.game.idle();
      const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      const actor = snapshot.members.find((member) => member.character.name === 'Moryan')!;
      const place = memberScene(snapshot.scene, actor.id);
      expect(place.searches?.[place.location.id!]?.investigation?.success).toBe(false);
      expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(index ? 0 : 1);
      expect(snapshot.history.at(-1)?.result?.xp).toBe(0);
    }
  } finally {
    f.db.close();
  }
});

it.each([true, false])(
  'commits prepared findings before dice and reuses unchanged evidence (success=%s)',
  async (success) => {
    let actorId = '';
    const f = await table((context, call) => {
      actorId = context.members.find((member) => member.character.name === 'Moryan')!.id;
      if (call % 2 === 1) return toolResponse('investigate', investigate(context));
      // Even an inconsistent post-roll description cannot discard the chosen finding.
      return {
        version: 3,
        summary: 'Nothing can be read.',
        rewards: { xp: 40, reason: 'Read the notice again.' },
        beats: [
          {
            kind: 'act',
            actor: actorId,
            fact: 'The names cannot be read.',
            text: 'Nothing is learned.',
            intent: 'search',
            finding: { source: 'new:registration-notice', fact: 'No usable names.' },
          },
        ],
      };
    });
    try {
      f.draw.mockImplementation((sides) => {
        if (sides === 20) {
          const draft = JSON.parse(f.game.pending(f.campaign.id)!.draft!);
          expect(draft.gmMemory[0].discoveries[0]).toBe('The notice names Sella Venn and Iven Marr.');
          expect(draft.receipts[`investigation-plan:${actorId}`].request.failure.fact).toContain('clerk');
          return success ? 14 : 1;
        }
        return sides === 100 ? 100 : Math.min(4, sides);
      });
      f.submit({ Moryan: 'Decipher the names on the registration notice.', Katooluman: '' });
      await f.game.idle();
      let snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      const result = snapshot.history.at(-1)!.result!;
      expect(result.narration).not.toContain('Nothing is learned');
      expect(result.narration).not.toContain('No usable names');
      expect(result.narration).toContain(success ? 'Sella Venn and Iven Marr' : 'clerk’s seal');
      expect(result.narration).toContain('original ledger');
      if (!success) expect(result.narration).not.toContain('Sella Venn');
      expect(result.xp).toBe(success ? 10 : 0);
      expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(1);
      expect(snapshot.scene.features?.['new:registration-notice']?.name).toBe('Registration notice');
      const known = JSON.parse(f.game.campaign(f.campaign.id).gm_memory)[0];
      expect(known.revealed ?? []).toEqual(success ? [0] : []);
      expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
      const wire = JSON.parse(String(f.fetcher.mock.calls[1][1]?.body));
      const output = wire.input.find((item: { type: string }) => item.type === 'function_call_output');
      expect(output.output).not.toContain('PRIVATE');
      expect(output.output).not.toContain(success ? 'resist deciphering' : 'Sella Venn');
      expect(wire.tools[0].tools.some((tool: { name: string }) => tool.name === 'investigate')).toBe(true);
      const before = snapshot.members.find((member) => member.id === actorId)!.state.xp;
      f.draw.mockClear();
      f.submit({ Moryan: 'Read those resident names on the registration notice again.', Katooluman: '' });
      await f.game.idle();
      snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(0);
      expect(f.draw.mock.calls.filter(([sides]) => sides === 20 || sides === 100)).toHaveLength(0);
      expect(snapshot.history.at(-1)?.result?.xp).toBe(0);
      expect(snapshot.members.find((member) => member.id === actorId)!.state.xp).toBe(before);
      expect(snapshot.history.at(-1)?.result?.narration).toContain('original ledger');
      expect(f.narrate).not.toHaveBeenCalled();
      if (!success) {
        const scene = structuredClone(snapshot.scene);
        scene.features!['new:registration-notice'].properties.dried = true;
        f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), f.campaign.id);
        f.draw.mockImplementation((sides) => (sides === 20 ? 14 : sides === 100 ? 100 : Math.min(4, sides)));
        f.submit({ Moryan: 'Decipher the registration notice after its ink has dried.', Katooluman: '' });
        await f.game.idle();
        snapshot = f.game.snapshot(f.campaign.id, f.host.id);
        expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
        expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(1);
        expect(snapshot.history.at(-1)?.result?.narration).toContain('Sella Venn and Iven Marr');
        expect(snapshot.history.at(-1)?.result?.xp).toBe(10);
      }
    } finally {
      f.db.close();
    }
  },
);

it('restarts a prepared investigation after publication interruption without rerolling or revealing private branches', async () => {
  const f = await table((context, call) =>
    call === 1
      ? toolResponse('investigate', investigate(context))
      : {
          version: 3,
          summary: 'The registration names are clear.',
          beats: [{ kind: 'investigate', actor: investigate(context).memberId }],
        },
  );
  try {
    f.draw.mockImplementation((sides) => (sides === 20 ? 14 : sides === 100 ? 100 : Math.min(4, sides)));
    f.db.exec(
      "CREATE TRIGGER interrupt_investigation BEFORE UPDATE OF gm_memory ON campaigns BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;",
    );
    f.submit({ Moryan: 'Decipher the registration notice.', Katooluman: '' });
    await f.game.idle();
    expect(f.game.snapshot(f.campaign.id, f.host.id).turn?.phase).toBe('failed');
    expect(JSON.parse(f.game.campaign(f.campaign.id).gm_memory)).toEqual([]);
    expect(JSON.stringify(f.game.snapshot(f.campaign.id, f.host.id))).not.toContain('PRIVATE');
    f.db.exec('DROP TRIGGER interrupt_investigation');
    const restarted = new Game(f.db, () => f.provider, f.draw);
    const calls = f.draw.mock.calls.length;
    restarted.retry(f.campaign.id, f.host.id);
    await restarted.idle();
    const snapshot = restarted.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.history.at(-1)?.result?.narration).toContain('Sella Venn and Iven Marr');
    expect(snapshot.history.at(-1)?.result?.xp).toBe(10);
    expect(JSON.parse(restarted.campaign(f.campaign.id).gm_memory)[0].revealed).toEqual([0]);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.draw).toHaveBeenCalledTimes(calls);
  } finally {
    f.db.close();
  }
});

it('rejects inaccessible leads before rolling and locks both outcome branches on a retry', async () => {
  let invalid: Investigation;
  let original: InvestigationResult;
  let calls = 0;
  const f = await table((context) => {
    const request = investigate(context);
    if (++calls === 1) {
      invalid = structuredClone(request);
      invalid.success.lead.locationId = 'unreachable-vault';
      return toolResponse('investigate', invalid);
    }
    if (calls === 2) {
      expect(f.draw.mock.calls.filter(([sides]) => sides === 20)).toHaveLength(0);
      return toolResponse('investigate', request);
    }
    const saved = context.receipts![`investigation:${request.memberId}`] as InvestigationResult;
    if (calls === 3) {
      original = saved;
      request.preparation = {
        id: 'registration',
        discoveries: ['A replacement invented after seeing the dice.'],
      };
      request.failure.fact = 'The original failure was replaced.';
      request.success.text = 'The original success was replaced.';
      return toolResponse('investigate', request);
    }
    expect(saved).toEqual(original!);
    return {
      version: 3,
      summary: 'The notice is resolved.',
      beats: [{ kind: 'investigate', actor: request.memberId }],
    };
  });
  try {
    f.draw.mockImplementation((sides) => (sides === 20 ? 14 : sides === 100 ? 100 : Math.min(4, sides)));
    f.submit({ Moryan: 'Decipher the registration notice.', Katooluman: '' });
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(1);
    expect(snapshot.history.at(-1)?.result?.narration).not.toContain('replaced');
    expect(JSON.parse(f.game.campaign(f.campaign.id).gm_memory)[0].discoveries).toEqual([
      'The notice names Sella Venn and Iven Marr.',
    ]);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  } finally {
    f.db.close();
  }
});

it.each(['destination', 'origin'])(
  'binds a prepared finding to its actual %s before/after ordinary travel',
  async (location) => {
    const f = await table((context, call) => {
      const request = investigate(context);
      const response = descent(context);
      const move = response.beats[0];
      if (move.kind !== 'move') throw new Error('Expected the recorded move.');
      if (location === 'destination') {
        request.source.locationId = move.to;
        request.preparation.locationId = move.to;
        request.success.lead.locationId = move.to;
        request.failure.lead.locationId = move.to;
      }
      if (call === 1) return toolResponse('investigate', request);
      return {
        version: 3,
        summary: 'Moryan reads the notice and travels.',
        beats:
          location === 'origin'
            ? [{ kind: 'investigate', actor: request.memberId }, move]
            : [move, { kind: 'investigate', actor: request.memberId }],
      };
    });
    try {
      f.draw.mockImplementation((sides) => (sides === 20 ? 14 : sides === 100 ? 100 : Math.min(4, sides)));
      const actor = f.members.find((member) => member.character.name === 'Moryan')!;
      const origin = memberScene(JSON.parse(f.game.campaign(f.campaign.id).scene!), actor.id).location.id!;
      f.submit({
        Moryan:
          location === 'origin'
            ? 'Read the registration notice here, then descend the iron stair.'
            : 'Descend the iron stair and decipher its registration notice.',
        Katooluman: '',
      });
      await f.game.idle();
      const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      const at = memberScene(snapshot.scene, actor.id);
      expect(at.location.name).toBe('Bell Tower Lower Chamber');
      const sourceAt = location === 'origin' ? origin : at.location.id!;
      const place =
        sourceAt === snapshot.scene.location.id ? snapshot.scene : snapshot.scene.places![sourceAt];
      expect(place.searches?.['new:registration-notice']?.information).toContain('Sella Venn');
      expect(snapshot.scene.features?.['new:registration-notice']?.locationId).toBe(sourceAt);
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    } finally {
      f.db.close();
    }
  },
);

it('keeps prepared answers immutable while allowing new discoveries to be appended', () => {
  const context = fixture();
  const note = investigate(context).preparation;
  const memory = gmMemorySchema.parse([note]);
  expect(() => updateGMMemory(memory, [{ ...memory[0], discoveries: ['A different answer.'] }])).toThrow(
    'cannot be rewritten',
  );
  const extended = updateGMMemory(memory, [
    {
      ...memory[0],
      discoveries: [...memory[0].discoveries, 'The original is signed by the clerk.'],
      revealed: [0],
    },
  ]);
  expect(extended[0].discoveries).toHaveLength(2);
  expect(updateGMMemory(extended, [{ ...extended[0], revealed: [] }])[0].revealed).toEqual([0]);
  const appended = prepareGMNotes(memory, [{ id: memory[0].id, appendDiscoveries: ['The original is signed by the clerk.'] }]);
  expect(appended[0].discoveries).toEqual(extended[0].discoveries);
  expect(appended[0].cause).toBe(memory[0].cause);
  expect(() => prepareGMNotes(memory, [{ id: memory[0].id, discoveries: ['Replacement.'], appendDiscoveries: ['Another.'] }])).toThrow(/omit discoveries/);
});

it('keeps registration and household notices distinct, including remote ownership and aliases', () => {
  const context = fixture();
  const actor = context.members[0];
  const at = memberScene(context.scene, actor.id).location.id!;
  const remote = context.members.find((member) => member.id !== actor.id)!;
  const other = Object.keys(context.scene.worldMap!.nodes).find((id) => id !== at)!;
  context.scene.memberLocations![remote.id] = other;
  remote.state.inventory = [
    {
      ...baseItem(randomUUID(), 'Household notice', 'tool'),
      quantity: 1,
      description: 'A list of one household.',
    },
  ];
  context.scene.features = {
    registration: {
      id: 'registration',
      name: 'Ward registration notice',
      aliases: ['registration notice'],
      locationId: at,
      properties: {},
      fact: 'A posted public registration notice.',
    },
  };
  context.turn.actions[0].text = 'Find the registration notice.';
  expect(() =>
    bindInvestigationSource(context, actor.id, {
      kind: 'item',
      id: remote.state.inventory[0].id,
      locationId: at,
    }),
  ).toThrow('another location');
  expect(() =>
    bindInvestigationSource(context, actor.id, {
      kind: 'item',
      id: remote.state.inventory[0].id,
      locationId: other,
    }),
  ).toThrow(/submitted target|adjacent/);
  expect(() =>
    bindInvestigationSource(context, actor.id, {
      kind: 'feature',
      id: 'new:copy',
      name: 'Registration notice',
      description: 'Another copy.',
      locationId: at,
    }),
  ).toThrow('already exists');
  expect(
    bindInvestigationSource(context, actor.id, { kind: 'feature', id: 'registration', locationId: at }).source
      .id,
  ).toBe('registration');
});

it.each([false, true])(
  'saves an introduced person and a collected story object atomically (full backpack=%s)',
  async (full) => {
    const f = await table((context) => ({
      version: 3,
      summary: 'Sella meets the party while Moryan takes a plank.',
      beats: context.turn.actions.map((action) =>
        context.members.find((member) => member.id === action.memberId)!.character.name === 'Moryan'
          ? {
              kind: 'take',
              actor: action.memberId,
              item: {
                source: 'loose-plank',
                name: 'Loose plank',
                description: 'A plain wooden plank from beside the wall.',
              },
              fact: 'Moryan takes the loose plank.',
              text: 'Moryan slips the loose plank into his backpack.',
            }
          : {
              kind: 'meet',
              actor: action.memberId,
              person: { npcId: 'sella-venn', name: 'Sella Venn' },
              fact: 'Sella Venn introduces herself as the ward’s clerk.',
              text: '“Sella Venn, ward clerk,” the woman says.',
            },
      ),
    }));
    try {
      const member = f.members.find((member) => member.character.name === 'Moryan')!;
      const initial: Scene = JSON.parse(f.game.campaign(f.campaign.id).scene!);
      initial.features = {
        ...initial.features,
        'loose-plank': {
          id: 'loose-plank',
          name: 'Loose plank',
          aliases: [],
          locationId: memberScene(initial, member.id).location.id!,
          properties: {},
          fact: 'A loose plank lies beside the wall.',
        },
      };
      f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(initial), f.campaign.id);
      if (full) {
        member.state.inventory = Array.from({ length: 8 }, (_, index) => ({
          ...baseItem(randomUUID(), `Ballast ${index}`, 'tool'),
          quantity: 1,
        }));
        f.db.prepare('UPDATE members SET state=? WHERE id=?').run(JSON.stringify(member.state), member.id);
      }
      f.submit({ Moryan: 'Take the loose plank.', Katooluman: 'Ask the ward clerk her name.' });
      await f.game.idle();
      const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      const actor = snapshot.members.find((saved) => saved.id === member.id)!;
      const carried = actor.state.inventory.find((item) => item.name === 'Loose plank');
      const ground = memberScene(snapshot.scene, member.id).loot.find((item) => item.name === 'Loose plank');
      expect(!!carried).toBe(!full);
      expect(!!ground).toBe(full);
      expect((carried ?? ground)?.kind).toBe('tool');
      expect(snapshot.scene.features?.['loose-plank']).toBeUndefined();
      expect(memberScene(snapshot.scene, member.id).searchedLoot?.['loose-plank']).toBe('Loose plank');
      expect(snapshot.scene.npcs?.['sella-venn']?.name).toBe('Sella Venn');
      expect(
        snapshot.journal.find((entry) => entry.kind === 'npc' && entry.name === 'Sella Venn')?.detail,
      ).toContain('clerk');
      if (full) expect(snapshot.history.at(-1)?.result?.narration).not.toContain('slips the loose plank');
      expect(f.narrate).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  },
);

it.each(['ongoing', 'victory', 'interrupted'])(
  'publishes %s combat with reviewed scene prose and no separate writer',
  async (mode) => {
    const f = await table((context) => {
      expect(context.sceneProtocol).toBe(true);
      expect(context.combatResult?.events?.length).toBeGreaterThan(0);
      const victory = context.scene.encounter!.victory;
      const beats: unknown[] = [
        {
          kind: 'combat',
          at: 'current',
          text: victory
            ? 'Katooluman strikes the Shadow Wight, killing it. Ash settles around the fallen creature.'
            : 'Katooluman and Moryan strike into empty shadow. The Shadow Wight sweeps back at them, but its attack also misses.',
        },
      ];
      if (victory)
        beats.push({
          kind: 'world',
          at: 'current',
          fact: 'The Shadow Wight lies dead in the Outer Ward. Unstable debris remains along the street.',
          text: 'The clash falls quiet. Loose masonry still crowds the street beneath the dead lamps.',
          place: {
            name: context.scene.location.name,
            atmosphere: 'The wight lies still beneath the dead lamps.',
            hazard: 'Loose masonry remains unstable.',
            danger: 'dangerous',
            riskReason: 'Loose masonry can still collapse.',
          },
        });
      return {
        version: 3,
        beats,
        summary: victory ? 'The Shadow Wight is dead.' : 'The Shadow Wight remains alive.',
      };
    });
    try {
      const state = recordedCombat().scene;
      state.memberLocations = Object.fromEntries(f.members.map((member) => [member.id, state.location.id!]));
      const katooluman = f.members.find((member) => member.character.name === 'Katooluman')!;
      const moryan = f.members.find((member) => member.character.name === 'Moryan')!;
      state.encounter!.initiative = [
        { id: katooluman.id, total: 20 },
        { id: moryan.id, total: 19 },
        { id: state.encounter!.enemies[0].id, total: 1 },
      ];
      if (mode === 'victory') state.encounter!.enemies[0].hp = 1;
      f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(state), f.campaign.id);
      f.provider.planCombat = vi.fn(async (context) => normalizeCombatInput(context));
      f.draw.mockImplementation((sides) => Math.min(mode === 'victory' ? 20 : 4, sides));
      if (mode === 'interrupted')
        f.db.exec(
          "CREATE TRIGGER interrupt_scene_publication BEFORE UPDATE OF gm_memory ON campaigns BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;",
        );
      const turnId = f.game.pending(f.campaign.id)!.id;
      for (const member of f.members)
        f.game.submit(f.campaign.id, member.playerId, turnId, 'I attack Shadow Wight.', false);
      await f.game.idle();
      if (mode === 'interrupted') {
        expect(f.game.pending(f.campaign.id)?.phase).toBe('failed');
        const before = JSON.parse(f.game.pending(f.campaign.id)!.draft!);
        expect(before.adjudication.sceneDraft).toBeDefined();
        const rolls = f.db.prepare('SELECT * FROM rolls WHERE turn_id=? ORDER BY rowid').all(turnId);
        const draws = f.draw.mock.calls.length;
        f.db.exec('DROP TRIGGER interrupt_scene_publication');
        const restarted = new Game(f.db, () => f.provider, f.draw);
        restarted.retry(f.campaign.id, f.host.id);
        await restarted.idle();
        expect(f.draw).toHaveBeenCalledTimes(draws);
        expect(f.db.prepare('SELECT * FROM rolls WHERE turn_id=? ORDER BY rowid').all(turnId)).toEqual(rolls);
        const after = JSON.parse(
          (f.db.prepare('SELECT draft FROM turns WHERE id=?').get(turnId) as { draft: string }).draft,
        );
        expect(after.receipts.combat).toEqual(before.receipts.combat);
      }
      const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      expect(snapshot.history.at(-1)?.id).toBe(turnId);
      expect(snapshot.history.at(-1)?.result?.narration).toContain('Katooluman');
      expect(snapshot.scene.encounter?.victory).toBe(mode === 'victory');
      expect(snapshot.scene.encounter?.round).toBe(state.encounter!.round + 1);
      expect(f.fetcher).toHaveBeenCalledTimes(2);
      expect(f.provider.planCombat).toHaveBeenCalledTimes(1);
      expect(f.provider.reviewSceneNarration).toHaveBeenCalledTimes(1);
      expect(f.narrate).not.toHaveBeenCalled();
      const stages = f.db
        .prepare("SELECT payload FROM events WHERE turn_id=? AND kind='stage:adjudication'")
        .all(turnId) as { payload: string }[];
      expect(stages.flatMap((row) => JSON.parse(row.payload).corrections ?? [])).toEqual([]);
      if (mode === 'victory') {
        expect(snapshot.scene.location.atmosphere).toContain('wight lies still');
        expect(snapshot.members.every((member) => member.state.xp > 0)).toBe(true);
      }
    } finally {
      f.db.close();
    }
  },
);

it.each(['rejected', 'unavailable', 'missing'])(
  'publishes saved combat facts when the prose reviewer is %s without repeating mechanics',
  async (review) => {
    const invented = 'The Shadow Wight shoots Katooluman down. Moryan tries an unsubmitted healing action, but the combat action system prevents it.';
    const badSummary = 'Katooluman is Downed.';
    const f = await table(() => ({
      version: 3, summary: badSummary,
      beats: [{ kind: 'combat', at: 'current', text: invented }],
    }));
    try {
      const state = recordedCombat().scene;
      state.memberLocations = Object.fromEntries(f.members.map((member) => [member.id, state.location.id!]));
      state.encounter!.initiative = [
        ...f.members.map((member) => ({ id: member.id, total: 20 })),
        { id: state.encounter!.enemies[0].id, total: 1 },
      ];
      f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(state), f.campaign.id);
      f.provider.planCombat = vi.fn(async (context) => normalizeCombatInput(context));
      if (review === 'missing') delete f.provider.reviewSceneNarration;
      const sceneResponse = f.fetcher.getMockImplementation()!;
      let drawsBeforeReview: number | undefined;
      f.fetcher.mockImplementation(async (url, init) => {
        const data = JSON.parse(JSON.parse(String(init?.body)).input[0].content);
        if (data.resolution) {
          drawsBeforeReview ??= f.draw.mock.calls.length;
          if (data.candidate) {
            expect(data.resolution).not.toHaveProperty('factualRecap');
            expect(data.resolution.events.some((event: { kind: string }) => event.kind === 'combat')).toBe(true);
            if (review === 'unavailable') throw new Error('Review unavailable.');
            return response({ storyApproved: false, summaryApproved: false, feedback: 'No shot downed Katooluman and no healing was submitted. Preserve the saved misses and HP.' });
          }
          return response({
            version: 2, turnId: data.resolution.turnId, closing: '', summary: badSummary,
            passages: [{ eventIds: data.resolution.events.map((event: { id: string }) => event.id), text: invented }],
          });
        }
        return sceneResponse(url, init);
      });
      f.submit(Object.fromEntries(f.members.map((member) => [member.character.name, 'Attack Shadow Wight.'])));
      await f.game.idle();
      const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      const result = snapshot.history.at(-1)!.result!;
      expect(result.narration).not.toContain('shoots Katooluman down');
      expect(result.narration).not.toContain('unsubmitted healing');
      expect(result.narration).not.toContain('combat action system');
      expect(result.summary).not.toContain('Downed');
      expect(snapshot.members.every((member) => member.state.hp > 0)).toBe(true);
      expect(snapshot.scene.encounter!.round).toBe(state.encounter!.round + 1);
      if (drawsBeforeReview !== undefined) expect(f.draw).toHaveBeenCalledTimes(drawsBeforeReview);
      expect(f.provider.planCombat).toHaveBeenCalledTimes(1);
    } finally {
      f.db.close();
    }
  },
);

it('replays the recorded two-player tower turn through finalization and publication in an isolated database', async () => {
  const f = await table((context) => descent(context));
  try {
    const id = f.submit();
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.history.at(-1)?.id).toBe(id);
    const moryan = snapshot.members.find((member) => member.character.name === 'Moryan')!;
    const at = memberScene(snapshot.scene, moryan.id).location;
    expect(at.name).toBe('Bell Tower Lower Chamber');
    expect(snapshot.scene.worldMap?.nodes[at.id!].visited).toBe(true);
    expect(snapshot.history.at(-1)?.result?.narration).toContain('Moryan takes the iron stairs down');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.narrate).not.toHaveBeenCalled();
    const stages = f.db
      .prepare("SELECT payload FROM events WHERE turn_id=? AND kind LIKE 'stage:%'")
      .all(id) as { payload: string }[];
    expect(stages.flatMap((row) => JSON.parse(row.payload).corrections ?? [])).toEqual([]);
  } finally {
    f.db.close();
  }
});

it('rolls back private memory on a publication failure and resumes it without another model call', async () => {
  const f = await table((context) => {
    const response = descent(context);
    response.notes = [
      {
        id: 'buried-engine',
        locationId: 'new:lower-chamber',
        cause: 'PRIVATE mechanical governor.',
        discoveries: ['The shaft contains its governor.'],
        actors: 'The keeper services it.',
        nextChange: 'The keeper arrives for maintenance.',
        dueTurn: 7,
        status: 'open',
      },
    ];
    return response;
  });
  try {
    f.db.exec(
      "CREATE TRIGGER reject_private_save BEFORE UPDATE OF gm_memory ON campaigns BEGIN SELECT RAISE(ABORT, 'simulated publication interruption'); END;",
    );
    f.submit();
    await f.game.idle();
    expect(f.game.snapshot(f.campaign.id, f.host.id).turn?.phase).toBe('failed');
    expect(JSON.parse(f.game.campaign(f.campaign.id).gm_memory)).toEqual([]);
    expect(JSON.stringify(f.game.snapshot(f.campaign.id, f.host.id))).not.toContain('PRIVATE');
    f.db.exec('DROP TRIGGER reject_private_save');
    const restarted = new Game(f.db, () => f.provider, f.draw);
    restarted.retry(f.campaign.id, f.host.id);
    await restarted.idle();
    expect(restarted.snapshot(f.campaign.id, f.host.id).turn?.phase).toBe('collecting');
    const note = JSON.parse(restarted.campaign(f.campaign.id).gm_memory)[0];
    expect(note.cause).toBe('PRIVATE mechanical governor.');
    expect(note.locationId).not.toMatch(/^new:/);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.narrate).not.toHaveBeenCalled();
  } finally {
    f.db.close();
  }
});

it('accepts a due local world development while the players pass', () => {
  const context = fixture();
  for (const action of context.turn.actions) {
    action.passed = true;
    action.text = '';
  }
  const at = memberScene(context.scene, context.members[0].id).location.id!;
  const note = {
    id: 'keeper',
    locationId: at,
    cause: 'A keeper services the engine.',
    discoveries: ['The keeper knows the fault.'],
    actors: 'The keeper arrives for work.',
    nextChange: 'The keeper arrives.',
    dueTurn: 6,
    status: 'open' as const,
  };
  context.gmMemory = [note];
  const accepted = compileSceneTurn(context, {
    version: 3,
    summary: 'The keeper arrives.',
    beats: [
      {
        kind: 'world',
        at,
        fact: 'The keeper arrives carrying tools to inspect the engine.',
        text: 'A keeper arrives with tools and kneels beside the engine.',
        npcs: [{ npcId: 'keeper', name: 'The keeper' }],
      },
    ],
    notes: [{ id: note.id, nextChange: 'The keeper begins inspection.', dueTurn: 7 }],
  });
  expect(accepted.actions.every((action) => action.status === 'passed')).toBe(true);
  expect(accepted.npcUpdates).toContainEqual(expect.objectContaining({ npcId: 'keeper', locationId: at }));
  expect(accepted.gmNotes?.[0].dueTurn).toBe(7);
  expect(accepted.gmNotes?.[0].cause).toBe(note.cause);
});

it('consolidates a shared NPC conversation without duplicate state records', () => {
  const context = fixture();
  const at = context.scene.memberLocations![context.members[0].id];
  for (const member of context.members) context.scene.memberLocations![member.id] = at;
  const accepted = compileSceneTurn(context, {
    version: 3,
    summary: 'Iven answers both travellers.',
    beats: context.members.map((member, index) => ({
      kind: 'act',
      actor: member.id,
      fact: index ? 'Iven offers to identify the collector.' : 'Iven explains the household marks.',
      text: index
        ? '“I can identify the collector,” Iven says.'
        : 'Iven explains how the household marks work.',
      npcs: [{ npcId: 'iven', name: 'Iven' }],
    })),
  });
  expect(accepted.npcUpdates).toHaveLength(1);
  expect(accepted.events.filter((event) => event.npcIds?.includes('iven'))).toHaveLength(2);
});

it('retains a source investigation before ordinary departure in the submitted order', () => {
  const context = fixture();
  const value = descent(context);
  const move = value.beats[0];
  if (move.kind !== 'move') throw new Error('fixture');
  const origin = memberScene(context.scene, move.actor).location.id!;
  context.turn.actions.find((action) => action.memberId === move.actor)!.text =
    'Inspect the threshold, then go downstairs.';
  value.beats.unshift({
    kind: 'act',
    actor: move.actor,
    slot: 'main',
    intent: 'search',
    fact: 'Moryan identifies the threshold’s loose cover.',
    text: 'Moryan finds a loose maintenance cover in the threshold before descending.',
    finding: {
      source: 'tower:threshold-cover',
      fact: 'The threshold has a loose maintenance cover that can be lifted.',
    },
  });
  const accepted = compileSceneTurn(context, value);
  const actor = accepted.actions.find((action) => action.memberId === move.actor)!;
  expect(actor.search?.locationId).toBe(origin);
  expect(actor.components.movement?.status).toBe('success');
  expect(accepted.events.findIndex((event) => event.id === actor.search?.informationEventId)).toBeLessThan(
    accepted.events.findIndex((event) => event.id === actor.components.movement?.eventIds[0]),
  );
});

it('corrects a rejected inventory operation in prose locally without a critic or fictional success', () => {
  const context = fixture();
  const actor = context.members[0];
  const at = memberScene(context.scene, actor.id);
  // This action observes an item; the proposed pickup exceeds the player's consent.
  context.turn.actions[0].text = 'Look at the stone.';
  context.scene.loot = [{ ...baseItem('stone', 'Small stone', 'tool'), quantity: 1 }];
  const value = descent(context);
  value.beats[0] = {
    kind: 'act',
    actor: actor.id,
    slot: 'main',
    intent: 'action',
    fact: 'Moryan pockets the stone.',
    text: 'Moryan pockets the stone.',
    pickup: { itemId: 'stone' },
  };
  const accepted = compileSceneTurn(context, value);
  expect(accepted.actions.find((action) => action.memberId === actor.id)?.status).toBe('blocked');
  expect(accepted.sceneDraft?.passages[0].text).toContain('did not request collection');
  expect(accepted.sceneDraft?.summary).not.toContain('pockets');
  expect(at.location.id).toBe(context.scene.location.id);
});

it('persists newly visible onward destinations at a split-party arrival without generating their contents', async () => {
  const f = await table((context) => {
    const scene = descent(context);
    const move = scene.beats[0];
    if (move.kind !== 'move') throw new Error('Expected travel.');
    move.fact +=
      ' Beyond the chamber, an eastward service passage reaches the pump room; a sealed hatch leads north to the reservoir.';
    move.text +=
      ' An eastward service passage leads to the pump room. A sealed northern hatch bears the reservoir sign.';
    move.exits = [
      {
        to: 'new:pump-room',
        name: 'Pump room',
        label: 'East service passage',
        blocked: false,
        bidirectional: true,
      },
      {
        to: 'new:reservoir',
        name: 'Reservoir',
        label: 'North sealed hatch',
        blocked: true,
        bidirectional: true,
      },
    ];
    return scene;
  });
  try {
    f.submit();
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    const actor = snapshot.members.find((member) => member.character.name === 'Moryan')!;
    const arrived = memberScene(snapshot.scene, actor.id).location.id!;
    const pump = Object.values(snapshot.scene.worldMap!.nodes).find((node) => node.name === 'Pump room')!;
    const reservoir = Object.values(snapshot.scene.worldMap!.nodes).find(
      (node) => node.name === 'Reservoir',
    )!;
    expect(snapshot.members.some((member) => memberScene(snapshot.scene, member.id).location.id === snapshot.scene.location.id)).toBe(true);
    for (const node of [pump, reservoir]) {
      expect(node.visited).toBe(false);
      expect(snapshot.scene.places?.[node.id]).toBeUndefined();
    }
    expect(snapshot.scene.worldMap!.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: arrived, to: pump.id, blocked: false }),
        expect.objectContaining({ from: arrived, to: reservoir.id, blocked: true }),
      ]),
    );
    expect(snapshot.history.at(-1)?.result?.narration).toContain('eastward service passage');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  } finally {
    f.db.close();
  }
});

it('introduces a saved random encounter after arrival without rewriting the scene or calling a narrator', async () => {
  const introduction =
    'The Chamber keeper steps out from behind the shaft and bars the stair with a spear: the vibrations have awakened its defence of the machinery.';
  const f = await table((context, call) => {
    if (call === 1) return descent(context);
    const output = [
      {
        type: 'function_call',
        namespace: 'game',
        name: 'start_combat',
        call_id: 'keeper-start',
        arguments: JSON.stringify({
          locationId: 'new:lower-chamber',
          introduction,
          enemies: [
            {
              id: 'keeper',
              name: 'Chamber keeper',
              tier: 'minor',
              hp: 8,
              defense: 8,
              attack: 0,
              damage: '1d4',
              description: 'A guardian approaches from behind the shaft.',
              tactic: 'Guard the shaft.',
              equipmentBlueprints: [],
            },
          ],
        }),
      },
    ];
    return new Response(
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`,
    );
  });
  try {
    f.draw.mockImplementation((sides) => (sides === 6 ? 1 : Math.min(4, sides)));
    const turnId = f.submit();
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.history.at(-1)?.result?.narration).toContain('Moryan takes the iron stairs down');
    expect(snapshot.history.at(-1)?.result?.narration).toContain('Chamber keeper');
    expect(snapshot.history.at(-1)?.result?.narration).toContain(introduction);
    expect(snapshot.history.at(-1)?.result?.summary).toContain('Chamber keeper');
    const draft = JSON.parse(
      (f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(turnId) as { draft: string }).draft,
    );
    expect(draft.receipts.combatIntroductionsByLocation['new:lower-chamber']).toBe(introduction);
    const actor = snapshot.members.find((member) => member.character.name === 'Moryan')!;
    expect(memberScene(snapshot.scene, actor.id).encounter?.round).toBe(1);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.narrate).not.toHaveBeenCalled();
  } finally {
    f.db.close();
  }
});

it('requires a world currency name, then preserves it in later generated scenes', async () => {
  const context = fixture();
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    expect(body.instructions).toContain("fitting this world's lore");
    return response({ ...descent(context), currencyName: fetcher.mock.calls.length === 1 ? '' : 'night marks' });
  });
  const gm = new ChatGPTGM(auth, 'owner', 'test', fetcher);
  const accepted = await gm.adjudicate(context, tools(context));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(accepted.currencyName).toBe('night marks');

  context.scene.currencyName = accepted.currencyName;
  const later = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(JSON.parse(init!.body as string).instructions).toContain('Currency: "night marks"');
    return response({ ...descent(context), currencyName: 'unrelated credits' });
  });
  const preserved = await new ChatGPTGM(auth, 'owner', 'test', later).adjudicate(context, tools(context));
  expect(preserved.currencyName).toBe('night marks');
});

it('persists the generated currency name in the campaign and finalized turn across restart', async () => {
  const f = await table((context) => ({ ...descent(context), currencyName: 'night marks' }));
  try {
    f.submit();
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.scene.currencyName).toBe('night marks');
    expect(snapshot.history.at(-1)?.resolution?.currencyName).toBe('night marks');
    const restarted = new Game(f.db, () => f.provider, f.draw);
    expect(restarted.snapshot(f.campaign.id, f.host.id).scene.currencyName).toBe('night marks');
  } finally {
    f.db.close();
  }
});

it('publishes investigation limits from the same schema that validates calls, allowing expanded actor aliases', () => {
  const schema = modelSchema(investigationSchema);
  expect(schema.properties.answer).toMatchObject({ type: 'integer', minimum: 0, maximum: 5 });
  expect(schema.properties.preparation.properties.discoveries).toMatchObject({
    minItems: 1, maxItems: 6, items: { type: 'string', maxLength: 500 },
  });
  expect(schema.properties.success.properties.text.maxLength).toBe(2000);
  expect(schema.properties.failure.properties.lead.properties.fact.maxLength).toBe(500);
  expect(schema.properties.memberId.format).toBeUndefined();
});

it('deduplicates a meeting participant also supplied as an unchanged NPC update', () => {
  const context = fixture();
  const scene = descent(context);
  const act = scene.beats[1];
  if (act.kind !== 'act') throw new Error('fixture');
  scene.beats[1] = { kind: 'meet', actor: act.actor, fact: act.fact, text: act.text,
    person: { npcId: 'iven', name: 'Iven' }, npcs: [{ npcId: 'iven', name: 'Iven' }] };
  const accepted = compileSceneTurn(context, scene);
  for (const event of accepted.events) if (event.npcIds)
    expect(event.npcIds).toEqual([...new Set(event.npcIds)]);
  expect(accepted.npcUpdates!.filter((npc) => npc.npcId === 'iven')).toHaveLength(1);
});

it('records failed repair observations without changing the feature state, routes or objectives', () => {
  const context = fixture();
  const member = context.members[0];
  context.members = [member];
  context.turn.roster = [member.id];
  context.turn.actions = [{ memberId: member.id, text: 'Repair the broken connector.', passed: false }];
  const at = memberScene(context.scene, member.id).location.id!;
  context.scene.features = { connector: { id: 'connector', name: 'Broken connector', aliases: [],
    locationId: at, properties: { repaired: false }, fact: 'Broken connector remains unrepaired.' } };
  context.turn.rolls.push({ id: randomUUID(), memberId: member.id, stat: 'INT', dc: 10, mode: 'advantage',
    dice: [1, 4], modifier: 3, total: 7, success: false, reason: 'Repair the connector.', lethal: false, source: 'test' });
  const fact = 'Patch braces the Broken connector but cannot repair it; a recessed contact is visible.';
  const scene: SceneTurn = { version: 3, summary: fact, notes: [], beats: [{ kind: 'act', actor: member.id, slot: 'main', intent: 'action',
    fact, text: fact, features: [{ featureId: 'connector', name: 'Broken connector', properties: { repaired: true } }] }] };
  const accepted = compileSceneTurn(context, scene);
  expect(accepted.actions[0].status).toBe('failure');
  expect(accepted.featureUpdates![0]).toMatchObject({ observation: fact });
  expect(accepted.featureUpdates![0].properties).toBeUndefined();
  applyFeatureUpdates(context.scene, accepted, (ref) => ref);
  expect(context.scene.features.connector).toMatchObject({ properties: { repaired: false }, observation: fact });
  const beat = scene.beats[0];
  if (beat.kind !== 'act') throw new Error('fixture');
  beat.features![0].passable = true;
  expect(() => compileSceneTurn(context, scene)).toThrow(/failed action cannot.*route/);
  expect(context.turn.rolls).toHaveLength(1);
});

it('reports independent operation errors together without accepting the invalid scene', () => {
  const context = fixture();
  const scene = descent(context);
  scene.beats.push(structuredClone(scene.beats[0]), structuredClone(scene.beats[1]));
  let message = '';
  try { compileSceneTurn(context, scene); } catch (error) { message = (error as Error).message; }
  expect(message).toContain('Travel crosses one connection');
  expect(message).toContain('One main and one minor action');
  expect(message).toContain('beats[2]');
  expect(message).toContain('beats[3]');
});

it('repairs a single beat without resending unaffected narration or replacing saved outcomes', async () => {
  const context = fixture();
  context.scene.currencyName = 'night marks';
  const original = descent(context);
  const invalid = structuredClone(original);
  invalid.beats.push(structuredClone(original.beats[1]));
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (fetcher.mock.calls.length === 1) return response(invalid);
    const wire = JSON.parse(init!.body as string);
    const retained = wire.input.find((item: { role?: string }) => item.role === 'assistant');
    expect(JSON.parse(retained.content).beats[0]).not.toHaveProperty('text');
    expect(wire.input.at(-1).content).toContain('patches');
    return response({ version: 3, patches: [{ index: 2, remove: true }] });
  });
  const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(accepted.sceneDraft?.passages.some((passage) => passage.text === ('text' in original.beats[0] ? original.beats[0].text : ''))).toBe(true);
  expect(accepted.memberLocations).toHaveLength(1);
  expect(() => mergeScenePatch(original, { version: 3, patches: [{ index: 99, remove: true }] })).toThrow(/indexes/);
  expect(() => mergeScenePatch(original, { version: 3, patches: [{ index: 0, remove: true }, { index: 0, remove: true }] })).toThrow(/distinct/);
});

it('clears optional beat fields while preserving other fields, explicit nulls and named feature properties', () => {
  const base = { beats: [{ kind: 'world', at: 'place:1', fact: 'The pier floods.', text: 'The pier floods.', progress: null }] };
  const patch = decodeStructuredOutput({ version: 3, patches: [{ index: 0, unset: ['progress'],
    beat: { $optional: [{ features: [{ featureId: 'pier', properties: { $entries: [
      { key: 'depth', value: null }, { key: 'flooded', value: true },
    ] } }] }] } }] });
  const repaired = mergeScenePatch(base, patch);
  expect(repaired).toEqual({ version: 3, beats: [{ kind: 'world', at: 'place:1', fact: 'The pier floods.', text: 'The pier floods.',
    features: [{ featureId: 'pier', properties: { depth: null, flooded: true } }] }] });
  expect(base.beats[0]).toHaveProperty('progress', null);
  expect(() => mergeScenePatch(base, { version: 3, patches: [{ index: 0, beat: { progress: null } }] }, fixture()))
    .toThrow(/Expected object, received null/);
  for (const edit of [{ unset: ['text'] }, { unset: ['typo'] }, { unset: ['progress'], beat: { progress: null } },
    { remove: true, unset: ['progress'] }])
    expect(() => mergeScenePatch(base, { version: 3, patches: [{ index: 0, ...edit }] })).toThrow();
  expect(() => decodeStructuredOutput({ $entries: [{ key: 'a', value: 1 }, { key: 'a', value: 2 }] })).toThrow(/unique/);
});

it('recognizes directed travel despite unrelated negative clauses without moving a negated traveller', () => {
  const context = fixture();
  const member = context.members[0];
  const destination = Object.entries(context.scene.worldMap!.nodes).find(([id]) => id !== memberScene(context.scene, member.id).location.id)!;
  for (const text of [`Walk east to ${destination[1].name}. Do not connect the shard to a network.`,
    `Loop naar het ${destination[1].name}. Ik sluit de chip niet aan.`]) {
    context.turn.actions[0].text = text;
    expect(submittedTravel(context, member.id)?.goalId).toBe(destination[0]);
  }
  context.turn.actions[0].text = `Do not walk east to ${destination[1].name}.`;
  expect(submittedTravel(context, member.id)).toBeUndefined();
});

it('retains a first arrival through a rejected unrelated feature update without inventing its danger assessment', async () => {
  const context = fixture();
  context.scene.currencyName = 'night marks';
  const scene = descent(context);
  const move = scene.beats[0];
  const talk = scene.beats[1];
  if (move.kind !== 'move' || talk.kind !== 'act') throw new Error('fixture');
  const destination = randomUUID();
  const origin = memberScene(context.scene, move.actor).location.id!;
  context.scene.worldMap!.nodes[destination] = { id: destination, name: 'Test chamber', visited: false };
  context.scene.worldMap!.connections.push({ from: origin, to: destination, label: 'Open stair', blocked: false, bidirectional: true });
  move.to = destination;
  move.place!.name = 'Test chamber';
  context.turn.actions.find((action) => action.memberId === move.actor)!.text = 'Walk east to Test chamber. Do not touch the machinery.';
  talk.features = [{ featureId: 'invalid-person-object', name: 'Iven', properties: { occupied: true } }];
  const gameTools = tools(context);
  gameTools.validateAdjudication = (input) => validateAdjudication(context, input);
  const fetcher = vi.fn(async () => response(scene));
  const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, gameTools);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(accepted.memberLocations).toContainEqual(expect.objectContaining({ memberId: move.actor, locationId: destination }));
  expect(accepted.placeUpdates).toContainEqual(expect.objectContaining({ ref: destination }));
  expect(accepted.encounterRisks).toContainEqual(expect.objectContaining({ locationId: destination, danger: 'dangerous' }));
  expect(accepted.featureUpdates?.some((feature) => feature.featureId === 'invalid-person-object') ?? false).toBe(false);
  expect(context.turn.rolls).toEqual([]);
});

it.each([true, false])('requires full preparation for new investigation hooks and permits patches only for saved IDs (existing=%s)', async (existing) => {
  const context = fixture();
  if (existing) context.gmMemory = [{ id: 'saved-hook', locationId: context.scene.location.id!,
    cause: 'A known cause.', discoveries: ['A prepared answer.'], actors: 'A keeper.', nextChange: 'The keeper returns.', dueTurn: null, status: 'open' }];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const wire = JSON.parse(init!.body as string);
    const tool = wire.tools[0].tools.find((tool: { name: string }) => tool.name === 'investigate');
    const schema = tool.parameters.properties.preparation;
    const fresh = existing ? schema.anyOf[1] : schema;
    expect(fresh.required).toEqual(expect.arrayContaining(['id', 'cause', 'locationId', 'discoveries', 'actors', 'nextChange', 'dueTurn', 'status']));
    expect(fresh.properties.discoveries.items.maxLength).toBe(500);
    if (existing) {
      expect(schema.anyOf[0].required).toEqual(['id']);
      expect(schema.anyOf[0].properties.id.enum).toEqual(['saved-hook']);
    }
    return response(descent(context));
  });
  await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('derives public NPC identity labels and permits witnessed exits on successful interactions', () => {
  const context = fixture();
  const scene = descent(context);
  const talk = scene.beats[1];
  if (talk.kind !== 'act') throw new Error('fixture');
  context.turn.actions.find((action) => action.memberId === talk.actor)!.text = 'Ask the masked keeper for audit access.';
  talk.fact = talk.text = 'The masked keeper grants supervised inspection and opens the public approach to the audit room.';
  talk.npcs = [{ npcId: 'new:keeper', name: 'North Gate Masked Keeper' }];
  talk.exits = [{ to: 'new:audit', name: 'Audit room', label: 'Authorized approach', blocked: false, bidirectional: true }];
  const accepted = compileSceneTurn(context, scene);
  const keeper = accepted.npcUpdates!.find((person) => person.npcId === 'new:keeper')!;
  expect(accepted.events.find((event) => event.id === keeper.eventId)?.fact).toContain('North Gate Masked Keeper');
  expect(accepted.mapUpdates?.locations).toContainEqual({ ref: 'new:audit', name: 'Audit room' });
  expect(accepted.mapUpdates?.connections).toContainEqual(expect.objectContaining({ to: 'new:audit', blocked: false }));
  expect(accepted.memberLocations?.some((position) => position.locationId === 'new:audit')).toBe(false);
});

it('binds a known local NPC addressed by a unique first name without requiring redundant metadata', () => {
  const context = fixture();
  const actor = context.members[0];
  const at = memberScene(context.scene, actor.id).location.id!;
  context.members = [actor];
  context.turn.roster = [actor.id];
  context.turn.actions = [{ memberId: actor.id, text: 'Ask Dena about the reader.', passed: false }];
  context.scene.npcs = { dena: { id: 'dena', name: 'Dena Orr', aliases: [], locationId: at,
    status: 'alive', allegiance: null, fact: 'Dena Orr works at the reader.' } };
  const scene: SceneTurn = { version: 3, notes: [], summary: 'Dena explains the reader.', beats: [{ kind: 'act', actor: actor.id,
    slot: 'main', intent: 'action', fact: 'Dena explains that the reader is functioning.', text: '“The reader works,” Dena says.' }] };
  const accepted = compileSceneTurn(context, scene);
  expect(accepted.npcUpdates).toContainEqual(expect.objectContaining({ npcId: 'dena' }));
  context.scene.npcs.other = { ...context.scene.npcs.dena, id: 'other', name: 'Dena Sen' };
  expect(() => compileSceneTurn(context, scene)).toThrow(/Persist the person/);
});

it('resolves unique saved actor names and refuses ambiguous names', () => {
  const c = fixture();
  const actor = c.members[0];
  expect(resolveActorReference(c, ` ${actor.character.name.toUpperCase()} `)).toBe(actor.id);
  expect(resolveActorReference(c, 'actor:1')).toBe(actor.id);
  c.scene.npcs = { tavin: { id: 'tavin', name: 'Tavin Reed', aliases: ['The mapmaker'], status: 'alive',
    locationId: c.scene.location.id!, allegiance: null, fact: 'Tavin is wounded.' } };
  expect(resolveActorReference(c, 'the mapmaker')).toBe('tavin');
  c.members[1].character.name = actor.character.name;
  expect(() => resolveActorReference(c, actor.character.name)).toThrow(/Ambiguous actor name/);
  expect(resolveActorReference(c, actor.id)).toBe(actor.id);
});

it('executes a natural-language healing request with named actors and NPCs without inventing a potion action', async () => {
  const spell = "Anatomist's Mercy";
  const f = await table((c, call) => call === 1
    ? toolResponse('use_resource', { memberId: 'Moryan', targetId: 'Tavin Reed', abilityName: spell, itemId: null })
    : { version: 3, summary: 'Tavin receives treatment.', beats: [{ kind: 'act', actor: 'Moryan',
        fact: 'Moryan uses Anatomist’s Mercy to treat Tavin Reed.', text: 'Moryan guides blood through the wound; Tavin receives treatment.' }] });
  try {
    const healer = f.members.find((m) => m.character.name === 'Moryan')!;
    healer.character.abilities[1] = { name: spell, description: 'Guide blood through damaged vessels to heal a living ally.',
      kind: 'utility', effect: 'mend', level: 1, stat: 'INT', dice: '1d6', bonus: 1 };
    healer.state.inventory.push({ ...baseItem('tonic', 'Ruby Temple Tonic', 'consumable'), healing: 6, quantity: 1 });
    f.db.prepare('UPDATE members SET sheet=?,state=? WHERE id=?').run(JSON.stringify(healer.character), JSON.stringify(healer.state), healer.id);
    const scene = f.game.snapshot(f.campaign.id, f.host.id).scene;
    scene.npcs = { ...scene.npcs, tavin: { id: 'tavin', name: 'Tavin Reed', aliases: [], status: 'alive',
      locationId: memberScene(scene, healer.id).location.id!, allegiance: null, fact: 'Tavin is wounded.' } };
    f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), f.campaign.id);
    const turnId = f.submit(Object.fromEntries(f.members.map((m) => [m.character.name,
      m.id === healer.id ? 'I help healing Tavin using Blood magic, with my newly learned skills' : ''])));
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    const state = snapshot.members.find((m) => m.id === healer.id)!.state;
    expect(state.abilityUses?.[spell]).toBe(1);
    expect(state.inventory.find((item) => item.id === 'tonic')?.quantity).toBe(1);
    expect(snapshot.history.find((turn) => turn.id === turnId)!.result!.narration).not.toContain('Ruby Temple Tonic');
    const draft = JSON.parse((f.db.prepare('SELECT draft FROM turns WHERE id=?').get(turnId) as { draft: string }).draft);
    expect(draft.adjudication.actions.find((a: { memberId: string }) => a.memberId === healer.id).components.minor).toBeNull();
    expect(draft.scene.npcs.tavin.treatment.sourceName).toBe(spell);
  } finally { f.db.close(); }
});

it('appends independent investigations without crossing their answer indexes and narrates both clues in two requests', async () => {
  const answer = "The survivors have little food. The challenge is 'Who keeps the road?' and response 'The last traveler.'";
  const otherAnswer = 'The shrine door is identified by its blue-tiled lintel.';
  const f = await table((c, call) => {
    const request = investigate(c, false);
    if (call === 1) return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output:
      c.members.map((actor, index) => ({ type: 'function_call', name: 'investigate', call_id: `notice-${index}`,
        arguments: JSON.stringify({ ...request, memberId: actor.id,
          source: { ...request.source, id: `new:notice-${index}`, name: `Rescue notice ${index}`, locationId: memberScene(c.scene, actor.id).location.id! },
          preparation: { id: 'rescue', appendDiscoveries: [index ? otherAnswer : answer] }, answer: 0,
          success: { text: 'The notice explains: {{finding}} {{lead}}', lead: { fact: 'The notice remains available here.', locationId: memberScene(c.scene, actor.id).location.id! } },
          failure: { ...request.failure, lead: { fact: 'The notice remains available here.', locationId: memberScene(c.scene, actor.id).location.id! } },
        }),
      })) } })}\n\n`);
    return { version: 3, summary: 'The notices identify the rescue challenge and shrine.',
      beats: c.members.map((actor) => ({ kind: 'investigate', actor: actor.id })) };
  });
  try {
    const actor = f.members.find((m) => m.character.name === 'Moryan')!;
    const memory = [{ id: 'rescue', locationId: memberScene(f.game.snapshot(f.campaign.id, f.host.id).scene, actor.id).location.id!,
      cause: 'PRIVATE: the stranded expedition prepared a challenge.', discoveries: ['The expedition is stranded below.'],
      actors: 'The mapmaker.', nextChange: 'The notice remains visible.', status: 'open', dueTurn: null }];
    f.db.prepare('UPDATE campaigns SET gm_memory=? WHERE id=?').run(JSON.stringify(memory), f.campaign.id);
    const turnId = f.submit(Object.fromEntries(f.members.map((m) => [m.character.name, 'Read the rescue notice.'])));
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    const narration = snapshot.history.find((turn) => turn.id === turnId)!.result!.narration;
    expect(narration.split(answer)).toHaveLength(2);
    expect(narration.split(otherAnswer)).toHaveLength(2);
    expect(narration).not.toContain('PRIVATE');
    const draft = JSON.parse((f.db.prepare('SELECT draft FROM turns WHERE id=?').get(turnId) as { draft: string }).draft);
    expect(draft.gmMemory.find((n: { id: string }) => n.id === 'rescue')).toMatchObject({
      cause: memory[0].cause, discoveries: [memory[0].discoveries[0], answer, otherAnswer], revealed: [1, 2],
    });
  } finally { f.db.close(); }
});

it.each([true, false])('honors frozen social stakes and preserves them across replay (success=%s)', async (success) => {
  const goal = { intent: 'Get a bowl in exchange for a blessing', success: 'The innkeeper accepts the blessing and serves Moryan one bowl of soup.' };
  const f = await table((c, call) => {
    const actor = c.members.find((m) => m.character.name === 'Moryan')!;
    const check = { memberId: actor.id, stat: 'CHA', dc: 10, mode: 'normal', lethal: false,
      circumstances: { favorable: false, adverse: false }, reason: 'Moryan offers a blessing in exchange for soup.', goal } as const;
    if (call === 1) return toolResponse('roll_check', check);
    expect(() => f.game.roll(f.campaign.id, c.turn.id, { ...check, goal: { ...goal, success: 'The innkeeper gives away the whole inn.' } }))
      .toThrow(/locked/);
    return { version: 3, summary: success && call > 2 ? goal.success : 'The innkeeper refuses.', beats: [{
      kind: 'act', actor: 'Moryan', fact: success && call > 2 || !success && call === 2 ? '{{success}}' : 'The innkeeper refuses the barter.',
      text: success && call > 2 ? 'After considering the blessing, {{success}}' : 'The innkeeper asks for copper instead.',
    }] };
  });
  try {
    f.draw.mockImplementation((sides) => sides === 20 ? success ? 20 : 1 : 1);
    const turnId = f.submit(Object.fromEntries(f.members.map((m) => [m.character.name,
      m.character.name === 'Moryan' ? 'Convince the innkeeper to accept a blessing in exchange for soup.' : ''])));
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(f.draw.mock.calls.filter(([sides]) => sides === 20)).toHaveLength(1);
    const done = snapshot.history.find((turn) => turn.id === turnId)!;
    expect(done.rolls[0].goal).toEqual(goal);
    if (success) {
      expect(done.result!.narration.split(goal.success)).toHaveLength(2);
      expect(done.result!.journal).toContainEqual(expect.objectContaining({ detail: goal.success }));
    } else {
      expect(done.result!.narration).not.toContain(goal.success);
      expect(done.result!.journal.some((entry) => entry.detail === goal.success)).toBe(false);
    }
  } finally { f.db.close(); }
});

it('checkpoints independent travel and a failed roll while a healing tool is unresolved, then retries only the unfinished work', async () => {
  const spell = "Anatomist's Mercy";
  const destination = randomUUID();
  let failHealing = true;
  let resumed: Awaited<ReturnType<NonNullable<GameMaster['adjudicate']>>> | undefined;
  const f = await table((c, call) => {
    const healer = c.members.find((m) => m.character.name === 'Moryan')!;
    const traveler = c.members.find((m) => m.character.name === 'Lobsterano')!;
    const reader = c.members.find((m) => m.character.name === 'Katooluman')!;
    const healing = { memberId: 'Moryan', targetId: 'Tavin Reed', abilityName: spell, itemId: null };
    if (call === 1) return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [
      { type: 'function_call', name: 'roll_check', call_id: 'saved-mark-check', arguments: JSON.stringify({
        memberId: reader.id, stat: 'INT', dc: 20, mode: 'normal', lethal: false, reason: 'Decipher the faded painted mark.',
      }) },
      { type: 'function_call', name: 'use_resource', call_id: 'unfinished-heal', arguments: JSON.stringify(healing) },
    ] } })}\n\n`);
    if (call <= 3 || call === 5) return toolResponse('use_resource', healing);
    if (call === 4) return { version: 3, summary: 'The traveler reaches the side room; the mark remains illegible.', beats: [
      { kind: 'move', actor: traveler.id, to: destination, fact: 'Lobsterano reaches Recovery Room.', text: 'Lobsterano reaches Recovery Room.' },
      { kind: 'act', actor: reader.id, fact: 'Katooluman cannot decipher the faded painted mark.', text: 'The faded mark remains illegible.' },
    ] };
    return { version: 2, turnId: c.turn.id, events: [],
      actions: adjudicationInput(c).schemaExample.actions.filter((a) => a.memberId === healer.id) };
  }, { scene: tower.scene as Scene, journal: tower.journal,
    members: [...tower.members, { id: randomUUID(), name: 'Lobsterano', action: 'Go to Recovery Room.' }] });
  try {
    const heal = f.provider.adjudicate!;
    f.provider.adjudicate = async (c, t) => {
      const use = t.useResource!;
      t.useResource = (input) => {
        if (failHealing) throw new Error('Temporary healing processing failure.');
        return use(input);
      };
      return resumed = await heal(c, t);
    };
    const healer = f.members.find((m) => m.character.name === 'Moryan')!;
    const traveler = f.members.find((m) => m.character.name === 'Lobsterano')!;
    healer.character.abilities[1] = { name: spell, description: 'Heal a living ally through blood magic.',
      kind: 'utility', effect: 'mend', level: 1, stat: 'INT', dice: '1d6', bonus: 1 };
    f.db.prepare('UPDATE members SET sheet=? WHERE id=?').run(JSON.stringify(healer.character), healer.id);
    const scene = f.game.snapshot(f.campaign.id, f.host.id).scene;
    const origin = memberScene(scene, traveler.id).location.id!;
    scene.places![destination] = { location: { id: destination, name: 'Recovery Room', atmosphere: 'An empty side room.', hazard: '' },
      encounter: null, loot: [], encounterRisk: { danger: 'safe', reason: 'A sheltered room.' } };
    scene.worldMap!.nodes[destination] = { id: destination, name: 'Recovery Room', visited: true };
    scene.worldMap!.connections.push({ from: origin, to: destination, label: 'Open doorway', blocked: false, bidirectional: true });
    scene.npcs = { ...scene.npcs, tavin: { id: 'tavin', name: 'Tavin Reed', aliases: [], status: 'alive',
      locationId: memberScene(scene, healer.id).location.id!, allegiance: null, fact: 'Tavin is wounded.' } };
    f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), f.campaign.id);
    const turnId = f.submit({ Moryan: 'Heal Tavin using Blood magic.', Lobsterano: 'Go to Recovery Room.', Katooluman: 'Decipher the faded painted mark.' });
    await f.game.idle();
    let snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase).toBe('failed');
    expect(snapshot.turn?.error).toContain('saved dice and resources');
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    const finalRequest = JSON.parse(f.fetcher.mock.calls[3][1]!.body as string);
    expect(finalRequest.tools).toBeUndefined();
    const saved = () => JSON.parse((f.db.prepare('SELECT draft FROM turns WHERE id=?').get(turnId) as { draft: string }).draft);
    const partial = saved().partialAdjudication;
    const travel = partial.actions.find((a: { memberId: string }) => a.memberId === traveler.id);
    expect(travel.components.movement.status).toBe('success');
    expect(partial.actions.find((a: { memberId: string }) => a.memberId === healer.id).components.main.processingFailure).toBe(true);
    expect(saved().members.find((m: { id: string }) => m.id === healer.id).state.abilityUses[spell]).toBeUndefined();
    const rolls = f.db.prepare('SELECT * FROM rolls WHERE turn_id=? ORDER BY rowid').all(turnId);
    expect(rolls).toHaveLength(1);
    const diceBefore = f.draw.mock.calls.filter(([sides]) => sides === 20).length;
    failHealing = false;
    f.game.retry(f.campaign.id, f.host.id);
    await f.game.idle();
    snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    const feedback = (f.db.prepare("SELECT payload FROM events WHERE turn_id=? AND kind='stage:adjudication' ORDER BY id DESC LIMIT 1").get(turnId) as { payload: string }).payload;
    for (const action of partial.actions) for (const phase of ['main', 'minor', 'movement'] as const) {
      const component = action.components[phase];
      if (component && !component.processingFailure)
        expect(resumed!.actions.find((a) => a.memberId === action.memberId)?.components[phase], feedback).toEqual(component);
    }
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(f.fetcher).toHaveBeenCalledTimes(7);
    expect(f.db.prepare('SELECT * FROM rolls WHERE turn_id=? ORDER BY rowid').all(turnId).filter((row: any) => !JSON.parse(row.result).notation)).toEqual(rolls);
    expect(f.draw.mock.calls.filter(([sides]) => sides === 20)).toHaveLength(diceBefore);
    expect(saved().adjudication.actions.find((a: { memberId: string }) => a.memberId === traveler.id).components).toEqual(travel.components);
    expect(snapshot.members.find((m) => m.id === healer.id)!.state.abilityUses?.[spell]).toBe(1);
    expect(memberScene(snapshot.scene, traveler.id).location.id).toBe(destination);
    expect(snapshot.history.find((turn) => turn.id === turnId)!.result!.narration).not.toContain('processing failure');
  } finally { f.db.close(); }
});
