import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { DB } from '../server/db';
import type { Scene, Character, CharacterState } from '../shared/schema';
import { baseItem, offerGroundItem, takeItem } from '../shared/rules';
import { placeScene, savePlace } from '../shared/locations';
import { isDeepStrictEqual } from 'node:util';

const campaignId = '381914b0-bcfc-454f-b50a-e4b77eef3a15';
const turnId = '572bdf38-f30a-4c2a-b4fb-b882ffd033d4';
const escortId = 'eddc3a7d-66d8-4fe0-8d8f-bc73c93a4caa';
const xulathId = '202c897b-1900-4c68-a169-096ee422b11b';
const sourceId = 'private-consultation-notice';
const noticeName = 'Private consultation notice';

/** Correct two proven omissions in the audited save without advancing a turn or rewriting history. */
export function reconcileVaalPlaytest(db: DB, apply = false) {
  return db.transaction(() => {
    const campaign = db.prepare('SELECT scene,version FROM campaigns WHERE id=?').get(campaignId) as {
      scene: string;
      version: number;
    };
    const pending = db
      .prepare("SELECT id,number,phase,draft FROM turns WHERE campaign_id=? AND phase!='complete'")
      .get(campaignId) as { id: string; number: number; phase: string; draft: string };
    const evidence = db
      .prepare(
        "SELECT number,result,draft FROM turns WHERE campaign_id=? AND phase='complete' AND number IN (5,25) ORDER BY number",
      )
      .all(campaignId) as { number: number; result: string; draft: string }[];
    if (
      !campaign ||
      pending?.id !== turnId ||
      pending.number !== 26 ||
      pending.phase !== 'failed' ||
      evidence.length !== 2
    )
      throw new Error(
        'Repair requires the audited VAAL turn 26 to remain failed with published turns 5 and 25.',
      );
    const draft = JSON.parse(pending.draft);
    if (draft.adjudication || draft.resolution || draft.narration)
      throw new Error('Do not rewrite an accepted or finalized turn.');
    const collected = JSON.parse(evidence[0].result).narration as string;
    const travelling = JSON.parse(evidence[1].result).narration as string;
    if (
      !collected.includes('Xulath takes the notice') ||
      !travelling.includes('Oren’s wagons continue north')
    )
      throw new Error('Published collection and caravan evidence differs from the audited playtest.');
    const scene: Scene = JSON.parse(campaign.scene);
    const destination = scene.memberLocations?.[escortId];
    if (!destination || placeScene(scene, destination).location.name !== 'Far North Road')
      throw new Error('The escort has moved since this repair was audited.');
    const origin = JSON.parse(evidence[0].draft).context.scene.memberLocations[xulathId] as string;
    const hex = createHash('sha256').update(`${origin}:${sourceId}`).digest('hex');
    const noticeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    const member = db
      .prepare('SELECT sheet,state FROM members WHERE id=? AND campaign_id=?')
      .get(xulathId, campaignId) as { sheet: string; state: string };
    const character: Character = JSON.parse(member.sheet);
    const state: CharacterState = JSON.parse(member.state);
    const beforeState = structuredClone(state);
    const previous = Object.values(scene.npcs ?? {}).find((npc) => npc.name === 'Oren Vask');
    if (
      !previous ||
      previous.status !== 'alive' ||
      (previous.followingMemberId && previous.followingMemberId !== escortId)
    )
      throw new Error('Oren’s identity or travel relationship has changed.');
    const already =
      previous.locationId === destination &&
      previous.followingMemberId === escortId &&
      state.inventory.some((item) => item.id === noticeId);
    if (already) return { applied: false, alreadyCorrect: true, campaignId, turn: 26 };
    if (!state.inventory.some((item) => item.id === noticeId)) {
      const ground = structuredClone(placeScene(scene, origin));
      offerGroundItem(ground, {
        ...baseItem(noticeId, noticeName, 'tool'),
        description:
          'A discreet paper notice offering private medical consultations through the screened eastern ritual court.',
      });
      takeItem(character, state, ground, noticeId);
    }
    const fixScene = (saved: Scene) => {
      const oren = Object.values(saved.npcs ?? {}).find((npc) => npc.id === previous.id);
      if (!oren || oren.status !== 'alive') throw new Error('A checkpoint has a different Oren identity.');
      oren.locationId = destination;
      oren.followingMemberId = escortId;
      oren.fact = 'Oren Vask travels north with his caravan and Gemling legionaire at Far North Road.';
      const source = placeScene(saved, origin);
      (source.searchedLoot ??= {})[sourceId] = noticeName;
      savePlace(saved, source);
    };
    fixScene(scene);
    for (const saved of [draft.scene, draft.context.scene]) fixScene(saved);
    for (const members of [draft.members, draft.startingMembers, draft.context.members]) {
      const saved = members?.find((saved: { id: string }) => saved.id === xulathId);
      if (saved) {
        if (!isDeepStrictEqual(saved.state, beforeState))
          throw new Error('A checkpoint contains different pending character mechanics.');
        saved.state = structuredClone(state);
      }
    }
    const summary = {
      applied: apply,
      campaignId,
      turn: 26,
      npc: previous.name,
      location: 'Far North Road',
      followingMemberId: escortId,
      restoredItem: noticeName,
      itemId: noticeId,
    };
    if (apply) {
      if (
        !db
          .prepare('UPDATE campaigns SET scene=?,version=version+1 WHERE id=? AND version=?')
          .run(JSON.stringify(scene), campaignId, campaign.version).changes
      )
        throw new Error('The campaign changed during repair.');
      db.prepare('UPDATE members SET state=? WHERE id=?').run(JSON.stringify(state), xulathId);
      db.prepare('UPDATE turns SET draft=? WHERE id=?').run(JSON.stringify(draft), turnId);
      db.prepare('INSERT INTO events(campaign_id,turn_id,kind,payload) VALUES(?,?,?,?)').run(
        campaignId,
        turnId,
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
      'Usage: node --import tsx scripts/reconcile-vaal-playtest.ts data/gather.sqlite [--apply]',
    );
  const apply = process.argv.includes('--apply');
  const db = new Database(filename, { readonly: !apply, fileMustExist: true });
  try {
    const preview = reconcileVaalPlaytest(db);
    if (apply && !('alreadyCorrect' in preview)) {
      const backup = `${filename}.before-vaal-continuity-${Date.now()}.sqlite`;
      await db.backup(backup);
      chmodSync(backup, 0o600);
      console.log(JSON.stringify({ backup }));
    }
    console.log(JSON.stringify(apply ? reconcileVaalPlaytest(db, true) : preview));
  } finally {
    db.close();
  }
}
