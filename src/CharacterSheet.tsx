import { type Character, type Item, stats } from '../shared/schema';

export function ItemDetails({ item }: { item: Item }) {
  const requirements = stats
    .filter((stat) => item.requirements[stat] > 0)
    .map((stat) => `${item.requirements[stat]} ${stat}`)
    .join(', ');
  const details = [
    item.rarity,
    item.kind,
    item.kind === 'weapon' &&
      `${item.damage}${item.scaling.length ? ` + ${item.scaling.join('/')} modifier` : ''}`,
    item.kind === 'armour' && item.scaling.length > 0 && `${item.scaling.join('/')} defense`,
    item.defense > 0 && `+${item.defense} defense`,
    item.healing > 0 && `Heal ${item.healing} HP`,
    item.hands === 2 && 'Two-handed',
    item.light && 'Light',
    item.initiativePenalty < 0 && `${item.initiativePenalty} initiative`,
    requirements && `Requires ${requirements}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <small>{details}</small>
      {item.description && <small>{item.description}</small>}
    </>
  );
}

export function Abilities({ character }: { character: Character }) {
  return (
    <div className="ability-grid">
      {character.abilities.map((ability, i) => (
        <article className="ability-card" key={i}>
          <span className="eyebrow">
            {ability.kind === 'combat' ? 'In combat' : 'Out of combat'} · Level {ability.level}
          </span>
          <h4>{ability.name}</h4>
          <p>{ability.description}</p>
        </article>
      ))}
    </div>
  );
}

export function EquipmentChoices({
  items,
  selected,
  onChange,
  disabled = false,
}: {
  items: Item[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <section className="equipment-selection">
      <h3>Choose your starting equipment</h3>
      <p className="muted small">
        Select 2 of 5 pieces · {selected.length}/2 selected. Spare items that share an equipment slot go in
        your backpack.
      </p>
      <div className="equipment-choices">
        {items.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={selected.includes(item.id)}
            disabled={disabled || (!selected.includes(item.id) && selected.length === 2)}
            onClick={() =>
              onChange(
                selected.includes(item.id) ? selected.filter((id) => id !== item.id) : [...selected, item.id],
              )
            }
          >
            <b>{item.name}</b>
            <ItemDetails item={item} />
            <span>{selected.includes(item.id) ? 'Selected' : 'Choose piece'}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function CharacterSheet({ character }: { character: Character }) {
  return (
    <article className="character-sheet">
      <header>
        <span className="eyebrow">{character.species}</span>
        <h2>{character.name}</h2>
        <p>{character.appearance}</p>
      </header>
      <div className="small-stats">
        {stats.map((stat) => (
          <div key={stat}>
            <span>{stat}</span>
            <b>{character.stats[stat]}</b>
          </div>
        ))}
      </div>
      {character.background && (
        <section>
          <h3>Backstory</h3>
          <p>{character.background}</p>
        </section>
      )}
      <dl className="character-details">
        {(['personality', 'motivation', 'weakness'] as const).map(
          (key) =>
            character[key] && (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{character[key]}</dd>
              </div>
            ),
        )}
      </dl>
      <section>
        <h3>Traits</h3>
        <div className="trait-list">
          {character.traits.map((trait) => (
            <div key={trait.id}>
              <b>{trait.name}</b>
              <p>{trait.description}</p>
              <small>
                {stats
                  .filter((stat) => trait.stats[stat])
                  .map((stat) => `${trait.stats[stat] > 0 ? '+' : ''}${trait.stats[stat]} ${stat}`)
                  .join(' · ')}
              </small>
              {trait.blocked.length > 0 && <p className="small">Cannot equip: {trait.blocked.join(', ')}</p>}
              {trait.heavyRestricted && (
                <p className="small">Cannot use heavy strength weapons or plate armour.</p>
              )}
            </div>
          ))}
        </div>
      </section>
      <section>
        <h3>Abilities</h3>
        <Abilities character={character} />
      </section>
      <p className="small muted">Starting healing item: {character.healingItemName}</p>
    </article>
  );
}
