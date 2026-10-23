import type { GMContext } from './game';
import type { SceneTurn } from './scene-turn';
import type { TurnAdjudication } from '../shared/turn-resolution';
import { knownLocations, memberScene } from '../shared/locations';
import { submittedTravel, gatheringOptions, travelNextHop } from './world-map';
import { gmMemorySchema } from '../shared/gm-memory';

const key = (text: string) => text.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

/** A journey is private preparation with engine-counted travel, not a second quest system. */
export function applySceneJourneys(context: GMContext, scene: SceneTurn, value: TurnAdjudication) {
  const saved = context.gmMemory ?? [];
  const notes = (value.gmNotes ??= []);
  for (const note of notes) {
    const previous = saved.find((old) => old.id === note.id);
    if (
      previous?.journey &&
      (note.journey?.remainingStages !== previous.journey.remainingStages ||
        JSON.stringify(note.journey?.delays ?? []) !== JSON.stringify(previous.journey.delays ?? []) ||
        note.status !== previous.status)
    )
      throw new Error(
        `Journey ${note.id}: remaining stages, delays and completion are engine-owned; omit them from updates.`,
      );
    if (note.journey && !previous?.journey) {
      if (
        note.journey.remainingStages < 1 ||
        note.journey.delays?.length ||
        note.journey.cancelled ||
        note.status !== 'open'
      )
        throw new Error(
          'A new journey needs a positive finite remainingStages and open status, without invented delay receipts.',
        );
      if (
        !scene.beats.some(
          (beat) =>
            (beat.kind === 'move' || beat.kind === 'gather') &&
            beat.actor === note.journey!.memberId &&
            beat.journeyId === note.id,
        )
      )
        throw new Error(
          'Prepare an accepted journey on its actor’s submitted move/gather with journeyId; an opening cannot choose a player commitment.',
        );
      // A model estimate cannot make already mapped geography impossible to finish.
      const known = knownLocations(context.scene);
      const goals = Object.keys(known).filter((id) => key(known[id]) === key(note.journey!.destination));
      if (goals.length === 1) {
        let cursor = memberScene(context.scene, note.journey.memberId).location.id!;
        for (let distance = 1; distance <= Object.keys(known).length; distance++) {
          const next = travelNextHop(context.scene, cursor, goals[0]);
          if (!next) break;
          if (next === goals[0]) {
            note.journey.remainingStages = Math.max(note.journey.remainingStages, distance);
            break;
          }
          cursor = next;
        }
      }
    }
  }
  const all = new Map([...saved, ...notes].map((note) => [note.id, note]));
  const save = (note: NonNullable<GMContext['gmMemory']>[number]) => {
    const index = notes.findIndex((item) => item.id === note.id);
    if (index === -1) notes.push(note);
    else notes[index] = note;
    all.set(note.id, note);
  };
  const names = {
    ...knownLocations(context.scene),
    ...Object.fromEntries((value.mapUpdates?.locations ?? []).map((place) => [place.ref, place.name])),
    ...Object.fromEntries((value.placeUpdates ?? []).map((place) => [place.ref, place.location.name])),
  };
  for (const beat of scene.beats) {
    if (beat.kind === 'act' && beat.endJourney) {
      const note = all.get(beat.endJourney);
      const action = context.turn.actions.find((action) => action.memberId === beat.actor);
      const text = (action?.text ?? '').replace(/"[^"\n]*"|“[^”\n]*”/gu, '');
      const cancelling =
        /\b(?:abandon|cancel|give up|stop following|stop travelling|stop traveling|leave the caravan|leave the cart|annuleer|geef op|stop met volgen|verlaat de karavaan)\b/i.test(
          text,
        ) && !/\b(?:not|never|don't|won't|niet|nooit|if|als)\b/i.test(text);
      if (
        !note?.journey ||
        note.journey.memberId !== beat.actor ||
        note.status !== 'open' ||
        !cancelling ||
        action?.passed
      )
        throw new Error(
          'endJourney requires that actor’s explicit submitted abandonment of their open journey.',
        );
      save({
        ...structuredClone(note),
        status: 'resolved',
        dueTurn: null,
        nextChange: beat.fact,
        journey: { ...note.journey, cancelled: true },
      });
      continue;
    }
    if (beat.kind !== 'move' && beat.kind !== 'gather') continue;
    const onward = submittedTravel(context, beat.actor);
    const active = [...all.values()].find(
      (note) => note.status === 'open' && note.journey?.memberId === beat.actor,
    );
    const submitted = context.turn.actions.find((action) => action.memberId === beat.actor);
    const position = value.memberLocations?.find((position) => position.memberId === beat.actor);
    const directed = onward && 'goalId' in onward && onward.goalId ? names[onward.goalId] : undefined;
    const journeyId =
      beat.journeyId ??
      (active &&
      ((onward && 'onward' in onward) ||
        key(names[position?.locationId ?? ''] ?? '') === key(active.journey!.destination) ||
        (directed && key(directed) === key(active.journey!.destination)))
        ? active.id
        : undefined);
    if (!journeyId) {
      if (
        onward &&
        'onward' in onward &&
        (active || /\b(?:cart|caravan|wagon|kar|wagen|karavaan)\b/i.test(submitted?.text ?? ''))
      )
        throw new Error(
          `Onward travel needs journeyId and finite preparation in notes.journey:{memberId,destination,completion,remainingStages}. ${active ? `Reuse ${active.id}.` : 'Establish the destination consistently with the fiction.'}`,
        );
      if (beat.journeyDelay) throw new Error('A journeyDelay needs its journeyId.');
      continue; // An unrelated player-chosen detour neither spends nor resets the accepted journey.
    }
    const prepared = all.get(journeyId);
    if (active && active.id !== journeyId)
      throw new Error(
        'Reuse the actor’s open journey; do not reset its destination or stages under a new ID.',
      );
    if (!prepared?.journey || prepared.journey.memberId !== beat.actor || prepared.status !== 'open')
      throw new Error('journeyId must reference this actor’s open prepared journey.');
    const note = structuredClone(prepared);
    const journey = note.journey!;
    const move = value.memberLocations?.find((position) => position.memberId === beat.actor);
    const event = value.events.find((event) => event.id === move?.movementEventId);
    if (!move || event?.result !== 'success') {
      if (beat.journeyDelay)
        throw new Error('A failed or blocked crossing does not spend stages or extend a route.');
      continue;
    }
    const from = memberScene(context.scene, beat.actor).location.id!;
    const to = move.locationId === 'current' ? context.scene.location.id! : move.locationId;
    if (beat.journeyDelay) {
      const delay = beat.journeyDelay;
      const evidence = value.events.find(
        (item) =>
          item.kind === 'world' &&
          item.locationRef === from &&
          item.sequence < event.sequence &&
          key(item.fact) === key(delay.reason),
      );
      const closure = value.mapUpdates?.connections.some(
        (edge) =>
          edge.eventId === evidence?.id &&
          edge.blocked &&
          (edge.from === from || edge.to === from) &&
          context.scene.worldMap?.connections.some(
            (old) =>
              !old.blocked &&
              ((old.from === edge.from && old.to === edge.to) ||
                (old.from === edge.to && old.to === edge.from)),
          ),
      );
      if (!evidence || !closure || (journey.delays ?? []).some((old) => key(old) === key(delay.reason)))
        throw new Error(
          'Extending a journey needs a new witnessed local change before travel: a saved route becoming blocked or an established feature changing, with the exact world fact as journeyDelay.reason. Repeated scenery is not a delay.',
        );
      journey.remainingStages += delay.extraStages;
      journey.delays = [...(journey.delays ?? []), delay.reason];
    }
    const destinations = Object.entries(names).filter(([, name]) => key(name) === key(journey.destination));
    if (destinations.length > 1)
      throw new Error(
        'The journey destination name must identify one place; distinguish the places before travelling.',
      );
    const arrived = key(names[to] ?? '') === key(journey.destination);
    const stages = submitted?.gathering
      ? gatheringOptions(context, value, (id) => id, event.id)[beat.actor].path.indexOf(to)
      : 1;
    const remaining = Math.max(0, journey.remainingStages - Math.max(1, stages));
    if (!arrived && remaining === 0)
      throw new Error(
        `Journey ${note.id} must now reach ${journey.destination}. Preserve real routes; do not add another equivalent stage. A concrete changed obstacle can support journeyDelay, never teleportation.`,
      );
    journey.remainingStages = arrived ? 0 : remaining;
    note.status = arrived ? 'resolved' : 'open';
    note.locationId = to;
    if (arrived) note.dueTurn = null;
    save(note);
  }
  gmMemorySchema.parse(notes);
}
