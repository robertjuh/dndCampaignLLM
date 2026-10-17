import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { reconcileLavaPlaytest } from '../scripts/reconcile-lava-playtest';

it('audits the exact wrench once and refuses a correction after player submission', () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      'CREATE TABLE campaigns(id TEXT,scene TEXT,version INTEGER); CREATE TABLE turns(id TEXT,campaign_id TEXT,number INTEGER,phase TEXT,draft TEXT); CREATE TABLE actions(turn_id TEXT); CREATE TABLE members(campaign_id TEXT,sheet TEXT,state TEXT); CREATE TABLE journal(campaign_id TEXT,kind TEXT,name TEXT,detail TEXT,item_id TEXT); CREATE TABLE events(campaign_id TEXT,turn_id TEXT,kind TEXT,payload TEXT);',
    );
    const campaignId = '3a28cd6a-8bd6-43f7-a0da-477c9c2293e7';
    const itemId = 'dfbf8f40-f9a0-4eb8-b22f-d2c0d89a96c5';
    const scene = JSON.stringify({ memberLocations: { lava: 'hall', ferrum: 'hall' }, loot: [], places: {} });
    const state = JSON.stringify({
      inventory: [{ id: itemId, name: 'Drukregelaarssleutel', quantity: 1 }],
      equipment: {},
    });
    const stale =
      'In een onderhoudskast van de oude leidingkamer ligt een zware, hittebestendige Drukregelaarssleutel. Deze past op de oude afsluiters en drukregelaars van het leidingstelsel in de Breukschacht; de sleutel is nog niet meegenomen.';
    db.prepare('INSERT INTO campaigns VALUES(?,?,?)').run(campaignId, scene, 0);
    db.prepare('INSERT INTO turns VALUES(?,?,?,?,?)').run('fresh', campaignId, 16, 'collecting', null);
    db.prepare('INSERT INTO members VALUES(?,?,?)').run(
      campaignId,
      JSON.stringify({ name: 'Lava man' }),
      state,
    );
    db.prepare('INSERT INTO journal VALUES(?,?,?,?,?)').run(
      campaignId,
      'fact',
      'Drukregelaarssleutel',
      stale,
      null,
    );
    expect(reconcileLavaPlaytest(db)).toMatchObject({ applied: false, changed: true, holder: 'Lava man' });
    expect(db.prepare('SELECT detail FROM journal').get()).toEqual({ detail: stale });
    expect(reconcileLavaPlaytest(db, true)).toMatchObject({ applied: true, changed: true });
    expect(reconcileLavaPlaytest(db, true).changed).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT scene FROM campaigns').get()).toEqual({ scene });
    expect(db.prepare('SELECT state FROM members').get()).toEqual({ state });
    db.prepare('INSERT INTO actions VALUES(?)').run('fresh');
    expect(() => reconcileLavaPlaytest(db, true)).toThrow('no submissions');
  } finally {
    db.close();
  }
});
