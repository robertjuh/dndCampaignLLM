import { expect, it } from 'vitest';
import saved from './fixtures/vaal-gathering.json';
import { reconcileVaalPlaytest } from '../scripts/reconcile-vaal-playtest';
import { openDatabase } from '../server/db';
import { initialState } from '../shared/rules';
import { templateCharacter } from '../shared/schema';

it('repairs only proven VAAL omissions, preserving pending mechanics and completed turns, and is idempotent', () => {
  const db = openDatabase(':memory:');
  try {
    const campaign = '381914b0-bcfc-454f-b50a-e4b77eef3a15';
    const xulath = saved.members.find((member) => member.name === 'Xulath')!;
    const scene = structuredClone(saved.scene);
    const members = saved.members.map((member) => {
      const character = templateCharacter(member.name);
      const state = initialState(character, member.id);
      db.prepare('INSERT INTO players(id) VALUES(?)').run(member.id);
      db.prepare('INSERT INTO characters(id,owner_id,sheet) VALUES(?,?,?)').run(
        member.id,
        member.id,
        JSON.stringify(character),
      );
      return { id: member.id, character, state };
    });
    db.prepare(
      'INSERT INTO campaigns(id,owner_id,code,display_token,config,status,version,scene) VALUES(?,?,?,?,?,?,?,?)',
    ).run(campaign, members[0].id, 'VAALTEST', 'display', '{}', 'active', 83, JSON.stringify(scene));
    for (const member of members)
      db.prepare(
        'INSERT INTO members(id,campaign_id,player_id,character_id,sheet,state) VALUES(?,?,?,?,?,?)',
      ).run(
        member.id,
        campaign,
        member.id,
        member.id,
        JSON.stringify(member.character),
        JSON.stringify(member.state),
      );
    const oldScene = structuredClone(scene);
    oldScene.memberLocations[xulath.id as keyof typeof oldScene.memberLocations] = Object.values(oldScene.places).find(
      (place) => place.location.name === 'The Inner Sanctuary',
    )!.location.id;
    const draft = {
      members,
      startingMembers: structuredClone(members),
      scene,
      context: { members: structuredClone(members), scene: structuredClone(scene) },
      receipts: saved.receipts,
      partialAdjudication: saved.partial,
    };
    const insert = db.prepare(
      'INSERT INTO turns(id,campaign_id,number,phase,roster,result,draft) VALUES(?,?,?,?,?,?,?)',
    );
    insert.run(
      'turn5',
      campaign,
      5,
      'complete',
      '[]',
      JSON.stringify({ narration: 'Xulath takes the notice and presents himself for consultation.' }),
      JSON.stringify({ context: { scene: oldScene } }),
    );
    insert.run(
      'turn25',
      campaign,
      25,
      'complete',
      '[]',
      JSON.stringify({ narration: 'Oren’s wagons continue north.' }),
      '{}',
    );
    insert.run(
      saved.turn.id,
      campaign,
      26,
      'failed',
      JSON.stringify(members.map((member) => member.id)),
      null,
      JSON.stringify(draft),
    );
    db.prepare('INSERT INTO rolls VALUES(?,?,?,?,?)').run(
      'saved-roll',
      saved.turn.id,
      'check',
      '{}',
      JSON.stringify(saved.turn.rolls[0]),
    );
    const completed = db.prepare("SELECT * FROM turns WHERE phase='complete'").all();
    const rolls = db.prepare('SELECT * FROM rolls').all();
    expect(reconcileVaalPlaytest(db)).toMatchObject({
      applied: false,
      restoredItem: 'Private consultation notice',
    });
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
    expect(reconcileVaalPlaytest(db, true)).toMatchObject({ applied: true });
    expect(reconcileVaalPlaytest(db, true)).toMatchObject({ applied: false, alreadyCorrect: true });
    const actual = JSON.parse((db.prepare('SELECT scene FROM campaigns').get() as { scene: string }).scene);
    const escort = saved.members.find((member) => member.id !== xulath.id)!;
    const oren = Object.values(actual.npcs).find((npc: any) => npc.name === 'Oren Vask');
    expect(oren).toMatchObject({
      followingMemberId: escort.id,
      locationId: scene.memberLocations[escort.id as keyof typeof scene.memberLocations],
    });
    expect(Object.values(actual.npcs).find((npc: any) => npc.name === 'Tovek')).toEqual(
      Object.values(scene.npcs).find((npc) => npc.name === 'Tovek'),
    );
    const after = JSON.parse(
      (db.prepare('SELECT draft FROM turns WHERE id=?').get(saved.turn.id) as { draft: string }).draft,
    );
    expect(after.partialAdjudication).toEqual(saved.partial);
    expect(
      after.members
        .find((member: any) => member.id === xulath.id)
        .state.inventory.filter((item: any) => item.name === 'Private consultation notice'),
    ).toHaveLength(1);
    expect(db.prepare('SELECT * FROM rolls').all()).toEqual(rolls);
    expect(db.prepare("SELECT * FROM turns WHERE phase='complete'").all()).toEqual(completed);
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});
