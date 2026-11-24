import { useEffect, useRef, useState } from 'react';
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
  initialState,
  modifier,
  availableAbilities,
  abilityUseKey,
  shieldBlockSides,
  abilityBonus,
  abilityDice,
  isHealingAbility,
  isRally,
  effectiveStats,
  defense,
  startingEquipmentPreview,
  itemAttributes,
} from '../shared/rules';
import { conditionDuration, ailmentRules } from '../shared/ailments';
import { perkAmount, perkDescription, perkNames, type ArmourPerk } from '../shared/equipment-perks';
import { ItemBonus } from './ItemBonus';
import { GeneratedIcon, loadGeneratedImage } from './GeneratedIcon';

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
const perkIcons: Record<ArmourPerk, LucideIcon> = {
  reinforced: Shield,
  thorns: Sword,
  bulwark: ShieldPlus,
  vigilant: Zap,
  'escape-artist': Footprints,
  recuperating: Heart,
  scrambler: Footprints,
  quickstep: Footprints,
  enduring: Shield,
  rescuer: Users,
  restorative: Heart,
  'opening-strike': Crosshair,
  retaliator: RotateCcw,
  opportunist: Crosshair,
  'last-stand': ShieldPlus,
  fortified: Shield,
  hardy: Heart,
};

export function ItemIcon({ kind, iconId, size = 32 }: Pick<Item, 'kind' | 'iconId'> & { size?: 32 | 64 }) {
  const Icon = itemIcons[kind];
  return (
    <GeneratedIcon
      iconId={iconId}
      size={size}
      fallback={<Icon className="item-icon" size={16} aria-hidden="true" focusable="false" />}
    />
  );
}

function AbilityIcon({ ability }: { ability: Ability }) {
  const Icon = ability.kind === 'utility' ? Sparkles :
    isHealingAbility(ability) ? Heart : ability.effect === 'strike' ? Zap : Shield;
  return (
    <GeneratedIcon
      iconId={ability.iconId}
      size={64}
      fallback={<Icon className="item-icon" size={16} aria-hidden="true" />}
    />
  );
}

