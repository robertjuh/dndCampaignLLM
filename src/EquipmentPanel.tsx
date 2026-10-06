import { useId, useState } from 'react';
import { ChevronDown, Shield } from 'lucide-react';
import { slots, stats, type Item, type Member, type Slot, type Snapshot } from '../shared/schema';
import {
  capacity,
  defense,
  equip,
  equippedItems,
  equipmentBonus,
  occupiedSlots,
  naturalWeapon,
  scaling,
  takeItem,
  unequip,
  usableSlots,
  healWithItem,
  isDead,
  canInteract,
} from '../shared/rules';
import { ItemDetails, ItemIcon, slotLabels } from './CharacterSheet';

type Manage = (body: unknown) => Promise<Snapshot | undefined>;
const signed = (value: number) => `${value >= 0 ? '+' : ''}${value}`;

function EquipmentItem({
  item,
  member,
  snapshot,
  ground = false,
  lockReason,
  healingLockReason,
  manage,
}: {
  item: Item & { quantity: number };
  member: Member;
  snapshot: Snapshot;
  ground?: boolean;
  lockReason: string;
  healingLockReason: string;
  manage: Manage;
}) {
  const [hand, setHand] = useState<Slot>();
  const [drops, setDrops] = useState<string[]>([]);
  const [healingTargetId, setHealingTargetId] = useState(member.id);
  const reasonId = useId();
  const { character, state } = member;
  const valid = usableSlots(character, state.stats, item);
  const destinations = item.hands === 2 ? valid.slice(0, 1) : valid;
  const fallback: Slot =
    item.kind === 'armour'
      ? 'body'
      : item.kind === 'helmet'
        ? 'head'
        : item.kind === 'boots'
          ? 'boots'
          : item.kind === 'relic'
            ? 'relic'
            : 'right';
  const slot =
    hand && destinations.includes(hand)
      ? hand
      : (destinations.find((slot) => !state.equipment[slot]) ?? destinations[0] ?? fallback);
  const equippable = item.kind !== 'consumable' && item.kind !== 'tool';
  const healingTargets = snapshot.members.filter(
    (ally) => ally.active && !isDead(ally.state) && canInteract(snapshot.scene, state, ally.state),
  );
  const healingTarget = healingTargets.find((ally) => ally.id === healingTargetId) ?? member;
  let healingReason = '';
  if (!ground && item.healing > 0) {
    try {
      if (healingTarget.state.hp >= healingTarget.state.maxHp) throw new Error('Already at full health.');
      healWithItem(character, structuredClone(state), item.id, {
        character: healingTarget.character,
        state: structuredClone(healingTarget.state),
      });
    } catch (error) {
      healingReason = (error as Error).message;
    }
    if (
      !healingReason &&
      healingTarget.id !== member.id &&
      (snapshot.status !== 'active' ||
        !snapshot.turn?.roster.includes(member.id) ||
        state.pendingLevelUps > 0)
    )
      healingReason = 'Healing an ally requires your action in an active turn.';
  }
  const dropIds = drops.filter((id) => state.inventory.some((item) => item.id === id));
  const next = structuredClone(state);
  let equipReason = '';
  if (equippable) {
    try {
      if (ground) takeItem(character, next, structuredClone(snapshot.scene), item.id, slot, dropIds);
      else equip(character, next, item.id, slot);
    } catch (error) {
      equipReason = (error as Error).message;
    }
  }
  let takeReason = '';
  const taken = structuredClone(state);
  if (ground) {
    try {
      takeItem(character, taken, structuredClone(snapshot.scene), item.id, undefined, dropIds);
    } catch (error) {
      takeReason = (error as Error).message;
    }
  }
  const displaced = equippedItems(state).filter(
    (item) => !equippedItems(next).some((equipped) => equipped.id === item.id),
  );
  const comparison: string[] = [];
  if (equippable && !equipReason) {
    comparison.push(
      `Backpack ${occupiedSlots(state)}/${capacity(character)} → ${occupiedSlots(next)}/${capacity(character)}`,
    );
    if (displaced.length) comparison.push(`Stows ${displaced.map((item) => item.name).join(', ')}`);
    if (defense(character, state) !== defense(character, next))
      comparison.push(`Defense ${defense(character, state)} → ${defense(character, next)}`);
    const initiative = (state: Member['state']) =>
      equippedItems(state).reduce((sum, item) => sum + item.initiativePenalty, 0);
    if (initiative(state) !== initiative(next))
      comparison.push(`Initiative penalty ${initiative(state)} → ${initiative(next)}`);
    if (item.kind === 'weapon') {
      const previous =
        [state.equipment[slot], state.equipment.right, state.equipment.left].find(
          (item) => item?.kind === 'weapon',
        ) ?? naturalWeapon(character);
      const damage = (weapon: Item, current: Member['state']) =>
        weapon.id === 'natural'
          ? `${weapon.damage} ${signed(scaling(current, weapon))}`
          : `${naturalWeapon(character).damage} + ${weapon.damage} ${signed(2 * scaling(current, weapon))}`;
      const attack = (weapon: Item, current: Member['state']) =>
        signed(
          scaling(current, weapon) +
            equipmentBonus(current, weapon.scaling.length ? weapon.scaling : ['STR'], 'attackBonus'),
        );
      comparison.push(`Weapon damage ${damage(previous, state)} → ${damage(item, next)}`);
      comparison.push(`Weapon attack ${attack(previous, state)} → ${attack(item, next)}`);
    }
    for (const stat of stats) {
      for (const kind of ['attackBonus', 'checkBonus'] as const) {
        const before = equipmentBonus(state, stat, kind);
        const after = equipmentBonus(next, stat, kind);
        if (before !== after)
          comparison.push(
            `${stat} ${kind === 'attackBonus' ? 'attack bonus' : 'check bonus'} ${signed(before)} → ${signed(after)}`,
          );
      }
    }
  }
  return (
    <article className="gear-item" aria-label={item.name}>
      <div className="gear-item-info">
        <b>
          <ItemIcon kind={item.kind} />
          {item.name} {item.quantity > 1 && <span>×{item.quantity}</span>}
        </b>
        <ItemDetails item={item} compact />
        {comparison.length > 0 && <p className="gear-preview">{comparison.join(' · ')}</p>}
        {ground && !takeReason && (
          <p className="gear-preview">
            Take into backpack: {occupiedSlots(state)}/{capacity(character)} → {occupiedSlots(taken)}/
            {capacity(character)}
          </p>
        )}
        {ground && dropIds.length > 0 && (
          <p className="gear-preview">
            Drops selected stacks:{' '}
            {state.inventory
              .filter((item) => dropIds.includes(item.id))
              .map((item) => `${item.name} ×${item.quantity}`)
              .join(', ')}
          </p>
        )}
        <div id={reasonId}>
          {equippable && equipReason && <p className="gear-reason">{equipReason}</p>}
          {ground && takeReason && takeReason !== equipReason && (
            <p className="gear-reason">Take: {takeReason}</p>
          )}
          {healingReason && <p className="gear-reason">Healing: {healingReason}</p>}
        </div>
        {ground &&
          state.inventory.length > 0 &&
          (takeReason.includes('Backpack full') ||
            equipReason.includes('Backpack full') ||
            dropIds.length > 0) && (
            <details className="make-room">
              <summary>Choose items to drop to make room</summary>
              <p>Selected stacks move to the scene only when you take this item.</p>
              {state.inventory.map((owned) => (
                <label key={owned.id}>
                  <input
                    type="checkbox"
                    checked={dropIds.includes(owned.id)}
                    disabled={!!lockReason}
                    onChange={(event) =>
                      setDrops(
                        event.target.checked
                          ? [...dropIds, owned.id]
                          : dropIds.filter((id) => id !== owned.id),
                      )
                    }
                  />
                  <ItemIcon kind={owned.kind} />
                  {owned.name} ×{owned.quantity}
                </label>
              ))}
            </details>
          )}
      </div>
      <div className="gear-actions">
        {equippable && destinations.length > 1 && (
          <label className="gear-hand">
            <span>Hand</span>
            <select
              aria-label={`Hand for ${item.name}`}
              value={slot}
              disabled={!!lockReason}
              onChange={(event) => setHand(event.target.value as Slot)}
            >
              {destinations.map((slot) => (
                <option key={slot} value={slot}>
                  {slotLabels[slot]}
                </option>
              ))}
            </select>
          </label>
        )}
        {equippable && (
          <button
            className="button secondary"
            disabled={!!lockReason || !!equipReason}
            aria-describedby={reasonId}
            onClick={() =>
              manage({
                type: ground ? 'take-equip' : 'equip',
                itemId: item.id,
                slot,
                ...(ground && dropIds.length ? { dropItemIds: dropIds } : {}),
              })
            }
          >
            {ground ? 'Take & equip' : 'Equip'}
          </button>
        )}
        {ground ? (
          <button
            className="button secondary"
            disabled={!!lockReason || !!takeReason}
            aria-describedby={reasonId}
            onClick={() =>
              manage({ type: 'take', itemId: item.id, ...(dropIds.length ? { dropItemIds: dropIds } : {}) })
            }
          >
            Take item
          </button>
        ) : (
          <>
            {item.healing > 0 && (
              <>
                <label className="gear-hand">
                  <span>Healing target</span>
                  <select
                    aria-label={`Healing target for ${item.name}`}
                    value={healingTarget.id}
                    disabled={!!healingLockReason}
                    onChange={(event) => setHealingTargetId(event.target.value)}
                  >
                    {healingTargets.map((ally) => (
                      <option key={ally.id} value={ally.id}>
                        {ally.id === member.id ? 'Self · Instant' : `${ally.character.name} · Uses turn`}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button secondary"
                  disabled={!!healingLockReason || !!healingReason}
                  aria-describedby={reasonId}
                  onClick={() =>
                    manage({
                      type: 'heal',
                      itemId: item.id,
                      ...(healingTarget.id !== member.id ? { targetId: healingTarget.id } : {}),
                    })
                  }
                >
                  {healingTarget.id === member.id ? 'Use on self' : `Heal ${healingTarget.character.name}`}
                </button>
              </>
            )}
            <button
              className="button secondary gear-drop"
              disabled={!!lockReason}
              onClick={() => manage({ type: 'drop', itemId: item.id })}
            >
              {item.quantity > 1 ? 'Drop one' : 'Drop'}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

export function EquipmentPanel({
  member,
  snapshot,
  lockReason,
  healingLockReason,
  command,
}: {
  member: Member;
  snapshot: Snapshot;
  lockReason: string;
  healingLockReason: string;
  command: (route: string, body: unknown) => Promise<Snapshot | undefined>;
}) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const combatActive =
    !!snapshot.scene.encounter && !snapshot.scene.encounter.victory && !snapshot.scene.encounter.escaped;
  const panelId = useId();
  const { character, state } = member;
  const manage: Manage = async (body) => {
    setFeedback('');
    const updated = await command('character', body);
    if (updated) {
      const changes = updated.turn?.equipmentChanges ?? [];
      const change = changes.at(-1);
      setFeedback(
        changes.length > (snapshot.turn?.equipmentChanges?.length ?? 0) && change?.memberId === member.id
          ? change.description
          : 'Inventory updated.',
      );
    }
    return updated;
  };
  return (
    <div className="equipment-manager">
      <button
        className="equipment-toggle"
        aria-label="Equipment & backpack"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        <Shield size={18} />
        <b>Equipment & backpack</b>
        <span>
          Backpack {occupiedSlots(state)}/{capacity(character)}
        </span>
        <ChevronDown size={16} className={open ? 'rotated' : ''} />
      </button>
      {feedback && (
        <p className="gear-feedback" role="status">
          {feedback}
        </p>
      )}
      {lockReason && (open || (!combatActive && snapshot.scene.loot.length > 0)) && (
        <p className="gear-lock" role="status">
          {lockReason}
        </p>
      )}
      {open && (
        <section className="gear-panel" id={panelId} aria-label="Equipment and backpack">
          <h3>Equipped</h3>
          <div className="equipment-slots">
            {slots
              .filter((slot) => !(slot === 'left' && state.equipment.left?.hands === 2))
              .map((slot) => {
                const item = state.equipment[slot];
                const bothHands = (slot === 'left' || slot === 'right') && item?.hands === 2;
                let stowReason = '';
                if (item) {
                  try {
                    unequip(character, structuredClone(state), slot);
                  } catch (error) {
                    stowReason = (error as Error).message;
                    if (stowReason.includes('Backpack full'))
                      stowReason = 'Backpack full. Drop or equip an item before stowing this one.';
                  }
                }
                return (
                  <article
                    key={slot}
                    className={`equipment-slot ${bothHands ? 'both-hands' : ''}`}
                    aria-label={bothHands ? 'Both hands' : slotLabels[slot]}
                  >
                    <span className="eyebrow">{bothHands ? 'Both hands' : slotLabels[slot]}</span>
                    {item ? (
                      <>
                        <b>
                          <ItemIcon kind={item.kind} />
                          {item.name}
                        </b>
                        <ItemDetails item={item} compact />
                        {stowReason && <p className="gear-reason">{stowReason}</p>}
                        <button
                          className="button secondary"
                          disabled={!!lockReason || !!stowReason}
                          title={stowReason || undefined}
                          onClick={() => manage({ type: 'unequip', slot })}
                        >
                          Stow item
                        </button>
                      </>
                    ) : (
                      <p className="muted">
                        {character.traits.some((trait) => trait.blocked.includes(slot))
                          ? 'Unavailable for this character'
                          : 'Empty'}
                      </p>
                    )}
                  </article>
                );
              })}
          </div>
          <div className="backpack-heading">
            <h3>Backpack</h3>
            <span>
              {occupiedSlots(state)}/{capacity(character)} slots
            </span>
          </div>
          <p className="muted small">
            Equipped gear uses no backpack space. Consumables stack three per slot. Self healing is instant;
            healing a party member uses your turn.
          </p>
          {state.inventory.length ? (
            state.inventory.map((item) => (
              <EquipmentItem
                key={item.id}
                item={item}
                member={member}
                snapshot={snapshot}
                lockReason={lockReason}
                healingLockReason={healingLockReason}
                manage={manage}
              />
            ))
          ) : (
            <p className="muted">Your backpack is empty.</p>
          )}
        </section>
      )}
      {!combatActive && snapshot.scene.loot.length > 0 && (
        <section className="ground-loot" aria-label="Nearby loot">
          <div className="backpack-heading">
            <h3>Loot at the scene</h3>
            <span>
              Backpack {occupiedSlots(state)}/{capacity(character)}
            </span>
          </div>
          <p className="muted small">
            Take items into your backpack or equip them directly. Gear changes are free outside combat.
          </p>
          {snapshot.scene.loot.map((item) => (
            <EquipmentItem
              key={item.id}
              ground
              item={item}
              member={member}
              snapshot={snapshot}
              lockReason={lockReason}
              healingLockReason={healingLockReason}
              manage={manage}
            />
          ))}
        </section>
      )}
    </div>
  );
}
