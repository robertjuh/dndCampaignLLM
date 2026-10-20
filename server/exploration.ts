import type { GMContext } from './game';
import type { TurnAdjudication } from '../shared/turn-resolution';
import { baseItem, usableSlots, incapacitatingCondition } from '../shared/rules';
import { memberScene, knownLocations, placeScene, combatActive } from '../shared/locations';
import { assertPublicFactionText } from './factions';
import { travelNextHop, turnConnections } from './world-map';
import type { CampaignConfig, LootBlueprint } from '../shared/schema';

export function explorationPotion(language: CampaignConfig['language']): LootBlueprint {
  return {
    name: language === 'Nederlands' ? 'Genezingsdrank' : 'Healing potion',
    kind: 'consumable',
    scaling: [],
    hands: 1,
    light: true,
    description:
      language === 'Nederlands'
        ? 'Een verzegelde genezingsdrank uit de onderzochte plek.'
        : 'A sealed healing potion from the searched place.',
  };
}

/** Validate new exploration evidence without changing saved legacy checkpoints or engine results. */
export function validateExploration(
  context: GMContext,
  value: TurnAdjudication,
  resolve: (ref: string) => string,
) {
  const resultingPlace = (memberId: string) => {
    const position = value.memberLocations?.find((position) => position.memberId === memberId);
    return position ? resolve(position.locationId) : memberScene(context.scene, memberId).location.id!;
  };
  const discoveries = new Set(
    (value.factionEffects ?? [])
      .filter((effect) => effect.type === 'discover')
      .map((effect) => effect.factionId),
  );
  for (const action of value.actions) {
    const member = context.members.find((member) => member.id === action.memberId);
    if (!member) throw new Error('Exploration references an unknown character.');
    const main = action.components.main;
    if (action.intent === 'search' && main && main.status !== 'blocked' && !action.search)
      throw new Error('A resolved environmental search needs its local source and useful information event.');
    if (action.search) {
      const search = action.search;
      if (
        !main ||
        main.status === 'blocked' ||
        action.intent === 'orientation' ||
        (combatActive(memberScene(context.scene, member.id)) &&
          !(context.receipts?.startCombatByLocation as Record<string, unknown> | undefined)?.[
            memberScene(context.scene, member.id).location.id!
          ] &&
          !context.receipts?.startCombat)
      )
        throw new Error('Exploration search evidence needs a resolved noncombat main search action.');
      const placeId = resolve(search.locationId);
      if (resultingPlace(member.id) !== placeId)
        throw new Error('A search must occur at its character’s resulting location.');
      const information = value.events.find((event) => event.id === search.informationEventId);
      if (
        !information ||
        information.kind !== 'world' ||
        information.actionId !== null ||
        information.presentation ||
        !information.locationRef ||
        resolve(information.locationRef) !== placeId
      )
        throw new Error('Search information needs a public world event at the searched place.');
      const check = context.turn.rolls.find((roll) => roll.memberId === member.id && !roll.notation);
      if (
        check &&
        !information.dependsOn.some(
          (dep) =>
            dep.eventId === `check:${check.id}` &&
            dep.requires === (check.success ? 'success' : 'occurrence'),
        )
      )
        throw new Error(
          'Search information depends on its successful check, or occurrence of its failed check.',
        );
      if (main.status === 'failure' && information.fact === main.fact)
        throw new Error('A failed search must add useful lesser information, not repeat its failed outcome.');
      if (search.reward) {
        const item = {
          ...baseItem('search-candidate', search.reward.name, search.reward.kind),
          ...search.reward,
        };
        if (
          item.kind === 'tool' ||
          (item.kind !== 'consumable' && !usableSlots(member.character, member.state.stats, item).length)
        )
          throw new Error('Bonus search loot must be a usable potion or equipment suited to its discoverer.');
        assertPublicFactionText(context.factions, JSON.stringify(search.reward), discoveries);
      }
    }
    if (action.travel && !context.turn.actions.find((entry) => entry.memberId === member.id)?.gathering) {
      const { goalId, via, avoid, obstacleEventId } = action.travel;
      if (action.intent === 'orientation' || action.status === 'passed')
        throw new Error('A travel goal needs a submitted physical journey.');
      const from = memberScene(context.scene, member.id).location.id!;
      const known = knownLocations(context.scene);
      if (![goalId, ...(via ?? []), ...(avoid ?? [])].every((id) => Object.hasOwn(known, id)))
        throw new Error('Mapped travel goals and restrictions need known location IDs.');
      const routeScene = {
        ...context.scene,
        worldMap: {
          nodes: context.scene.worldMap?.nodes ?? {},
          connections: turnConnections(
            context.scene,
            value,
            resolve,
            value.memberLocations?.find((position) => position.memberId === member.id)?.movementEventId,
          ),
        },
      };
      const next =
        travelNextHop(routeScene, from, goalId, via, avoid) ??
        (via?.length
          ? travelNextHop(routeScene, from, via.find((id) => id !== from) ?? goalId, [], avoid)
          : null);
      const to = resultingPlace(member.id);
      if (to !== from && ((next && to !== next) || avoid?.includes(to)))
        throw new Error(
          'Travel toward a mapped goal must use its next reachable hop, preserving route restrictions.',
        );
      if (obstacleEventId) {
        const obstacle = value.events.find((event) => event.id === obstacleEventId);
        if (
          !obstacle ||
          obstacle.kind !== 'world' ||
          obstacle.presentation ||
          !obstacle.locationRef ||
          resolve(obstacle.locationRef) !== from
        )
          throw new Error('A travel obstacle needs public local world evidence at the traveller’s origin.');
      }
      if (
        next &&
        to === from &&
        member.state.hp > 0 &&
        !incapacitatingCondition(member.state) &&
        !combatActive(memberScene(context.scene, member.id)) &&
        !context.turn.rolls.some((roll) => roll.memberId === member.id && !roll.notation && !roll.success) &&
        main?.basis !== 'engine' &&
        !obstacleEventId
      )
        throw new Error(
          `An open route reaches ${next} toward the requested goal this turn; do not block it merely because the final goal is not adjacent.`,
        );
    }
  }
  if (value.arrivals === undefined) return; // Old accepted outputs keep their compatibility contract.
  const required = new Set<string>();
  for (const member of context.members.filter((member) => member.active)) {
    const from = memberScene(context.scene, member.id).location.id!;
    const to = resultingPlace(member.id);
    if (
      context.turn.number === 0 ||
      (from !== to &&
        !context.scene.worldMap?.nodes[to]?.visited &&
        to !== context.scene.location.id &&
        !context.scene.places?.[to])
    )
      required.add(to);
  }
  const represented = new Set<string>();
  for (const arrival of value.arrivals) {
    const placeId = resolve(arrival.locationId);
    if (represented.has(placeId)) throw new Error('Describe each shared arrival once.');
    represented.add(placeId);
    if (!context.members.some((member) => member.active && resultingPlace(member.id) === placeId))
      throw new Error('Arrival evidence needs a present character.');
    const event = value.events.find((event) => event.id === arrival.eventId);
    if (
      !event ||
      event.kind !== 'world' ||
      event.actionId !== null ||
      event.presentation ||
      !event.locationRef ||
      resolve(event.locationRef) !== placeId
    )
      throw new Error(
        'An arrival needs public local world evidence of its surroundings, features and visible routes.',
      );
    const location =
      value.placeUpdates?.find((place) => place.ref === placeId)?.location ??
      (placeId === resolve('destination') ? value.location : undefined) ??
      (placeId === context.scene.location.id || context.scene.places?.[placeId]
        ? placeScene(context.scene, placeId).location
        : undefined);
    if (!location?.atmosphere.trim())
      throw new Error('An arrival needs concrete saved atmosphere as well as its observable scene event.');
  }
  if ([...required].some((placeId) => !represented.has(placeId)))
    throw new Error(
      'Every first arrival needs an arrivals entry citing a public local scene event, including arrivals outside shared focus.',
    );
}
