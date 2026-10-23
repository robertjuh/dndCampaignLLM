import type { Snapshot } from '../shared/schema';
import { questStatusLabel } from '../shared/quests';

export function QuestJournal({ snapshot }: { snapshot: Snapshot }) {
  const quests = Object.values(snapshot.scene.quests ?? {});
  const dutch = snapshot.config.language === 'Nederlands';
  if (!quests.length) return null;
  const person = (id: string) => snapshot.scene.npcs?.[id]?.name ?? id;
  return (
    <section className="group-requests" aria-label={dutch ? 'Groepsopdrachten' : 'Group requests'}>
      <h2>{dutch ? 'Groepsopdrachten' : 'Group requests'}</h2>
      {quests.map((quest) => (
        <article key={quest.id}>
          <span className="eyebrow">{questStatusLabel(quest.status, dutch)}</span>
          <h3>{quest.name}</h3>
          <p className="small">
            {dutch ? 'Opdrachtgever' : 'Giver'}: {person(quest.giverId)} ·{' '}
            {dutch ? 'Inleveren bij' : 'Turn in to'}: {person(quest.recipientId)}
          </p>
          <p>{quest.description}</p>
          <ul>
            {quest.objectives.map((objective) => {
              const progress = quest.progress[objective.id];
              const c = objective.condition;
              const total = c.kind === 'hunt' ? c.count : c.kind === 'deliver' ? c.quantity : 1;
              return (
                <li key={objective.id}>
                  {progress?.complete ? '✓ ' : ''}
                  {objective.description} ({progress?.current ?? 0}/{total})
                </li>
              );
            })}
          </ul>
          <p>
            <strong>{dutch ? 'Afgesproken beloning' : 'Agreed reward'}:</strong> {quest.reward.description}
          </p>
          {quest.deadlineDescription && <p className="small">{quest.deadlineDescription}</p>}
          {quest.failureReason && <p>{quest.failureReason}</p>}
          {quest.status === 'ready' && (
            <p className="small">
              {dutch
                ? 'De doelen zijn bereikt. Verslag en overdracht gebeuren via een normaal gesprek.'
                : 'The objectives are met. Reporting and handing over items happen through normal conversation.'}
            </p>
          )}
        </article>
      ))}
    </section>
  );
}
