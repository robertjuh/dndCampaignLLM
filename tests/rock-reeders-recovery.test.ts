import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { reopenRockReedersTurn } from '../scripts/reopen-rock-reeders-turn';

it('reopens only the audited empty follow-up, preserving dice and spent ability state', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE campaigns(id TEXT, scene TEXT, version INTEGER);
      CREATE TABLE turns(id TEXT, campaign_id TEXT, number INTEGER, phase TEXT, draft TEXT, result TEXT, error TEXT);
      CREATE UNIQUE INDEX pending ON turns(campaign_id) WHERE phase != 'complete';
      CREATE TABLE members(id TEXT, campaign_id TEXT, state TEXT);
      CREATE TABLE actions(turn_id TEXT);
      CREATE TABLE rolls(id TEXT, turn_id TEXT);
      CREATE TABLE events(campaign_id TEXT, turn_id TEXT, kind TEXT, payload TEXT);
    `);
    const campaignId = 'd5d44105-cc6e-4348-b397-53e5a54c5e4b';
    const turnId = '404a7b10-e172-4601-88d6-9cfa03593fbf';
    const scene = { location: { id: 'outpost' }, worldProgression: { stalled: 1 } };
    const state = { hp: 18, xp: 12, abilityUses: { Agentenobservatie: 1 } };
    const draft = {
      context: { scene: { ...scene, worldProgression: { stalled: 0 } } },
      scene,
      members: [{ id: 'actor', state }],
      startingMembers: [{ id: 'actor', state: { ...state, abilityUses: {} } }],
      receipts: { executionEvents: [], encounterChecks: {}, ailments: {} },
      adjudicationFallback: 'Adjudication stopped',
      adjudication: { journal: [], memberLocations: [] },
      resolution: { events: ['first', 'second'].map((id) => ({ id: `check:${id}`, kind: 'mechanics' })) },
      narration: {},
    };
    db.prepare('INSERT INTO campaigns VALUES(?,?,0)').run(campaignId, JSON.stringify(scene));
    db.prepare('INSERT INTO turns VALUES(?,?,?,?,?,?,NULL)').run(
      turnId,
      campaignId,
      3,
      'complete',
      JSON.stringify(draft),
      JSON.stringify({ xp: 0, currency: 0, changes: [] }),
    );
    db.prepare('INSERT INTO turns VALUES(?,?,4,?,NULL,NULL,NULL)').run('next', campaignId, 'collecting');
    db.prepare('INSERT INTO members VALUES(?,?,?)').run('actor', campaignId, JSON.stringify(state));
    for (const id of ['first', 'second']) db.prepare('INSERT INTO rolls VALUES(?,?)').run(id, turnId);
    expect(reopenRockReedersTurn(db)).toMatchObject({
      applied: false,
      preservedRollIds: ['first', 'second'],
    });
    db.prepare('INSERT INTO actions VALUES(?)').run('next');
    expect(() => reopenRockReedersTurn(db, true)).toThrow('empty collecting turn 4');
    expect(db.prepare('SELECT phase FROM turns WHERE id=?').get(turnId)).toEqual({ phase: 'complete' });
    db.prepare('DELETE FROM actions').run();
    expect(reopenRockReedersTurn(db, true).applied).toBe(true);
    const reopened = db.prepare('SELECT phase,draft,result FROM turns WHERE id=?').get(turnId) as any;
    expect(reopened.phase).toBe('failed');
    expect(reopened.result).toBeNull();
    const checkpoint = JSON.parse(reopened.draft);
    expect(checkpoint.resolution).toBeUndefined();
    expect(checkpoint.adjudication).toBeUndefined();
    expect(checkpoint.members[0].state).toEqual(state);
    expect(checkpoint.scene.worldProgression).toEqual({ stalled: 0 });
    expect(db.prepare('SELECT state FROM members').get()).toEqual({ state: JSON.stringify(state) });
    expect(db.prepare('SELECT count(*) AS n FROM rolls').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT id FROM turns').all()).toEqual([{ id: turnId }]);
    expect(() => reopenRockReedersTurn(db, true)).toThrow('audited turn 3');
  } finally {
    db.close();
  }
});
