import {
  FlaskConical,
  Footprints,
  Gem,
  HardHat,
  Shield,
  Shirt,
  Sword,
  WandSparkles,
  Wrench,
  Heart,
  Sparkles,
  Crosshair,
  Users,
  Clock3,
  Zap,
  RotateCcw,
  ShieldPlus,
  type LucideIcon,
} from 'lucide-react';
import { type Ability, type Character, type CharacterState, type Item, stats, slots } from '../shared/schema';
import {
  abilityMechanics,
  abilityTargets,
  abilityPowerSummary,
  characterDrawbacks,
  chooseStartingEquipment,
  initialState,
  modifier,
  availableAbilities,
  abilityUseKey,
  shieldBlockSides,
  abilityBonus,
  abilityDice,
  isHealingAbility,
  isRally,
} from '../shared/rules';
import { conditionDuration } from '../shared/ailments';

export const slotLabels = {
  left: 'Left hand',
  right: 'Right hand',
  body: 'Body',
  head: 'Head',
  boots: 'Feet',
  relic: 'Relic',
};

const itemIcons: Record<Item['kind'], LucideIcon> = {
  weapon: Sword,
  armour: Shirt,
  helmet: HardHat,
  boots: Footprints,
  shield: Shield,
  focus: WandSparkles,
  consumable: FlaskConical,
  relic: Gem,
  tool: Wrench,
};

export function ItemIcon({ kind }: { kind: Item['kind'] }) {
  const Icon = itemIcons[kind];
  return <Icon className="item-icon" size={16} aria-hidden="true" focusable="false" />;
}

