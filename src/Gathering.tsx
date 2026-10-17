import type { Snapshot } from '../shared/schema';
import { memberScene, placeScene } from '../shared/locations';
import { gatheringRoute } from '../shared/gathering';
import { isInCombat } from '../shared/rules';

export function Gathering({
  snapshot: s,
  canAct,
  busy,
  controls,
  command,
}: {
  snapshot: Snapshot;
  canAct: boolean;
  busy: boolean;
  controls: boolean;
  command: (path: string, body: object) => Promise<unknown>;
}) {
  const dutch = s.config.language === 'Nederlands';
  const gathering = s.scene.gathering;
  const me = s.members.find((member) => member.id === s.myMemberId);
  const place = me && memberScene(s.scene, me.id);
  const fighting = me && place && isInCombat(place, me.state);
  const mine = s.turn?.actions.find((action) => action.memberId === me?.id);
  const arrived = place?.location.id === gathering?.locationId;
  const route = gathering && place && gatheringRoute(s.scene, place.location.id!, gathering.locationId);
  if (!gathering && !controls) return null;
  const meeting = gathering && placeScene(s.scene, gathering.locationId).location;
  const caller = s.members.find((member) => member.id === gathering?.memberId);
  return (
    <section className="gathering-panel" aria-label={dutch ? 'Bijeenkomst' : 'Gathering'}>
      <h3>{dutch ? 'Samenkomen' : 'Gather together'}</h3>
      {gathering && (
        <>
          <p>
            <b>{meeting?.name}</b>
            <br />
            <span className="muted">
              {dutch ? 'Oproep van' : 'Called by'}{' '}
              {caller?.character.name ?? (dutch ? 'een reisgenoot' : 'a companion')}
            </span>
          </p>
          <ul>
            {s.members
              .filter((member) => member.active)
              .map((member) => {
                const local = memberScene(s.scene, member.id);
                const joined = s.turn?.actions.some(
                  (action) => action.memberId === member.id && action.gathering?.id === gathering.id,
                );
                const status = isInCombat(local, member.state)
                  ? 'In combat'
                  : local.location.id === gathering.locationId
                    ? dutch
                      ? 'Aangekomen'
                      : 'Arrived'
                    : joined
                      ? dutch
                        ? 'Onderweg'
                        : 'Travelling'
                      : dutch
                        ? 'Niet aangesloten'
                        : 'Not joined';
                return (
                  <li key={member.id}>
                    {member.character.name} <span className="muted">· {status}</span>
                  </li>
                );
              })}
          </ul>
          {controls && !arrived && (
            <button
              type="button"
              className="button"
              disabled={!canAct || busy || !!mine || !!fighting || !route || s.paused}
              onClick={() => command('gathering/join', { turnId: s.turn!.id, gatheringId: gathering.id })}
            >
              {dutch ? 'Aansluiten' : 'Join gathering'}
            </button>
          )}
          {controls && (
            <p className="muted">
              {fighting
                ? dutch
                  ? 'Verlaat of voltooi combat voordat je aansluit.'
                  : 'Leave or finish combat before joining.'
                : !arrived && !route
                  ? dutch
                    ? 'Geen bekende open route buiten combat.'
                    : 'No known open route outside combat.'
                  : dutch
                    ? 'Reizen kost je hele beurt en stopt bij gevaar. Bekende vrije routes kunnen meerdere locaties omvatten.'
                    : 'Travel uses your whole turn and stops for danger. Clear known routes can cross several locations.'}
            </p>
          )}
        </>
      )}
      {controls && (
        <button
          type="button"
          className="button secondary"
          disabled={!canAct || busy || !!fighting || s.paused}
          onClick={() => command('gathering', { turnId: s.turn!.id })}
        >
          {dutch ? 'Hier samenkomen' : 'Gather here'}
        </button>
      )}
    </section>
  );
}
