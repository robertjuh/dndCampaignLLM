import { expect, it } from 'vitest';
import { reconcileAkoedabarPlaytest } from '../scripts/reconcile-akoedabar-playtest';
import { openDatabase } from '../server/db';
import { baseItem, initialScene, initialState } from '../shared/rules';
import { templateCharacter, type Scene } from '../shared/schema';

const campaignId = 'bfe51b49-aff8-43f5-a385-0f0c3c80a7ec';
const pendingId = 'a70b8c3e-b193-40e9-b3e6-df5af0c7a594';
const locations = {
  'c3f7fe1e-e4ef-4210-81e9-e1bc9f969ac6': 'Akuda Bar',
  '5de41eae-5967-495c-863b-51b08d1b96a6': 'Mammago Garage',
  'c5fcbc87-cd8a-4e52-a087-d9dc1b43885e': 'Hillys City Landing Docks',
  '0627d09e-3ad3-460a-bcba-d49e3ff99a83': 'Hillys City Canal Walk',
  '45055e61-526c-4968-bf6b-af1db594ea47': 'Wreck Interior',
};
const [bar, garage, docks, canal, wreck] = Object.keys(locations);
const item = {
  ...baseItem('a47126a5-afeb-4e60-be72-b2324293f356', 'Mammago Salvage Tool Case', 'tool'),
  sourceId: 'wreck-interior:tool-case',
};

function fixture() {
  const db = openDatabase(':memory:');
  const places = Object.entries(locations).map(([id, name]) => ({
    location: { id, name, atmosphere: 'Established place.', hazard: '' },
    encounter: null,
    loot: [],
  }));
  const scene: Scene = {
    ...initialScene('Akuda Bar'),
    ...places[0],
    npcs: {},
    places: Object.fromEntries(places.slice(1).map((place) => [place.location.id, place])),
    memberLocations: { player: wreck },
  };
  scene.places![wreck].loot = [{ ...item, quantity: 1 }];
  scene.places![wreck].searchedLoot = { [item.sourceId]: item.name };
  db.prepare('INSERT INTO players(id) VALUES(?)').run('player');
  const character = templateCharacter('Lobsterano');
  db.prepare('INSERT INTO characters(id,owner_id,sheet) VALUES(?,?,?)').run(
    'character',
    'player',
    JSON.stringify(character),
  );
  db.prepare(
    'INSERT INTO campaigns(id,owner_id,code,display_token,config,status,version,scene) VALUES(?,?,?,?,?,?,?,?)',
  ).run(campaignId, 'player', 'AKOETEST', 'display', '{}', 'active', 27, JSON.stringify(scene));
  db.prepare(
    'INSERT INTO members(id,campaign_id,player_id,character_id,sheet,state) VALUES(?,?,?,?,?,?)',
  ).run(
    'player',
    campaignId,
    'player',
    'character',
    JSON.stringify(character),
    JSON.stringify(initialState(character, 'player')),
  );
  const proof = new Map([
    [
      1,
      {
        id: 'd706d433-f9c1-47d3-b528-54e78b779c5a',
        text: 'The bartender polishes a glass and says a Mammago mechanic has been asking around for a tool case lost in a shallow wreck.',
        events: [[bar, 'A Mammago mechanic has been asking around for a lost tool case']],
      },
    ],
    [
      2,
      {
        id: '9c007858-626d-44c5-8a64-aa494509780c',
        text: 'A grease-smudged mechanic says: Bring the case back here and I’ll make sure the crew hears about it. The coworker says: I saw them pull Tavi aside during a cargo inspection after the late shift. They walked Tavi toward the manifest office.',
        events: [
          [garage, 'Lobsterano learns the salvage job is still open'],
          [docks, 'the coworker is present among the dock crews'],
        ],
      },
    ],
    [
      3,
      {
        id: '13747a40-15a1-4acd-9204-d57343a4c89a',
        text: 'The mechanic wipes grease from his hands. The case was last seen inside.',
        events: [
          [garage, 'The mechanic confirms it was last seen in a shallow wreck beyond the Outer Piers.'],
        ],
      },
    ],
    [
      6,
      {
        id: '160db0c7-812e-47e2-959b-260a93757027',
        text: 'A skiff pilot lowers their voice to mention Tavi.',
        events: [[canal, 'A delivery skiff pilot mentions that dock crews are uneasy']],
      },
    ],
    [
      7,
      {
        id: '392e768a-9f17-4ba8-a1c6-e6626c249905',
        text: 'The pilot laughs softly: they’re still on shift down at the Landing Docks. A blue-striped cargo skiff was used. Lobsterano finds the Mammago Salvage Tool Case.',
        events: [
          [
            canal,
            "The pilot knows Tavi's coworker and says the witness is still working at the Landing Docks",
          ],
          [wreck, 'Lobsterano searches the flooded interior and finds the Mammago Salvage Tool Case.'],
        ],
      },
    ],
  ]);
  const insert = db.prepare(
    'INSERT INTO turns(id,campaign_id,number,phase,roster,result,draft) VALUES(?,?,?,?,?,?,?)',
  );
  for (let number = 0; number < 8; number++) {
    const saved = proof.get(number);
    insert.run(
      saved?.id ?? `turn-${number}`,
      campaignId,
      number,
      'complete',
      '["player"]',
      JSON.stringify({ narration: saved?.text ?? 'An unchanged completed turn.', xp: 10 }),
      JSON.stringify({
        adjudication: {
          events: (saved?.events ?? []).map(([locationRef, fact]) => ({ kind: 'action', locationRef, fact })),
        },
        receipts: number === 7 ? { loot: { item, sourceId: item.sourceId, locationId: wreck } } : {},
      }),
    );
  }
  insert.run(pendingId, campaignId, 8, 'collecting', '["player"]', null, null);
  db.prepare('INSERT INTO actions(turn_id,member_id,text,passed) VALUES(?,?,?,?)').run(
    pendingId,
    'player',
    'I look at the case before deciding what to do.',
    0,
  );
  db.prepare('INSERT INTO rolls(id,turn_id,check_key,parameters,result) VALUES(?,?,?,?,?)').run(
    'existing-roll',
    proof.get(7)!.id,
    'saved-check',
    '{}',
    '{"success":true}',
  );
  return { db, scene };
}