export function ItemDetails({ item, compact = false, currencyName = 'currency' }: { item: Item; compact?: boolean; currencyName?: string }) {
  const requirements = stats
    .filter((stat) => item.requirements[stat] > 0)
    .map((stat) => `${item.requirements[stat]} ${stat}`)
    .join(', ');
  const details = [
    item.rarity,
    item.kind,
    item.currencyValue ? `${item.currencyValue} ${currencyName} · Added to your balance when collected` : item.kind === 'tool' && 'Story item · Carried in your backpack',
    item.kind === 'weapon' &&
      `Innate dice + ${item.damage}${item.scaling.length ? ` + 2 × ${item.scaling.join('/')} modifier` : ''} damage (minimum 1)`,
    item.kind === 'armour' && item.scaling.length > 0 && `${item.scaling.join('/')} defense`,
    item.defense > 0 && `+${item.defense} defense`,
    item.kind === 'shield' &&
      `1d${shieldBlockSides(item.rarity)} block per enemy hit while equipped (including critical hits); each shield rolls once, reducing damage to a minimum of 0; disabled while Stunned, Frozen or Electrocuted`,
    item.healing > 0 && `Heal ${item.healing} HP`,
    item.attackBonus > 0 && `+${item.attackBonus} ${item.scaling.join('/')} attack rolls while equipped`,
    item.checkBonus > 0 &&
      `+${item.checkBonus} ${item.scaling.join('/')} out-of-combat checks while equipped`,
    ['weapon', 'shield', 'focus'].includes(item.kind) && item.hands === 2 && 'Two-handed',
    item.light && 'Light',
    item.immunities?.length && `Immune to ${item.immunities.join(', ')} while equipped`,
    item.onHit &&
      `${item.onHit.chance}% chance to inflict ${item.onHit.ailment} on ${item.kind === 'focus' ? `matching ${item.scaling.join('/')} main attacks` : 'weapon hits (100% on critical hits)'}`,
    item.grantedAbility &&
      `Grants ${item.grantedAbility.name} while equipped · ${abilityMechanics(item.grantedAbility)}`,
    item.initiativePenalty < 0 && `${item.initiativePenalty} initiative`,
    requirements && `Requires ${requirements}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <small>{details}</small>
      {item.description && !item.currencyValue &&
        (compact ? (
          <details className="item-description">
            <summary>Description</summary>
            <p>{item.description}</p>
          </details>
        ) : (
          <small>{item.description}</small>
        ))}
    </>
  );
}

function AbilityDetails({ ability, scores }: { ability: Ability; scores: Character['stats'] }) {
  const utility = ability.kind === 'utility' && ability.effect === 'assist';
  const rally = isRally(ability);
  const bonus = abilityBonus(ability);
  const power = abilityPowerSummary(ability, scores);
  const Icon =
    ability.effect === 'strike'
      ? Sword
      : ability.effect === 'barrier' || ability.effect === 'guard'
        ? ShieldPlus
        : isHealingAbility(ability)
          ? Heart
          : Sparkles;
  const headline =
    power ??
    (ability.effect === 'guard'
      ? `+${3 + bonus} defense`
      : ability.effect === 'cleanse'
        ? 'Clear ailments'
        : `Advantage +${bonus}`);
  const flat = modifier(scores[ability.stat]) + bonus;
  // Preserve utility scope even when an older description mixed it with check instructions.
  const description = (
    utility ? ability.description.replace(/\badvantage and \+\d+/gi, 'advantage') : ability.description
  )
    .split(/(?<=[.!?])\s+/)
    .filter(
      (sentence) =>
        !/\b(?:noncombat obstacle|non-combat obstacle|main action|hoofdactie|uses? remaining|tracked charge)\b/i.test(
          sentence,
        ) &&
        (utility ||
          !/\b\d+d\d+\b|\b(?:attack roll|aanvalsrol)\b|\b(?:STR|DEX|INT|CHA|CON|WIS) (?:modifier|check)\b|\b(?:inflict|cure|restore|heal)\w*\b.*\b\d+\b/i.test(
            sentence,
          )),
    )
    .join(' ');
  return (
    <>
      <div className="ability-effect">
        <Icon size={21} aria-hidden="true" />
        <div>
          <strong>{headline}</strong>
          {power && (
            <small title={`${ability.stat} modifier included`}>
              {abilityDice(ability)} {flat < 0 ? '−' : '+'} {Math.abs(flat)} · {ability.stat}
            </small>
          )}
        </div>
      </div>
      <ul className="ability-tags" aria-label="Ability mechanics">
        {ability.effect === 'strike' && (
          <li>
            <Crosshair size={14} aria-hidden="true" />
            Roll to hit
          </li>
        )}
        {utility && (
          <li>
            <Sparkles size={14} aria-hidden="true" />
            {ability.stat} check
          </li>
        )}
        <li>
          <Users size={14} aria-hidden="true" />
          {abilityTargets(ability)}
        </li>
        {ability.effect === 'guard' && (
          <li>
            <Shield size={14} aria-hidden="true" />
            Until hit
          </li>
        )}
        {ability.effect === 'barrier' && (
          <li>
            <Clock3 size={14} aria-hidden="true" />
            Until your next turn
          </li>
        )}
        {rally && (
          <li>
            <Crosshair size={14} aria-hidden="true" />
            Each next attack
          </li>
        )}
        {(utility || isHealingAbility(ability)) && <li>In / out of combat</li>}
        <li>
          <Zap size={14} aria-hidden="true" />
          Main action
        </li>
      </ul>
      {ability.inflicts && (
        <p className="ability-ailment">
          {ability.inflicts} on hit · {conditionDuration(ability.inflicts)} turns
        </p>
      )}
      {ability.effect === 'restoration' ? (
        <p className="ability-ailment">Clears all ailments</p>
      ) : (
        !!ability.cures?.length && <p className="ability-ailment">Clears {ability.cures.join(' / ')}</p>
      )}
      {utility && (
        <p className="ability-help">
          Helping an ally also grants this bonus to their check. Strongest bonus applies.
        </p>
      )}
      {description && <p className="ability-description">{description}</p>}
    </>
  );
}

export function Abilities({
  character,
  state,
  inCombat = false,
  selected,
  onSelect,
  disabled = false,
}: {
  character: Character;
  state?: CharacterState;
  inCombat?: boolean;
  selected?: string | null;
  onSelect?: (name: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ability-grid">
      {availableAbilities(character, state).map((ability, i) => (
        <article className="ability-card" key={i}>
          <span className="eyebrow">
            {ability.kind === 'combat' ? 'Combat' : 'Utility'} · Level {ability.level}
          </span>
          <h4>{ability.name}</h4>
          {ability.equipmentId && <small>Granted by equipped Legendary gear</small>}
          <AbilityDetails ability={ability} scores={state?.stats ?? character.stats} />
          {state && (
            <small className="ability-uses">
              <span>
                <Zap size={14} aria-hidden="true" />
                {(state.abilityUses?.[abilityUseKey(ability)] ?? 0) >= 1 ? 0 : 1}/1 available
              </span>
              <span title="One charge returns after a successful encounter">
                <RotateCcw size={14} aria-hidden="true" />
                Recharge on encounter success
              </span>
            </small>
          )}
          {onSelect && (
            <button
              type="button"
              className="button secondary"
              aria-pressed={selected === ability.name}
              disabled={
                disabled ||
                (!inCombat &&
                  ability.kind === 'combat' &&
                  !state?.conditions.includes('Escaped') &&
                  ability.effect !== 'strike' &&
                  !isHealingAbility(ability)) ||
                (state?.abilityUses?.[abilityUseKey(ability)] ?? 0) >= 1
              }
              onClick={() => onSelect(selected === ability.name ? null : ability.name)}
            >
              {selected === ability.name ? 'Selected for your action' : 'Use ability'}
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

export function EquipmentChoices({
  character,
  state,
  items,
  selected,
  onChange,
  disabled = false,
}: {
  character: Character;
  state?: CharacterState;
  items: Item[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  let preview: CharacterState | null = null;
  let previewError = '';
  if (selected.length === 2) {
    try {
      preview = state
        ? structuredClone(state)
        : initialState({ ...character, selectedEquipmentIds: [] }, 'preview');
      preview.starterEquipment = items;
      chooseStartingEquipment(character, preview, selected);
    } catch (error) {
      preview = null;
      previewError = (error as Error).message;
    }
  }
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
            <b>
              <ItemIcon kind={item.kind} />
              {item.name}
            </b>
            <ItemDetails item={item} />
            <span>{selected.includes(item.id) ? 'Selected' : 'Choose piece'}</span>
          </button>
        ))}
      </div>
      {preview && (
        <div className="starting-loadout" aria-label="Starting loadout preview">
          <b>Your starting loadout</b>
          {slots
            .filter(
              (slot) =>
                preview!.equipment[slot] && !(slot === 'left' && preview!.equipment.left?.hands === 2),
            )
            .map((slot) => (
              <p key={slot}>
                <ItemIcon kind={preview!.equipment[slot]!.kind} />
                {(slot === 'left' || slot === 'right') && preview!.equipment[slot]!.hands === 2
                  ? 'Both hands'
                  : slotLabels[slot]}
                : {preview!.equipment[slot]!.name}
              </p>
            ))}
          {preview.inventory
            .filter((item) => selected.includes(item.id))
            .map((item) => (
              <p key={item.id}>
                <ItemIcon kind={item.kind} />
                Backpack: {item.name}
              </p>
            ))}
        </div>
      )}
      {previewError && (
        <p className="gear-reason" role="status">
          {previewError}
        </p>
      )}
    </section>
  );
}

export function AbilityChoices({
  character,
  onChange,
  disabled = false,
}: {
  character: Character;
  onChange: (abilities: Ability[]) => void;
  disabled?: boolean;
}) {
  return (
    <section className="ability-selection">
      <h3>Choose your starting abilities</h3>
      <p className="muted small">
        Select 1 of 2 in-combat abilities and 1 of 2 out-of-combat abilities · {character.abilities.length}/2
        selected.
      </p>
      {(['combat', 'utility'] as const).map((kind) => (
        <div key={kind} className="ability-choice-group">
          <h4>{kind === 'combat' ? 'In combat' : 'Out of combat'}</h4>
          <div className="ability-grid ability-choices">
            {character.abilityOptions
              ?.filter((a) => a.kind === kind)
              .map((ability) => {
                const selected = character.abilities.some((a) => a.name === ability.name);
                return (
                  <button
                    type="button"
                    className="ability-card"
                    key={ability.name}
                    aria-pressed={selected}
                    disabled={disabled}
                    onClick={() =>
                      onChange(
                        [
                          ...character.abilities.filter((a) => a.kind !== kind),
                          ...(selected ? [] : [ability]),
                        ].sort((a, b) => a.kind.localeCompare(b.kind)),
                      )
                    }
                  >
                    <b>{ability.name}</b>
                    <AbilityDetails ability={ability} scores={character.stats} />
                    <span className="ability-choice-label">{selected ? 'Selected' : 'Choose ability'}</span>
                  </button>
                );
              })}
          </div>
        </div>
      ))}
    </section>
  );
}

export function CharacterPortrait({
  character,
  size = '',
}: {
  character: Pick<Character, 'name' | 'portraitId'>;
  size?: '' | 'mini' | 'large';
}) {
  return (
    <span className={`avatar ${size}`} title={character.name}>
      {character.portraitId ? (
        <img
          src={`/api/portraits/${character.portraitId}`}
          alt={`${character.name} portrait`}
          width={96}
          height={96}
          loading="lazy"
        />
      ) : (
        character.name[0]
      )}
    </span>
  );
}

export function CharacterSheet({
  character,
  showAbilities = true,
}: {
  character: Character;
  showAbilities?: boolean;
}) {
  return (
    <article className="character-sheet">
      <header>
        {character.portraitId && <CharacterPortrait character={character} size="large" />}
        <span className="eyebrow">{character.species}</span>
        <h2>{character.name}</h2>
        <p>{character.appearance}</p>
      </header>
      {character.portraitError && (
        <p className="small muted" role="status">
          {character.portraitError}
        </p>
      )}
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
      {character.creationBonuses && (
        <section className="small creation-compensation">
          {character.creationBonuses.version === 2 && characterDrawbacks(character).length > 0 && (
            <p>
              Drawbacks:{' '}
              {characterDrawbacks(character)
                .map((d) => `${d.label} (${d.severity === 2 ? 'major' : 'minor'})`)
                .join(' · ')}
            </p>
          )}
          <p>
            Drawback compensation:{' '}
            {[
              ...stats
                .filter((stat) => character.creationBonuses!.attributes.includes(stat))
                .map((stat) => {
                  const points = character.creationBonuses!.attributes.filter((s) => s === stat).length;
                  const gain = modifier(character.stats[stat]) - modifier(character.stats[stat] - points);
                  return `+${points} ${stat}${character.creationBonuses!.version === 2 ? ` (+${gain} ${stat} modifier)` : ''}`;
                }),
              character.creationBonuses.abilityPower > 0 &&
                `+${character.creationBonuses.abilityPower} power to either combat ability`,
            ]
              .filter(Boolean)
              .join(' · ') || 'No mechanical drawbacks or compensation.'}
          </p>
        </section>
      )}
      {showAbilities && (
        <section>
          <h3>Abilities</h3>
          <Abilities character={character} />
        </section>
      )}
      <p className="small muted">
        <ItemIcon kind="consumable" />
        Starting healing item: {character.healingItemName}
      </p>
    </article>
  );
}