export function ItemDetails({
  item,
  compact = false,
  currencyName = 'currency',
}: {
  item: Item;
  compact?: boolean;
  currencyName?: string;
}) {
  const requirements = stats
    .filter((stat) => item.requirements[stat] > 0)
    .map((stat) => `${item.requirements[stat]} ${stat}`)
    .join(', ');
  const details = [
    item.rarity,
    item.kind,
    item.currencyValue
      ? `${item.currencyValue} ${currencyName} · Added to your balance when collected`
      : item.kind === 'tool' && 'Story item · Carried in your backpack',
    item.kind === 'weapon' &&
      `Innate dice + ${item.damage}${item.scaling.length ? ` + 2 × ${item.scaling.join('/')} modifier` : ''} damage (minimum 1)`,
    item.kind === 'armour' && item.scaling.length > 0 && `${item.scaling.join('/')} defense`,
    ['weapon', 'shield', 'focus'].includes(item.kind) && item.hands === 2 && 'Two-handed',
    item.light && 'Light',
    requirements && `Requires ${requirements} in base attributes`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <small>{details}</small>
      <div className="item-bonuses" aria-label={`${item.name} bonuses`}>
        {item.defense > 0 && (
          <ItemBonus
            icon={Shield}
            label={`+${item.defense} defense`}
            description={`Adds +${item.defense} defense while equipped, making enemy attacks less likely to hit. Defense bonuses from distinct pieces stack.`}
          />
        )}
        {itemAttributes(item).map(([stat, amount]) => (
          <ItemBonus
            key={stat}
            icon={Sparkles}
            label={`${amount > 0 ? '+' : '−'}${Math.abs(amount)} ${stat}`}
            description={`${amount > 0 ? '+' : '−'}${Math.abs(amount)} ${stat} while equipped. Changes the attribute used for attacks, checks and derived statistics. Equipment bonuses and penalties stack; equal bonuses and penalties cancel. Equipment requirements use base attributes.`}
          />
        ))}
        {item.perk && (
          <ItemBonus
            icon={perkIcons[item.perk]}
            label={`${perkNames[item.perk]} +${perkAmount(item)}`}
            description={perkDescription(item)}
          />
        )}
        {item.kind === 'shield' && (
          <ItemBonus
            icon={ShieldPlus}
            label={`1d${shieldBlockSides(item.rarity)} block`}
            description={`1d${shieldBlockSides(item.rarity)} block per enemy hit while equipped (including critical hits); each shield rolls once, reducing damage to a minimum of 0; disabled while Stunned, Frozen or Electrocuted. Does not block hazards or ongoing ailments. A fully blocked hit can still inflict an ailment.`}
          />
        )}
        {item.healing > 0 && (
          <ItemBonus
            icon={Heart}
            label={`Heal ${item.healing} HP`}
            description={`Heal ${item.healing} HP, up to the target's maximum HP. A healing consumable is spent on use; using it on an ally costs your main action.`}
          />
        )}
        {item.attackBonus > 0 && (
          <ItemBonus
            icon={Crosshair}
            label={`+${item.attackBonus} ${item.scaling.join('/')} attack`}
            description={`+${item.attackBonus} ${item.scaling.join('/')} attack rolls while equipped. Applies to attacks using a matching scaling attribute. Distinct equipped pieces stack.`}
          />
        )}
        {item.checkBonus > 0 && (
          <ItemBonus
            icon={Sparkles}
            label={`+${item.checkBonus} ${item.scaling.join('/')} checks`}
            description={`+${item.checkBonus} ${item.scaling.join('/')} out-of-combat checks while equipped. Distinct equipped pieces stack.`}
          />
        )}
        {item.immunities?.map((ailment) => (
          <ItemBonus
            key={ailment}
            icon={Shield}
            label={`Immune to ${ailment}`}
            description={`Immune to ${ailment} while equipped: prevents its application and ongoing effects. Normally: ${ailmentRules[ailment].mechanic} Multiple copies of the same immunity protect against the same ailment.`}
          />
        ))}
        {item.onHit && (
          <ItemBonus
            icon={Zap}
            label={`${item.onHit.ailment} on hit`}
            description={`${item.onHit.chance}% chance to inflict ${item.onHit.ailment} on ${item.kind === 'focus' ? `matching ${item.scaling.join('/')} main attacks` : 'weapon hits (100% on critical hits)'}. ${ailmentRules[item.onHit.ailment].mechanic}`}
          />
        )}
        {item.grantedAbility && (
          <ItemBonus
            icon={WandSparkles}
            label={`Grants ${item.grantedAbility.name}`}
            description={`Grants ${item.grantedAbility.name} while equipped · ${abilityMechanics(item.grantedAbility)}. One charge returns after a successful encounter; re-equipping does not refresh it.`}
          />
        )}
        {item.initiativePenalty < 0 && (
          <ItemBonus
            icon={Clock3}
            label={`${item.initiativePenalty} initiative`}
            description={`${item.initiativePenalty} initiative while equipped. Changes your position in the combat turn order; penalties and bonuses from distinct pieces stack.`}
          />
        )}
      </div>
      {item.description &&
        !item.currencyValue &&
        (compact ? (
          <details className="item-description">
            <summary>Description</summary>
            <p>{item.description}</p>
          </details>
        ) : (
          <small>{item.description}</small>
        ))}
      {item.storyHook && <small>Story connection: {item.storyHook}</small>}
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
          <h4 className="icon-heading">
            <AbilityIcon ability={ability} /><span>{ability.name}</span>
          </h4>
          {ability.equipmentId && <small>Granted by equipped Legendary gear</small>}
          <AbilityDetails ability={ability} scores={state ? effectiveStats(state) : character.stats} />
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
  const before = state ?? initialState({ ...character, selectedEquipmentIds: [] }, 'preview');
  if (selected.length) {
    try {
      preview = structuredClone(before);
      preview.starterEquipment = items;
      preview = startingEquipmentPreview(character, preview, selected);
    } catch (error) {
      preview = null;
      previewError = (error as Error).message;
    }
  }
  const groups =
    items.length === 5
      ? [{ label: 'Starting equipment', items, limit: 2 }]
      : [
          { label: 'Weapons', items: items.filter((item) => item.kind === 'weapon'), limit: 1 },
          { label: 'Non-weapon equipment', items: items.filter((item) => item.kind !== 'weapon'), limit: 2 },
        ];
  return (
    <section className="equipment-selection">
      <h3>Choose your starting equipment</h3>
      <p className="muted small">
        {items.length === 5 ? 'Select 2 of 5 pieces.' : 'Choose 1 of 2 weapons and 2 of 5 non-weapon pieces.'}{' '}
        Spare items that share an equipment slot go in your backpack.
      </p>
      {groups.map((group) => (
        <div key={group.label} role="group" aria-label={group.label}>
          <h4>
            {group.label} · {group.items.filter((item) => selected.includes(item.id)).length}/{group.limit}{' '}
            selected
          </h4>
          <div className="equipment-choices">
            {group.items.map((item) => (
              <div className="equipment-choice" key={item.id}>
                <button
                  type="button"
                  className="equipment-choice-select"
                  aria-pressed={selected.includes(item.id)}
                  disabled={
                    disabled ||
                    (!selected.includes(item.id) &&
                      group.limit > 1 &&
                      group.items.filter((item) => selected.includes(item.id)).length >= group.limit)
                  }
                  onClick={() =>
                    onChange(
                      selected.includes(item.id)
                        ? selected.filter((id) => id !== item.id)
                        : [
                            ...selected.filter(
                              (id) => group.limit !== 1 || !group.items.some((item) => item.id === id),
                            ),
                            item.id,
                          ],
                    )
                  }
                >
                  <b className="icon-heading">
                    <ItemIcon kind={item.kind} iconId={item.iconId} size={64} />
                    <span>{item.name}</span>
                  </b>
                  <span>{selected.includes(item.id) ? 'Selected' : 'Choose piece'}</span>
                </button>
                <ItemDetails item={item} />
              </div>
            ))}
          </div>
        </div>
      ))}
      {preview && (
        <div className="starting-loadout" aria-label="Starting loadout preview">
          <b>Your starting loadout</b>
          <p>
            Total Defense: {defense(character, before)} → {defense(character, preview)}
          </p>
          {stats
            .filter((stat) => effectiveStats(before)[stat] !== effectiveStats(preview!)[stat])
            .map((stat) => (
              <p key={stat}>
                {stat}: {effectiveStats(before)[stat]} → {effectiveStats(preview!)[stat]}
              </p>
            ))}
          {slots
            .filter(
              (slot) =>
                preview!.equipment[slot] && !(slot === 'left' && preview!.equipment.left?.hands === 2),
            )
            .map((slot) => (
              <p key={slot}>
                <ItemIcon
                  kind={preview!.equipment[slot]!.kind}
                  iconId={preview!.equipment[slot]!.iconId}
                />
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
                <ItemIcon kind={item.kind} iconId={item.iconId} />
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
                    <b className="icon-heading">
                      <AbilityIcon ability={ability} /><span>{ability.name}</span>
                    </b>
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
  const [ready, setReady] = useState<string>();
  const element = useRef<HTMLSpanElement>(null);
  const url = character.portraitId ? `/api/portraits/${character.portraitId}` : undefined;
  useEffect(() => {
    if (!url || !element.current) return;
    let disposed = false;
    const load = () => {
      void loadGeneratedImage(url).then((ok) => {
        if (ok && !disposed) setReady(url);
      });
    };
    // Journal pages can contain many NPCs; generate portraits only as they approach the viewport.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        load();
      }
    }, { rootMargin: '150px' });
    observer.observe(element.current);
    return () => { disposed = true; observer.disconnect(); };
  }, [url]);
  return (
    <span ref={element} className={`avatar ${size}`} title={character.name}>
      {url && ready === url ? (
        <img
          src={url}
          alt={`${character.name} portrait`}
          width={96}
          height={96}
          loading="lazy"
          onError={() => setReady(undefined)}
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
