import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { DB } from '../server/db';
import { combatFact } from '../server/narration';
import { occupiedPlaces } from '../shared/locations';
import { assembleResolvedNarration, narrationParagraphs } from '../shared/turn-resolution';

const campaignId = '5c859eb3-3b66-4690-827a-d757589ee726';
const turnId = 'b7985275-469a-4908-ba69-42b724ea8d81';
const knightId = '9f479705-9013-49c6-b664-ce871521cf06';
const romanoId = 'd26561b8-d075-4a6b-acdb-b0de71b3ec1e';
const followupId = '6c8a5167-175c-4caf-a369-f180a533c2d2';
const spiderId = 'operazangende-schaduwspin';
const summary =
  'De Operazangende Schaduwspin leeft nog met 5/38 HP; het combat in De Galerij van Zwarte Webnoten gaat door. De gevleugelde ridder heeft haar met de Zilverveerduelsabel verwond. Romano Banano is door de terugslag van zijn mislukte aanval gewond geraakt. Natalia the demonslayer is nog in de galerij. De gestolen vioolsnaren blijven bij de spin en zijn niet als buit vrijgekomen.';

// One proven correction: retain the original dice, damage, inventory and encounter.
export function reconcileFairySpiderPlaytest(db: DB, apply = false) {
  return db.transaction(() => {
    const campaign = db.prepare('SELECT scene FROM campaigns WHERE id = ?').get(campaignId) as
      { scene: string } | undefined;
    const pending = db
      .prepare("SELECT id, number, phase, draft FROM turns WHERE campaign_id = ? AND phase != 'complete'")
      .get(campaignId) as { id: string; number: number; phase: string; draft: string | null } | undefined;
    const latest = db
      .prepare(
        "SELECT id, number, draft, result FROM turns WHERE campaign_id = ? AND phase = 'complete' ORDER BY number DESC LIMIT 1",
      )
      .get(campaignId) as { id: string; number: number; draft: string; result: string } | undefined;
    if (
      !campaign ||
      !latest ||
      !(
        (latest.id === turnId && latest.number === 9) ||
        (latest.id === followupId && latest.number === 10)
      ) ||
      !pending ||
      pending.number !== latest.number + 1 ||
      pending.phase !== 'collecting' ||
      pending.draft
    )
      throw new Error(
        'Correction requires audited turn 9 or 10 to remain latest and the next turn collecting without a saved resolution draft.',
      );
    const original = db.prepare('SELECT draft, result FROM turns WHERE id = ?').get(turnId) as {
      draft: string;
      result: string;
    };
    const draft = JSON.parse(original.draft);
    const result = JSON.parse(original.result);
    const scene = JSON.parse(campaign.scene);
    const combat = draft.receipts.combat;
    const spider = combat.encounter.enemies.find((enemy: any) => enemy.id === spiderId);
    const currentSpider = scene.encounter?.enemies.find((enemy: any) => enemy.id === spiderId);
    const locationId = draft.context.scene.location.id;
    if (
      spider?.hp !== 5 ||
      spider.maxHp !== 38 ||
      currentSpider?.hp !== 5 ||
      combat.encounter.victory ||
      combat.encounter.escaped ||
      scene.encounter.victory ||
      draft.context.scene.encounter.enemies.find((enemy: any) => enemy.id === spiderId)?.hp !== 18 ||
      scene.location.id !== locationId ||
      JSON.stringify(scene.location) !== JSON.stringify(draft.scene.location) ||
      !draft.adjudication.events.some(
        (event: any) => event.id === 'world:3' && event.fact.includes('het combat eindigt'),
      )
    )
      throw new Error('The saved turn differs from the audited 18 - 13 = 5 HP evidence.');
    const beforeSummary = result.summary;
    const journalCorrections = draft.adjudication.journal.map((entry: any) => {
      const prior = draft.context.journal.find(
        (previous: any) => previous.kind === entry.kind && previous.name === entry.name,
      );
      const current = db
        .prepare('SELECT detail FROM journal WHERE campaign_id = ? AND kind = ? AND name = ?')
        .get(campaignId, entry.kind, entry.name) as { detail: string } | undefined;
      if (!prior || current?.detail !== entry.detail)
        throw new Error(`Journal evidence changed for ${entry.name}; review before correcting.`);
      return { kind: entry.kind, name: entry.name, before: entry.detail, after: prior.detail };
    });
    const restoreJournal = (entries: any[]) =>
      entries.map((entry) => {
        const correction = journalCorrections.find(
          (correction: any) => correction.kind === entry.kind && correction.name === entry.name,
        );
        return correction ? { ...entry, detail: correction.after } : entry;
      });
    const correctedAction = draft.adjudication.actions.find((action: any) => action.memberId === knightId);
    correctedAction.fact = correctedAction.components.main.fact;
    correctedAction.reason =
      'De engine heeft de treffer en 13 damage al verwerkt: de spin ging van 18 naar 5 HP en leeft nog.';
    correctedAction.components.main.reason = correctedAction.reason;
    draft.resolution.actions = draft.resolution.actions.map((action: any) =>
      action.memberId === knightId
        ? {
            ...action,
            fact: correctedAction.fact,
            reason: correctedAction.reason,
            components: correctedAction.components,
          }
        : action,
    );
    for (const value of [draft.adjudication, draft.resolution]) {
      value.events = value.events.filter((event: any) => !['world:3', 'world:4'].includes(event.id));
      value.journal = restoreJournal(value.journal);
    }
    for (const value of [draft.adjudication, result]) {
      value.placeUpdates = value.placeUpdates.filter((update: any) => update.ref !== locationId);
      value.journal = restoreJournal(value.journal);
    }
    draft.scene.location = { ...draft.context.scene.location };
    scene.location = { ...draft.context.scene.location };
    draft.resolution.location = draft.scene.location;
    draft.resolution.placeStates = occupiedPlaces(draft.scene);
    draft.resolution.factualRecap = [
      ...draft.resolution.events.map((event: any) => event.fact),
      `Location: ${JSON.stringify(draft.resolution.location)}.`,
      ...draft.resolution.journal.map((entry: any) => `${entry.kind} ${entry.name}: ${entry.detail}`),
    ].join('\n');
    draft.resolutionRevision = (draft.resolutionRevision ?? 0) + 1;
    draft.narration.passages = draft.narration.passages.filter(
      (passage: any) => !passage.eventIds.some((id: string) => ['world:3', 'world:4'].includes(id)),
    );
    draft.narration.summary = summary;
    draft.narrationRevision = draft.resolutionRevision;
    assembleResolvedNarration(draft.resolution, draft.narration);
    result.narration = narrationParagraphs(draft.resolution, draft.narration).join('\n\n');
    result.summary = summary;
    let followup: { draft: any; result: any } | undefined;
    let followupCorrection:
      | {
          beforeSummary: string;
          afterSummary: string;
          originalBlockedReason: string;
          originalCombatFact: string;
        }
      | undefined;
    if (latest.number === 10) {
      followup = { draft: JSON.parse(latest.draft), result: JSON.parse(latest.result) };
      const next = followup.draft;
      const input = next.receipts.combatInput.actions.find((action: any) => action.memberId === romanoId);
      const event = next.receipts.combat.events[3];
      if (
        next.receipts.combat.encounter.enemies.find((enemy: any) => enemy.id === spiderId)?.hp !== 5 ||
        next.receipts.combat.encounter.victory ||
        next.members.find((member: any) => member.id === knightId)?.state.hp !== 2 ||
        next.members.find((member: any) => member.id === romanoId)?.state.hp !== 14 ||
        event?.actorId !== romanoId ||
        event.status !== 'blocked' ||
        !input?.blockedReason?.includes('is al verslagen') ||
        !event.fact.includes(input.blockedReason) ||
        next.adjudication.journal.length ||
        next.adjudication.placeUpdates.length
      )
        throw new Error('Turn 10 differs from the audited wrongful cancellation; review before correcting.');
      const afterSummary =
        'De Operazangende Schaduwspin leeft nog met 5/38 HP en het combat gaat door. De gevleugelde ridder is door haar aanval zwaargewond geraakt en heeft 2 HP; hij is niet langer Stunned. Romano Banano heeft 14 HP. Zijn aanval is door een onjuiste doelwitbeoordeling niet uitgevoerd en zijn main action is verbruikt. Er is geen buit vrijgekomen.';
      followupCorrection = {
        beforeSummary: followup.result.summary,
        afterSummary,
        originalBlockedReason: input.blockedReason,
        originalCombatFact: event.fact,
      };
      // Keep the original planning input as evidence; correct its false explanation of the recorded block.
      event.fact =
        "Romano Banano's action has no effect: de doelwitbeoordeling was onjuist; De Operazangende Schaduwspin leeft nog met 5/38 HP. The main action is spent.";
      next.receipts.combat.logs[3] = event.fact;
      const fact = combatFact(next.context, event.fact);
      for (const value of [next.adjudication, next.resolution]) {
        value.events.find((entry: any) => entry.id === 'combat:3').fact = fact;
        const action = value.actions.find((entry: any) => entry.memberId === romanoId);
        action.fact = fact;
        action.reason =
          'De aanval is ten onrechte geblokkeerd door de eerdere onjuiste doodmelding. Er is geen aanval gerold en geen damage toegebracht; de spin leeft nog.';
        action.components.main.fact = fact;
        action.components.main.reason = action.reason;
      }
      next.receipts.executionEvents.find((entry: any) => entry.id === 'combat:3').fact = fact;
      next.scene.location = { ...draft.scene.location };
      next.resolution.location = next.scene.location;
      next.resolution.placeStates = occupiedPlaces(next.scene);
      next.resolution.factualRecap =
        next.resolution.events.map((entry: any) => entry.fact).join('\n') +
        `\nLocation: ${JSON.stringify(next.scene.location)}.`;
      next.narration.passages.find((passage: any) => passage.eventIds.includes('combat:3')).text =
        'Romano Banano zet aan om samen met de ridder toe te slaan, maar zijn aanval wordt door een onjuiste doelwitbeoordeling niet uitgevoerd. Zijn main action is verbruikt zonder treffer of damage. De Operazangende Schaduwspin leeft nog en blijft met 5/38 HP tegenover hen staan.';
      next.narration.summary = afterSummary;
      next.resolutionRevision = (next.resolutionRevision ?? 0) + 1;
      next.narrationRevision = next.resolutionRevision;
      assembleResolvedNarration(next.resolution, next.narration);
      followup.result.narration = narrationParagraphs(next.resolution, next.narration).join('\n\n');
      followup.result.summary = afterSummary;
    }
    const report = {
      campaignId,
      turnId,
      applied: apply,
      spider: { hp: 5, maxHp: 38, victory: false },
      beforeSummary,
      afterSummary: summary,
      journalCorrections,
      removedEvents: ['world:3', 'world:4'],
      followupCorrection,
      retained:
        'All rolls, damage, character state, inventory, rewards, encounter state and pending player actions.',
    };
    if (apply) {
      db.prepare('UPDATE turns SET draft = ?, result = ? WHERE id = ?').run(
        JSON.stringify(draft),
        JSON.stringify(result),
        turnId,
      );
      db.prepare('UPDATE campaigns SET scene = ?, version = version + 1 WHERE id = ?').run(
        JSON.stringify(scene),
        campaignId,
      );
      if (followup)
        db.prepare('UPDATE turns SET draft = ?, result = ? WHERE id = ?').run(
          JSON.stringify(followup.draft),
          JSON.stringify(followup.result),
          followupId,
        );
      for (const entry of journalCorrections)
        db.prepare('UPDATE journal SET detail = ? WHERE campaign_id = ? AND kind = ? AND name = ?').run(
          entry.after,
          campaignId,
          entry.kind,
          entry.name,
        );
      db.prepare('INSERT INTO events(campaign_id, turn_id, kind, payload) VALUES(?, ?, ?, ?)').run(
        campaignId,
        turnId,
        'playtest_state_correction',
        JSON.stringify(report),
      );
    }
    return report;
  })();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const filename = process.argv[2];
  if (!filename)
    throw new Error('Usage: node --import tsx scripts/reconcile-fairy-spider-playtest.ts DATABASE [--apply]');
  const apply = process.argv.includes('--apply');
  const db = new Database(filename, { readonly: !apply });
  db.pragma('busy_timeout = 5000');
  try {
    reconcileFairySpiderPlaytest(db);
    if (apply) {
      const backup = `${filename}.before-fairy-spider-correction-${Date.now()}.sqlite`;
      await db.backup(backup);
      chmodSync(backup, 0o600);
      console.log(JSON.stringify({ backup }));
    }
    console.log(JSON.stringify(reconcileFairySpiderPlaytest(db, apply), null, 2));
  } finally {
    db.close();
  }
}