function preserved(db: ReturnType<typeof openDatabase>) {
  return Object.fromEntries(
    ['turns', 'actions', 'rolls', 'members', 'journal'].map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
}

it('previews without writes and restores only public people and an offered request, atomically and once', () => {
  const { db, scene } = fixture();
  try {
    const before = preserved(db);
    const campaignBefore = db.prepare('SELECT * FROM campaigns').get();
    expect(reconcileAkoedabarPlaytest(db)).toMatchObject({
      applied: false,
      turn: 8,
      quest: { status: 'offered', sourceId: item.sourceId },
    });
    expect(db.prepare('SELECT * FROM campaigns').get()).toEqual(campaignBefore);
    expect(preserved(db)).toEqual(before);
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
    expect(reconcileAkoedabarPlaytest(db, true)).toMatchObject({ applied: true });
    const campaign = db.prepare('SELECT scene,version FROM campaigns').get() as {
      scene: string;
      version: number;
    };
    const actual: Scene = JSON.parse(campaign.scene);
    expect(campaign.version).toBe(28);
    const { npcs, quests, ...unchanged } = actual;
    const { npcs: originalNPCs, ...original } = scene;
    expect(originalNPCs).toEqual({});
    expect(unchanged).toEqual(original);
    expect(Object.values(npcs!)).toHaveLength(4);
    expect(Object.values(npcs!).map((npc) => npc.locationId)).toEqual([bar, garage, docks, canal]);
    expect(Object.values(npcs!).every((npc) => npc.allegiance === null && !npc.factionId)).toBe(true);
    const quest = Object.values(quests!)[0];
    expect(quest).toMatchObject({
      status: 'offered',
      offeredTurn: 2,
      progress: {},
      giverId: 'new:mammago-mechanic',
      recipientId: 'new:mammago-mechanic',
      objectives: [{ condition: { kind: 'deliver', sourceId: item.sourceId, quantity: 1 } }],
      reward: { currency: 0, items: [], access: [] },
    });
    expect(quest.acceptedTurn).toBeUndefined();
    expect(quest.completedTurn).toBeUndefined();
    expect(preserved(db)).toEqual(before);
    expect(reconcileAkoedabarPlaytest(db, true)).toMatchObject({ applied: false, alreadyCorrect: true });
    expect(db.prepare('SELECT version FROM campaigns').get()).toEqual({ version: 28 });
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});

it.each(['advanced', 'frozen', 'version', 'evidence', 'case', 'people'])(
  'refuses a changed %s checkpoint without writing',
  (change) => {
    const { db, scene } = fixture();
    try {
      if (change === 'advanced') db.prepare('UPDATE turns SET number=9 WHERE id=?').run(pendingId);
      if (change === 'frozen')
        db.prepare('UPDATE turns SET draft=? WHERE id=?').run('{"resolution":{}}', pendingId);
      if (change === 'version') db.prepare('UPDATE campaigns SET version=28').run();
      if (change === 'evidence')
        db.prepare('UPDATE turns SET result=? WHERE number=2').run('{"narration":"Changed history"}');
      if (change === 'case') scene.places![wreck].loot = [];
      if (change === 'people')
        scene.npcs = {
          other: {
            id: 'other',
            name: 'Different mechanic',
            aliases: [],
            locationId: garage,
            status: 'alive',
            allegiance: null,
            fact: 'New facts.',
          },
        };
      if (['case', 'people'].includes(change))
        db.prepare('UPDATE campaigns SET scene=?').run(JSON.stringify(scene));
      const before = preserved(db);
      const campaigns = db.prepare('SELECT * FROM campaigns').all();
      expect(() => reconcileAkoedabarPlaytest(db, true)).toThrow();
      expect(preserved(db)).toEqual(before);
      expect(db.prepare('SELECT * FROM campaigns').all()).toEqual(campaigns);
      expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  },
);

it('rolls back the metadata update when its required audit event cannot be written', () => {
  const { db } = fixture();
  try {
    const campaign = db.prepare('SELECT * FROM campaigns').get();
    db.exec(
      "CREATE TRIGGER interrupt_reconciliation BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;",
    );
    expect(() => reconcileAkoedabarPlaytest(db, true)).toThrow('audit unavailable');
    expect(db.prepare('SELECT * FROM campaigns').get()).toEqual(campaign);
  } finally {
    db.close();
  }
});
