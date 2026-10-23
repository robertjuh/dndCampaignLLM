import Database from 'better-sqlite3';
import { chmodSync, closeSync, openSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { DB } from '../server/db';
import type { NPCState, Scene } from '../shared/schema';
import type { Quest } from '../shared/quests';
import { questDefinitionSchema } from '../shared/quests';

const campaignId = 'bfe51b49-aff8-43f5-a385-0f0c3c80a7ec';
const pendingId = 'a70b8c3e-b193-40e9-b3e6-df5af0c7a594';
const repairId = 'akoedabar-public-people-and-request-v1';
const expectedVersion = 27;
const at = {
  bar: 'c3f7fe1e-e4ef-4210-81e9-e1bc9f969ac6',
  garage: '5de41eae-5967-495c-863b-51b08d1b96a6',
  docks: 'c5fcbc87-cd8a-4e52-a087-d9dc1b43885e',
  canal: '0627d09e-3ad3-460a-bcba-d49e3ff99a83',
  wreck: '45055e61-526c-4968-bf6b-af1db594ea47',
};
const caseId = 'a47126a5-afeb-4e60-be72-b2324293f356';
const caseName = 'Mammago Salvage Tool Case';
const caseSource = 'wreck-interior:tool-case';
const evidence = [
  {
    number: 1,
    id: 'd706d433-f9c1-47d3-b528-54e78b779c5a',
    snippets: [
      'The bartender polishes a glass',
      'a Mammago mechanic has been asking around for a tool case lost in a shallow wreck',
    ],
    events: [{ locationRef: at.bar, fact: 'A Mammago mechanic has been asking around for a lost tool case' }],
  },
  {
    number: 2,
    id: '9c007858-626d-44c5-8a64-aa494509780c',
    snippets: [
      'A grease-smudged mechanic',
      'Bring the case back here and I’ll make sure the crew hears about it.',
      'I saw them pull Tavi aside during a cargo inspection after the late shift.',
      'walked Tavi toward the manifest office',
    ],
    events: [
      { locationRef: at.garage, fact: 'learns the salvage job is still open' },
      { locationRef: at.docks, fact: 'the coworker is present among the dock crews' },
    ],
  },
  {
    number: 3,
    id: '13747a40-15a1-4acd-9204-d57343a4c89a',
    snippets: ['The mechanic wipes grease from his hands', 'The case was last seen inside'],
    events: [
      {
        locationRef: at.garage,
        fact: 'The mechanic confirms it was last seen in a shallow wreck beyond the Outer Piers.',
      },
    ],
  },
  {
    number: 6,
    id: '160db0c7-812e-47e2-959b-260a93757027',
    snippets: ['A skiff pilot lowers their voice to mention Tavi'],
    events: [{ locationRef: at.canal, fact: 'A delivery skiff pilot mentions that dock crews are uneasy' }],
  },
  {
    number: 7,
    id: '392e768a-9f17-4ba8-a1c6-e6626c249905',
    snippets: [
      'The pilot laughs softly',
      'they’re still on shift down at the Landing Docks',
      'blue-striped cargo skiff',
      caseName,
    ],
    events: [
      {
        locationRef: at.canal,
        fact: "The pilot knows Tavi's coworker and says the witness is still working at the Landing Docks",
      },
      {
        locationRef: at.wreck,
        fact: 'Lobsterano searches the flooded interior and finds the Mammago Salvage Tool Case.',
      },
    ],
  },
];

/** Restore only audited public identities and an unaccepted request; no turn or mechanics are replayed. */
export function reconcileAkoedabarPlaytest(db: DB, apply = false) {
  return db.transaction(() => {
    const campaign = db.prepare('SELECT scene,version FROM campaigns WHERE id=?').get(campaignId) as
      { scene: string; version: number } | undefined;
    const turns = db
      .prepare('SELECT id,number,phase,result,draft FROM turns WHERE campaign_id=? ORDER BY number')
      .all(campaignId) as {
      id: string;
      number: number;
      phase: string;
      result: string | null;
      draft: string | null;
    }[];
    const pending = turns.at(-1);
    if (
      !campaign ||
      turns.length !== 9 ||
      pending?.id !== pendingId ||
      pending.number !== 8 ||
      pending.phase !== 'collecting' ||
      pending.draft !== null ||
      turns.slice(0, -1).some((turn, index) => turn.number !== index || turn.phase !== 'complete')
    )
      throw new Error(
        'Repair requires audited akoedabar turn 8 to remain collecting without a draft, after completed turns 0–7.',
      );
    if ((db.prepare('SELECT count(*) AS n FROM rolls WHERE turn_id=?').get(pendingId) as { n: number }).n)
      throw new Error('The pending turn already contains dice; do not reconcile frozen mechanics.');
    for (const proof of evidence) {
      const turn = turns[proof.number];
      const narration = turn.result && JSON.parse(turn.result).narration;
      const events = turn.draft && JSON.parse(turn.draft).adjudication?.events;
      if (
        turn.id !== proof.id ||
        typeof narration !== 'string' ||
        !Array.isArray(events) ||
        proof.snippets.some((snippet) => !narration.includes(snippet)) ||
        proof.events.some(
          (required) =>
            !events.some(
              (event: { kind: string; locationRef?: string; fact: string }) =>
                ['world', 'action'].includes(event.kind) &&
                event.locationRef === required.locationRef &&
                event.fact.includes(required.fact),
            ),
        )
      )
        throw new Error(`Published turn ${proof.number} differs from the audited public evidence.`);
    }
    const scene: Scene = JSON.parse(campaign.scene);
    const places = [scene, ...Object.values(scene.places ?? {})];
    for (const [id, name] of [
      [at.bar, 'Akuda Bar'],
      [at.garage, 'Mammago Garage'],
      [at.docks, 'Hillys City Landing Docks'],
      [at.canal, 'Hillys City Canal Walk'],
      [at.wreck, 'Wreck Interior'],
    ])
      if (!places.some((place) => place.location.id === id && place.location.name === name))
        throw new Error('The saved locations differ from the audited playtest.');
    const source = JSON.parse(turns[7].draft!).receipts?.loot;
    const cases = places
      .flatMap((place) => place.loot.map((item) => ({ item, at: place.location.id })))
      .filter(({ item }) => item.id === caseId || item.sourceId === caseSource);
    if (
      source?.locationId !== at.wreck ||
      source?.sourceId !== caseSource ||
      source?.item?.id !== caseId ||
      source.item.name !== caseName ||
      source.item.kind !== 'tool' ||
      source.item.sourceId !== caseSource ||
      cases.length !== 1 ||
      cases[0].at !== at.wreck ||
      !isDeepStrictEqual(cases[0].item, { ...source.item, quantity: 1 }) ||
      places.find((place) => place.location.id === at.wreck)?.searchedLoot?.[caseSource] !== caseName
    )
      throw new Error('The audited generated tool case is no longer unchanged on the Wreck Interior ground.');
    for (const row of db.prepare('SELECT state FROM members WHERE campaign_id=?').all(campaignId) as {
      state: string;
    }[]) {
      const state = JSON.parse(row.state);
      if (
        [...(state.inventory ?? []), ...Object.values(state.equipment ?? {})].some(
          (item: any) => item && (item.id === caseId || item.sourceId === caseSource),
        )
      )
        throw new Error('A player already owns the requested case; this audited repair no longer applies.');
    }
    const person = (
      id: string,
      name: string,
      aliases: string[],
      locationId: string,
      fact: string,
    ): NPCState => ({ id, name, aliases, locationId, status: 'alive', allegiance: null, fact });
    const npcs = [
      person(
        'new:akuda-bartender',
        'Akuda Bar bartender',
        ['Akuda bartender', 'bartender'],
        at.bar,
        'The bartender at Akuda Bar reported that a Mammago mechanic was seeking a lost tool case from a shallow wreck.',
      ),
      person(
        'new:mammago-mechanic',
        'Mammago Garage mechanic',
        ['Mammago mechanic', 'grease-smudged mechanic'],
        at.garage,
        'The Mammago Garage mechanic asked for the lost case from the shallow wreck beyond the Outer Piers and promised to make sure the crew hears about its return.',
      ),
      person(
        'new:tavi-coworker-witness',
        'Tavi’s coworker witness',
        ['Tavi’s coworker', "Tavi's coworker", 'firsthand dock witness'],
        at.docks,
        'Tavi’s coworker witnessed an official cargo inspection divert Tavi toward the manifest office after the late shift. The witness remains among the Landing Docks crews.',
      ),
      person(
        'new:canal-delivery-skiff-pilot',
        'Canal Walk delivery-skiff pilot',
        ['Canal Walk pilot', 'delivery skiff pilot', 'skiff pilot'],
        at.canal,
        'The delivery-skiff pilot on Hillys City Canal Walk knows Tavi’s coworker and reported that the inspection used a blue-striped cargo skiff; its destination was not recorded.',
      ),
    ];
    const mechanic = npcs[1];
    const definition = questDefinitionSchema.parse({
      id: 'mammago-tool-case-retrieval',
      name: 'Return the Mammago tool case',
      description:
        'The Mammago Garage mechanic asked for the lost tool case from the shallow wreck beyond the Outer Piers to be returned to the garage.',
      giverId: mechanic.id,
      recipientId: mechanic.id,
      objectives: [
        {
          id: 'return-case',
          description: 'Bring the Mammago Salvage Tool Case back to the Mammago Garage mechanic.',
          condition: { kind: 'deliver', sourceId: caseSource, quantity: 1 },
        },
      ],
      reward: {
        description: 'The mechanic will make sure the crew hears about the returned case.',
        currency: 0,
        items: [],
        access: [],
      },
    });
    const quest: Quest = { ...definition, status: 'offered', offeredTurn: 2, progress: {}, priorDeaths: [] };
    const proposedNPCs = Object.fromEntries(npcs.map((npc) => [npc.id, npc]));
    const proposedQuests = { [quest.id]: quest };
    const audits = (
      db
        .prepare("SELECT payload FROM events WHERE campaign_id=? AND kind='playtest_reconciled'")
        .all(campaignId) as { payload: string }[]
    ).filter((row) => JSON.parse(row.payload).repairId === repairId);
    if (
      campaign.version === expectedVersion + 1 &&
      audits.length === 1 &&
      isDeepStrictEqual(scene.npcs, proposedNPCs) &&
      isDeepStrictEqual(scene.quests, proposedQuests)
    )
      return { applied: false, alreadyCorrect: true, repairId, campaignId, turn: 8 };
    if (
      campaign.version !== expectedVersion ||
      audits.length ||
      Object.keys(scene.npcs ?? {}).length ||
      Object.keys(scene.quests ?? {}).length
    )
      throw new Error('The campaign version, people, or requests changed since this repair was audited.');
    scene.npcs = proposedNPCs;
    scene.quests = proposedQuests;
    const summary = {
      applied: apply,
      repairId,
      campaignId,
      turn: 8,
      versionBefore: expectedVersion,
      versionAfter: expectedVersion + 1,
      npcs: npcs.map(({ id, name, locationId }) => ({ id, name, locationId })),
      quest: {
        id: quest.id,
        status: quest.status,
        giverId: quest.giverId,
        recipientId: quest.recipientId,
        sourceId: caseSource,
        consequence: quest.reward.description,
      },
      itemId: caseId,
      evidence: evidence.map(({ number, snippets }) => ({ turn: number, snippets })),
    };
    if (apply) {
      if (
        !db
          .prepare(
            "UPDATE campaigns SET scene=?,version=version+1 WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM turns WHERE id=? AND campaign_id=? AND number=8 AND phase='collecting' AND draft IS NULL)",
          )
          .run(JSON.stringify(scene), campaignId, expectedVersion, pendingId, campaignId).changes
      )
        throw new Error('The campaign or pending turn changed during repair.');
      db.prepare('INSERT INTO events(campaign_id,turn_id,kind,payload) VALUES(?,?,?,?)').run(
        campaignId,
        pendingId,
        'playtest_reconciled',
        JSON.stringify(summary),
      );
    }
    return summary;
  })();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const filename = process.argv[2];
  if (!filename)
    throw new Error(
      'Usage: node --import tsx scripts/reconcile-akoedabar-playtest.ts data/gather.sqlite [--apply]',
    );
  const apply = process.argv.includes('--apply');
  const db = new Database(filename, { readonly: !apply, fileMustExist: true });
  try {
    const preview = reconcileAkoedabarPlaytest(db);
    if (apply && !('alreadyCorrect' in preview)) {
      const backup = `${filename}.before-akoedabar-public-bookkeeping-${Date.now()}.sqlite`;
      closeSync(openSync(backup, 'wx', 0o600));
      await db.backup(backup);
      chmodSync(backup, 0o600);
      console.log(JSON.stringify({ backup }));
    }
    console.log(JSON.stringify(apply ? reconcileAkoedabarPlaytest(db, true) : preview));
  } catch (error) {
    console.error(
      JSON.stringify({
        applied: false,
        blocked: true,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
