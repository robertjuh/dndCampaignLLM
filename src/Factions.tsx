import { factionAttitude, type PublicFaction } from '../shared/factions';
import type { Member } from '../shared/schema';

export function CharacterFactions({
  member,
  factions,
  dutch = false,
}: {
  member: Member;
  factions: PublicFaction[];
  dutch?: boolean;
}) {
  if (!factions.length) return null;
  const affiliation = member.state.factionAffiliation;
  return (
    <section className="faction-relations" aria-label={dutch ? 'Factierelaties' : 'Faction relationships'}>
      <h4>{dutch ? 'Factierelaties' : 'Faction relationships'}</h4>
      {factions.map((faction) => {
        const score = member.state.factionReputation?.[faction.id] ?? 0;
        const attitude = factionAttitude(score);
        return (
          <div key={faction.id}>
            <b>{faction.name}</b> ·{' '}
            {dutch
              ? { Friendly: 'Vriendelijk', Neutral: 'Neutraal', Hostile: 'Vijandig' }[attitude]
              : attitude}{' '}
            ({score > 0 ? '+' : ''}
            {score})
            {affiliation?.factionId === faction.id && (
              <p className="small">
                {dutch
                  ? {
                      member: 'Lid',
                      'former-member': 'Voormalig lid',
                      contact: 'Contact',
                      patron: 'Beschermheer',
                      debtor: 'Schuldenaar',
                    }[affiliation.kind]
                  : {
                      member: 'Member',
                      'former-member': 'Former member',
                      contact: 'Contact',
                      patron: 'Patron',
                      debtor: 'Debtor',
                    }[affiliation.kind]}
                : {affiliation.reason}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function FactionCard({
  faction,
  members,
  dutch = false,
}: {
  faction: PublicFaction;
  members: Member[];
  dutch?: boolean;
}) {
  return (
    <article className="faction-card" aria-label={`${dutch ? 'Factie' : 'Faction'}: ${faction.name}`}>
      <span className="eyebrow">{dutch ? 'Factie' : 'Faction'}</span>
      <h3>{faction.name}</h3>
      <p>{faction.knownDescription}</p>
      <ul aria-label={dutch ? 'Houding tegenover de groep' : 'Attitude toward party members'}>
        {members.map((member) => {
          const score = member.state.factionReputation?.[faction.id] ?? 0;
          const attitude = factionAttitude(score);
          return (
            <li key={member.id}>
              <b>{member.character.name}</b> ·{' '}
              {dutch
                ? { Friendly: 'Vriendelijk', Neutral: 'Neutraal', Hostile: 'Vijandig' }[attitude]
                : attitude}{' '}
              ({score > 0 ? '+' : ''}
              {score})
            </li>
          );
        })}
      </ul>
    </article>
  );
}
