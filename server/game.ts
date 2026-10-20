import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { projectJournal } from '../shared/journal';
import type { DiceSource } from './random';
import { createInviteCode, type DB } from './db';
import { normalizeCombatInput } from './combat';
import { validateEnvironmentalAction } from './environment';
import {
  adjudicationOutcome,
  adjudicationPlaceRef,
  assertMovementPositions,
  engineEvents,
  resourceSlot,
  validateAdjudication,
} from './turn-resolution';
import { repairTurnCheckpoints } from './turn-recovery';
import { resolvePickups, type PickupResult } from './turn-pickups';
import { validateNPCReactions, journalWithNPCReactions, type NPCReactionReceipt } from './npc-reactions';
import {
  applyNPCUpdates,
  journalWithNPCInteractions,
  knownNPCs,
  persistentEnemy,
  rememberNPCReaction,
  saveNPCEncounter,
} from './npcs';
import { applyFeatureUpdates } from './scene-state';
import {
  factionWorldSchema,
  factionConnectionSchema,
  publicFactions,
  factionAttitude,
  type FactionWorld,
  type FactionConnection,
  type ConnectionCandidate,
} from '../shared/factions';
import {
  factionExample,
  validateGeneratedWorld,
  validateConnections,
  publicMember,
  applyFactionEffects,
  assertPublicFactionText,
} from './factions';
import {
  actionId,
  assembleResolvedNarration,
  assertCombatClaims,
  factualNarration,
  narrationParagraphs,
  turnResolutionSchema,
  type TurnAdjudication,
  type SavedTurnAdjudication,
  type TurnResolution,
  type TurnNarration,
} from '../shared/turn-resolution';
import type { CombatEvent } from '../shared/rules';
import { requestedAbility, requestedConsumable, requestsAbility } from './action-resources';
import { explorationPotion } from './exploration';
import {
  prepareEncounterChecks,
  saveEncounterRisks,
  assertEncounterProposal,
  completedEncounterProposal,
  type EncounterCheck,
  type EncounterChecks,
} from './encounters';
import { advanceWorldProgression } from './world-progression';
import { gatheringRoute } from '../shared/gathering';
import {
  campaignSchema,
  campaignLanguageSchema,
  characterSchema,
  checkSchema,
  outcomeSchema,
  type Action,
  type SupportAction,
  type CampaignConfig,
  type Character,
  type AbilityChoiceStats,
  type CharacterState,
  type Check,
  resourceUseSchema,
  type ResourceUse,
  type Member,
  type Outcome,
  type Roll,
  type Snapshot,
  type Turn,
  type Scene,
  type Encounter,
  type Item,
  type Slot,
  type Stat,
  type CombatInput,
  enemySchema,
  combatSchema,
  lootSchema,
  type LootBlueprint,
  type Ability,
  type LevelUpChoice,
  type LevelUpReward,
  levelUpChoiceSchema,
  levelUpRewardSchema,
  stats,
} from '../shared/schema';
import {
  normalizeCharacter,
  initialState,
  initialScene,
  modifier,
  maxHp,
  grantXp,
  gainAttributes,
  abilityMechanics,
  abilityBonus,
  abilityDice,
  equipmentBonus,
  availableAbility,
  availableAbilities,
  abilityUseKey,
  spendAbility,
  recoverAfterEncounter,
  helpUp,
  chooseStartingEquipment,
  equip,
  unequip,
  removeItem,
  offerGroundItem,
  takeItem,
  equippedItems,
  healWithItem,
  mendWithAbility,
  isDead,
  isDowned,
  isInCombat,
  canInteract,
  damage,
  runCombat,
  randomLoot,
  usableSlots,
  rollEnemyLoot,
  baseItem,
  applyCondition,
  removeCondition,
  tickConditions,
  matchingCures,
  ailmentCheckPenalty,
  incapacitatingCondition,
} from '../shared/rules';
import { isAilment } from '../shared/ailments';
import { ensureWorldMapPositions } from '../shared/world-map-layout';
import { combatFact } from './narration';
import {
  ensureLocations,
  updateLocation,
  memberScene,
  placeScene,
  savePlace,
  knownLocations,
  registerPlaces,
  occupiedPlaces,
  registerMap,
  recordTravel,
  combatActive as hasCombat,
} from '../shared/locations';

const gameplayBuildId = createHash('sha256')
  .update(
    [
      './game.ts',
      './providers.ts',
      './encounters.ts',
      './world-map.ts',
      './world-progression.ts',
      '../shared/world-progression.ts',
      './turn-resolution.ts',
      './turn-pickups.ts',
      './npc-reactions.ts',
      './npcs.ts',
      './scene-state.ts',
      '../shared/scene-state.ts',
      '../shared/npcs.ts',
      './adjudication-recovery.ts',
      './factions.ts',
      '../shared/schema.ts',
      '../shared/turn-resolution.ts',
      '../shared/locations.ts',
      '../shared/gathering.ts',
      '../shared/journal.ts',
      '../GAMEPLAYLOOPPROMPT.md',
    ]
      .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
      .join('\n'),
  )
  .digest('hex')
  .slice(0, 16);

export class GameError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export type CampaignRow = {
  id: string;
  owner_id: string;
  code: string;
  display_token: string;
  config: string;
  status: Snapshot['status'];
  paused: number;
  version: number;
  scene: string | null;
  factions: string | null;
};
type TurnRow = {
  id: string;
  campaign_id: string;
  number: number;
  phase: Turn['phase'];
  roster: string;
  result: string | null;
  error: string | null;
  draft: string | null;
};
export type StageBudget = {
  used: number;
  limit: number;
  signal?: AbortSignal;
  progress?: (stage: 'narration' | 'review') => void;
  traceContext?: { campaignId: string; turnId: string; turnNumber?: number; stage: string; attempt: number };
  requests?: {
    callId?: string;
    model?: string;
    task?: string;
    upstreamRequestId?: string;
    status?: number;
    toolCalls?: string[];
    request: number;
    durationMs: number;
    inputBytes: number;
    outputBytes?: number;
    authMs?: number;
    headersMs?: number;
    firstByteMs?: number;
    firstOutputMs?: number;
    streamBytes?: number;
    outputTextBytes?: number;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    failure?: string;
  }[];
  corrections?: { request: number; feedback: string }[];
  fallback?: string;
};
export type GMContext = {
  buildId?: string;
  factions?: FactionWorld;
  config: CampaignConfig;
  members: Member[];
  turn: Turn;
  history: (Pick<Outcome, 'summary'> & { source?: 'resolution' | 'legacy-summary' })[];
  journal: Outcome['journal'];
  scene: Scene;
  combatResult?: CombatReceipt;
  resourceUses?: ResourceReceipt[];
  pendingReplacements?: { playerName: string; character: Character }[];
  arrivingCharacters?: { playerName: string; character: Character }[];
  supportResults?: SupportResult[];
  recoveryLogs?: string[];
  startingMembers?: Member[];
  receipts?: Record<string, unknown>;
  requestBudget?: StageBudget;
};
type SupportResult = {
  memberId: string;
  targetId: string;
  type: 'help-up' | 'heal-ally';
  sourceName: string;
  restored: number;
  log: string;
};
export type CombatReceipt = {
  locationId?: string;
  encounters?: Record<string, Encounter>;
  participantIds?: string[];
  logs: string[];
  events?: (CombatEvent & { locationId?: string })[];
  encounter: Encounter;
  characters: { id: string; name: string; state: CharacterState }[];
  loot: Scene['loot'];
};
function startedCombats(draft: Draft): Record<string, Encounter> {
  return (
    (draft.receipts.startCombatByLocation as Record<string, Encounter> | undefined) ??
    (draft.receipts.startCombat
      ? { [draft.scene.location.id!]: draft.receipts.startCombat as Encounter }
      : {})
  );
}
function combatReceipts(draft: Draft): Record<string, CombatReceipt> {
  const saved = draft.receipts.combat as CombatReceipt | undefined;
  return (
    (draft.receipts.combatByLocation as Record<string, CombatReceipt> | undefined) ??
    (saved ? { [saved.locationId ?? draft.scene.location.id!]: saved } : {})
  );
}
function fought(draft: Draft, memberId: string) {
  const receipt = draft.receipts.combat as CombatReceipt | undefined;
  return !!(
    receipt?.participantIds?.includes(memberId) ||
    receipt?.characters.some((member) => member.id === memberId)
  );
}
function bossRewarded(draft: Draft, memberId: string) {
  return (
    !!draft.receipts.bossReward &&
    !!(draft.receipts.challenge as { members: Member[] } | undefined)?.members.some(
      (member) => member.id === memberId,
    )
  );
}
function combatLocations(scene: Scene) {
  return [...new Set(Object.values(scene.memberLocations ?? {}))].filter((id) =>
    hasCombat(placeScene(scene, id)),
  );
}
export type ResourceReceipt = ResourceUse & {
  slot?: 'main' | 'minor';
  sourceName: string;
  restored: number;
  cured?: string[];
  state: CharacterState;
  targetState: CharacterState;
};
export type GameTools = ((check: Check) => Roll) & {
  prepareEncounters?: (value: TurnAdjudication) => EncounterCheck[];
  startCombat: (enemies: unknown, locationId?: string) => unknown;
  combat: (input: CombatInput, locationId?: string) => unknown;
  offerLoot: (input: {
    item: LootBlueprint;
    reason: string;
    memberId?: string;
    sourceId?: string;
    locationId?: string;
  }) => unknown;
  completeChallenge: (input: { memberId: string; reason: string; bossEquivalent: boolean }) => unknown;
  useResource?: (input: ResourceUse) => ResourceReceipt;
  validateResolution?: (outcome: Outcome) => void;
  validateAdjudication?: (input: unknown) => TurnAdjudication;
};
type Draft = {
  progress?: Turn['progress'];
  placeRefs?: Record<string, string>;
  factionLifecycle?: boolean;
  factions?: FactionWorld;
  pipelineVersion?: 0 | 1;
  members: Member[];
  scene: Scene;
  receipts: Record<string, unknown>;
  startingMembers?: Member[];
  context?: GMContext;
  adjudication?: SavedTurnAdjudication;
  adjudicationFallback?: string;
  resolution?: TurnResolution;
  narration?: TurnNarration;
  resolutionRevision?: number;
  narrationRevision?: number;
};
export interface GameMaster {
  generateFactions?(context: GMContext, example: FactionWorld, budget: StageBudget): Promise<FactionWorld>;
  connectFactions?(
    context: GMContext,
    candidates: ConnectionCandidate[],
    budget: StageBudget,
  ): Promise<FactionConnection[]>;
  /** Compatibility only: new providers implement adjudicate and narrate. */
  resolve?(context: GMContext, roll: GameTools): Promise<Outcome>;
  adjudicate?(context: GMContext, tools: GameTools): Promise<TurnAdjudication>;
  narrate?(resolution: TurnResolution, config: CampaignConfig, budget?: StageBudget): Promise<TurnNarration>;
  planCombat?(context: GMContext): Promise<unknown>;
  generate?(concept: string, signal?: AbortSignal): Promise<Character>;
  levelUp?(context: LevelUpContext): Promise<LevelUpReward>;
}
export type LevelUpContext = {
  config: CampaignConfig;
  character: Character;
  state: CharacterState;
  choice: LevelUpChoice;
  target: Ability | null;
  attributes: Stat[];
};
export function validateLevelUpReward(context: LevelUpContext, input: unknown): LevelUpReward {
  const reward = levelUpRewardSchema.parse(input);
  if (context.choice === 'attributes') {
    if (reward.ability) throw new GameError('An attribute reward cannot also grant an ability.');
  } else {
    const kind = context.choice.endsWith('combat') ? 'combat' : 'utility';
    if (
      !reward.ability ||
      reward.ability.kind !== kind ||
      reward.ability.level !== (context.target ? context.target.level + 1 : 1)
    )
      throw new GameError('The ability must match the chosen category and level.');
    if (
      context.target
        ? reward.ability.name !== context.target.name
        : context.character.abilities.some((a) => a.name.toLowerCase() === reward.ability!.name.toLowerCase())
    )
      throw new GameError('Upgrade the selected ability, or give a new ability a unique name.');
    if (
      context.target &&
      (reward.ability.effect !== context.target.effect ||
        reward.ability.stat !== context.target.stat ||
        reward.ability.dice !== context.target.dice ||
        (reward.ability.bonus ?? 0) !== (context.target.bonus ?? 0) ||
        (reward.ability.inflicts ?? null) !== (context.target.inflicts ?? null) ||
        JSON.stringify(reward.ability.cures ?? []) !== JSON.stringify(context.target.cures ?? []))
    )
      throw new GameError(
        'An upgrade must preserve the ability’s effect, attribute, dice, and rolled bonus.',
      );
    if (!context.target && (reward.ability.dice !== undefined || (reward.ability.bonus ?? 0) !== 0))
      throw new GameError(
        'New level-up abilities must use standard base power, without model-chosen dice or bonuses.',
      );
  }
  return reward;
}
export type ProviderFactory = (ownerId: string, config: CampaignConfig) => GameMaster;
const json = JSON.stringify;
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const secretEqual = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(tokenHash(a)), Buffer.from(tokenHash(b)));
const requiresUtilityCheck = (character: Character, action: Action, state?: CharacterState) =>
  requestedAbility(character, action, 'utility', null, state)?.effect === 'assist' ||
  (!action.gathering &&
    !action.abilityName &&
    requestsAbility(action.text) &&
    !/\b(?:or|of)\b/i.test(action.text) &&
    availableAbilities(character, state).some(
      (ability) => ability.kind === 'utility' && ability.effect === 'assist',
    ) &&
    !availableAbilities(character, state).some(
      (ability) =>
        (ability.kind === 'combat' || ability.effect !== 'assist') &&
        action.text.toLowerCase().includes(ability.name.toLowerCase()),
    ));

export class Game {
  private running = new Map<string, Promise<void>>();
  private mechanicalIndex = new Map<string, number>();
  private listeners = new Map<string, Set<() => void>>();
  private leveling = new Set<string>();
  constructor(
    public db: DB,
    private providers: ProviderFactory,
    private draw: (sides: number) => number = (sides) => randomInt(1, sides + 1),
    private diceFor?: (config: CampaignConfig) => DiceSource,
  ) {}

  private die(id: string, sides: number) {
    return this.diceFor ? this.diceFor(JSON.parse(this.campaign(id).config)).draw(sides) : this.draw(sides);
  }
  private source(id: string) {
    return this.diceFor ? this.diceFor(JSON.parse(this.campaign(id).config)).label : 'Injected test RNG';
  }
  identify(token?: string): { id: string; name: string; token?: string } {
    if (token) {
      const player = this.db
        .prepare('SELECT p.* FROM players p JOIN sessions s ON p.id = s.player_id WHERE s.hash = ?')
        .get(tokenHash(token)) as { id: string; name: string } | undefined;
      if (player) return player;
    }
    const id = randomUUID();
    const fresh = randomBytes(32).toString('base64url');
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO players(id) VALUES(?)').run(id);
      this.db.prepare('INSERT INTO sessions VALUES(?, ?)').run(tokenHash(fresh), id);
    })();
    return { id, name: 'Adventurer', token: fresh };
  }
  rename(playerId: string, name: string) {
    this.db.prepare('UPDATE players SET name = ? WHERE id = ?').run(name, playerId);
  }
  characters(ownerId: string) {
    return (
      this.db
        .prepare('SELECT id, sheet FROM characters WHERE owner_id = ? ORDER BY created_at DESC')
        .all(ownerId) as { id: string; sheet: string }[]
    ).map((r) => ({ id: r.id, ...(JSON.parse(r.sheet) as Character) }));
  }
  abilityChoiceStats(): AbilityChoiceStats {
    const result: AbilityChoiceStats = { characters: 0, offers: 0, selections: 0, rows: [] };
    const groups = new Map<string, AbilityChoiceStats['rows'][number]>();
    for (const row of this.db.prepare('SELECT sheet FROM characters').all() as { sheet: string }[]) {
      const character = JSON.parse(row.sheet) as Character;
      if (!character.abilityOptions) continue;
      result.characters++;
      const chosen = new Set(character.abilities.map((a) => a.name));
      for (const ability of character.abilityOptions) {
        const dice = ['strike', 'mend'].includes(ability.effect) ? abilityDice(ability) : null;
        const bonus = ability.bonus ?? 0;
        const key = json([ability.kind, ability.effect, ability.stat, dice, bonus]);
        const group = groups.get(key) ?? {
          kind: ability.kind,
          effect: ability.effect,
          stat: ability.stat,
          dice,
          bonus,
          offered: 0,
          selected: 0,
        };
        group.offered++;
        result.offers++;
        if (chosen.has(ability.name)) {
          group.selected++;
          result.selections++;
        }
        groups.set(key, group);
      }
    }
    result.rows = [...groups.values()].sort(
      (a, b) =>
        b.offered - a.offered ||
        json([a.kind, a.effect, a.stat, a.dice, a.bonus]).localeCompare(
          json([b.kind, b.effect, b.stat, b.dice, b.bonus]),
        ),
    );
    return result;
  }
  saveCharacter(ownerId: string, input: unknown) {
    const sheet = normalizeCharacter(characterSchema.parse(input));
    if (sheet.abilityOptions && sheet.abilities.length !== 2)
      throw new GameError('Choose one in-combat ability and one out-of-combat ability before saving.');
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO characters(id, owner_id, sheet) VALUES(?, ?, ?)')
      .run(id, ownerId, json(sheet));
    return { id, ...sheet };
  }
  updateCharacter(ownerId: string, id: string, input: unknown) {
    const sheet = normalizeCharacter(characterSchema.parse(input));
    if (sheet.abilityOptions && sheet.abilities.length !== 2)
      throw new GameError('Choose one in-combat ability and one out-of-combat ability before saving.');
    const result = this.db
      .prepare('UPDATE characters SET sheet = ? WHERE id = ? AND owner_id = ?')
      .run(json(sheet), id, ownerId);
    if (!result.changes) throw new GameError('Character not found in your library.', 404);
    return { id, ...sheet };
  }
  editLobbyCharacter(id: string, playerId: string, input: unknown) {
    const saved = this.db.transaction(() => {
      if (this.campaign(id).status !== 'lobby')
        throw new GameError(
          'The story has started. Edit your library template for a future campaign instead.',
          409,
        );
      const member = this.db
        .prepare('SELECT id, character_id, state FROM members WHERE campaign_id = ? AND player_id = ?')
        .get(id, playerId) as { id: string; character_id: string; state: string } | undefined;
      if (!member) throw new GameError('Join this campaign first.', 403);
      const updated = this.updateCharacter(playerId, member.character_id, input);
      const { id: _id, ...sheet } = updated;
      this.db.prepare('UPDATE members SET sheet = ?, state = ? WHERE id = ?').run(
        json(sheet),
        json({
          ...initialState(sheet, randomUUID()),
          factionConnectionPreference: JSON.parse(member.state).factionConnectionPreference,
        }),
        member.id,
      );
      this.db.prepare('UPDATE campaigns SET version = version + 1 WHERE id = ?').run(id);
      return updated;
    })();
    this.emit(id);
    return saved;
  }
  list(playerId: string) {
    return (
      this.db
        .prepare(
          'SELECT DISTINCT c.* FROM campaigns c LEFT JOIN members m ON m.campaign_id = c.id WHERE c.owner_id = ? OR m.player_id = ? ORDER BY c.created_at DESC',
        )
        .all(playerId, playerId) as CampaignRow[]
    ).map((c) => ({
      id: c.id,
      config: JSON.parse(c.config) as CampaignConfig,
      status: c.status,
      isHost: c.owner_id === playerId,
    }));
  }
  campaign(id: string) {
    const c = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as CampaignRow | undefined;
    if (!c) throw new GameError('Campaign not found.', 404);
    return c;
  }
  requireHost(id: string, playerId: string) {
    const c = this.campaign(id);
    if (c.owner_id !== playerId) throw new GameError('Only the campaign leader can do that.', 403);
    return c;
  }
  canRead(id: string, playerId: string, displayToken?: string) {
    const c = this.campaign(id);
    if (
      c.owner_id === playerId ||
      this.db.prepare('SELECT 1 FROM members WHERE campaign_id = ? AND player_id = ?').get(id, playerId) ||
      (displayToken && secretEqual(c.display_token, displayToken))
    )
      return;
    throw new GameError('Join this campaign to view it.', 403);
  }
  create(ownerId: string, input: unknown) {
    const config = campaignSchema.parse(input);
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO campaigns(id, owner_id, code, display_token, config, scene) VALUES(?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        ownerId,
        createInviteCode(this.db),
        randomBytes(32).toString('base64url'),
        json(config),
        json(ensureLocations(initialScene(config.setting))),
      );
    return this.snapshot(id, ownerId);
  }
  invite(code: string) {
    const c = this.db
      .prepare('SELECT * FROM campaigns WHERE (code = ? OR legacy_code = ?) AND status != ?')
      .get(code.trim().toUpperCase(), code.trim().toUpperCase(), 'archived') as CampaignRow | undefined;
    if (!c) throw new GameError('This session code is not available.', 404);
    const config = JSON.parse(c.config) as CampaignConfig;
    return { id: c.id, name: config.name, setting: config.setting, provider: config.provider };
  }
  join(code: string, playerId: string, characterId: string) {
    const invite = this.invite(code);
    if (this.campaign(invite.id).status === 'ended')
      throw new GameError('This run has ended. Create a new campaign to use a fresh copy of your template.');
    this.db.transaction(() => {
      if (
        this.db
          .prepare('SELECT id FROM members WHERE campaign_id = ? AND player_id = ?')
          .get(invite.id, playerId)
      )
        return;
      const character = this.db
        .prepare('SELECT sheet FROM characters WHERE id = ? AND owner_id = ?')
        .get(characterId, playerId) as { sheet: string } | undefined;
      if (!character) throw new GameError('Choose one of your saved character templates.', 403);
      const sheet = characterSchema.parse(JSON.parse(character.sheet));
      const state = initialState(sheet, randomUUID());
      this.db
        .prepare(
          'INSERT INTO members(id, campaign_id, player_id, character_id, sheet, state) VALUES(?, ?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), invite.id, playerId, characterId, json(sheet), json(state));
    })();
    this.emit(invite.id);
    return this.snapshot(invite.id, playerId);
  }
  queueReplacement(id: string, playerId: string, characterId: string | null) {
    this.db.transaction(() => {
      if (this.campaign(id).status !== 'active')
        throw new GameError('Replacement characters can only join an active run.', 409);
      const member = this.members(id).find((member) => member.playerId === playerId);
      if (!member) throw new GameError('Join this campaign first.', 403);
      if (!isDead(member.state)) throw new GameError('Only a fallen character can be replaced.');
      let replacement: Member['replacement'] = null;
      if (characterId) {
        const saved = this.db
          .prepare('SELECT sheet FROM characters WHERE id = ? AND owner_id = ?')
          .get(characterId, playerId) as { sheet: string } | undefined;
        if (!saved) throw new GameError('Choose one of your saved character templates.', 403);
        const character = characterSchema.parse(JSON.parse(saved.sheet));
        if (character.selectedEquipmentIds.length !== 2)
          throw new GameError('Save two starting equipment choices for your replacement first.');
        character.abilities = character.abilities.map((ability) => ({ ...ability, level: 1 }));
        initialState(character, randomUUID()); // Validate saved gear before queueing it.
        replacement = { characterId, character };
      }
      this.db
        .prepare('UPDATE members SET replacement = ? WHERE id = ?')
        .run(replacement ? json(replacement) : null, member.id);
      const row = this.pending(id);
      if (replacement && member.state.respawnReady && row?.phase === 'collecting') {
        const draft: Draft = {
          members: this.members(id),
          scene: JSON.parse(this.campaign(id).scene!),
          receipts: {},
        };
        const replacingIds = draft.members
          .filter(
            (member) =>
              member.active && isDead(member.state) && member.state.respawnReady && member.replacement,
          )
          .map((member) => member.id);
        const arrivals = this.activateReplacements(id, row.id, draft);
        const roster = JSON.parse(row.roster) as string[];
        this.db
          .prepare('UPDATE turns SET roster = ? WHERE id = ?')
          .run(
            json([
              ...new Set([
                ...roster,
                ...replacingIds.filter((id) =>
                  draft.members.some((member) => member.id === id && member.state.hp > 0),
                ),
              ]),
            ]),
            row.id,
          );
        this.recordArrivals(id, row.id, arrivals);
        this.queueIfReady(id);
      }
      this.db.prepare('UPDATE campaigns SET version = version + 1 WHERE id = ?').run(id);
    })();
    this.emit(id);
    this.kick(id);
    return this.snapshot(id, playerId);
  }
  private activateReplacements(id: string, turnId: string, draft: Draft) {
    const arrivals: NonNullable<GMContext['arrivingCharacters']> = [];
    if (!draft.members.some((member) => member.state.hp > 0)) return arrivals;
    for (const member of draft.members) {
      if (
        !isDead(member.state) ||
        !member.state.respawnReady ||
        hasCombat(memberScene(draft.scene, member.id))
      )
        continue;
      const queued = this.db.prepare('SELECT replacement FROM members WHERE id = ?').get(member.id) as {
        replacement: string | null;
      };
      if (!queued.replacement) continue;
      const replacement = JSON.parse(queued.replacement) as NonNullable<Member['replacement']>;
      this.db
        .prepare("UPDATE turns SET draft = ? WHERE campaign_id = ? AND phase = 'complete' AND draft IS NULL")
        .run(json({ members: this.members(id), scene: draft.scene, receipts: {} }), id);
      this.db
        .prepare('INSERT INTO events(campaign_id, turn_id, kind, payload) VALUES(?, ?, ?, ?)')
        .run(
          id,
          turnId,
          'character_replaced',
          json({ member, replacementCharacterId: replacement.characterId }),
        );
      member.characterId = replacement.characterId;
      member.character = replacement.character;
      member.state = {
        ...initialState(member.character, randomUUID()),
        factionConnectionPreference: member.state.factionConnectionPreference,
      };
      member.replacement = null;
      this.db
        .prepare('UPDATE members SET state = ?, sheet = ?, character_id = ?, replacement = NULL WHERE id = ?')
        .run(json(member.state), json(member.character), member.characterId, member.id);
      arrivals.push({ playerName: member.playerName, character: member.character });
    }
    return arrivals;
  }
  private recordArrivals(id: string, turnId: string, arrivals: NonNullable<GMContext['arrivingCharacters']>) {
    for (const arrival of arrivals)
      this.db
        .prepare('INSERT INTO events(campaign_id, turn_id, kind, payload) VALUES(?, ?, ?, ?)')
        .run(id, turnId, 'character_joined', json(arrival));
  }
  members(id: string): Member[] {
    return (
      this.db
        .prepare(
          'SELECT m.*, p.name AS player_name FROM members m JOIN players p ON p.id = m.player_id WHERE campaign_id = ? ORDER BY m.rowid',
        )
        .all(id) as Record<string, unknown>[]
    ).map((m) => ({
      id: m.id as string,
      playerId: m.player_id as string,
      playerName: m.player_name as string,
      characterId: m.character_id as string,
      character: JSON.parse(m.sheet as string),
      state: JSON.parse(m.state as string),
      active: !!m.active,
      replacement: m.replacement ? JSON.parse(m.replacement as string) : null,
    }));
  }
  turn(row: TurnRow): Turn {
    const savedDraft: Draft | undefined = row.draft ? JSON.parse(row.draft) : undefined;
    const actors: Member[] = savedDraft?.members ?? [];
    return {
      id: row.id,
      number: row.number,
      phase: row.phase,
      roster: JSON.parse(row.roster),
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error,
      automaticRetry: !!this.db
        .prepare("SELECT 1 FROM events WHERE turn_id = ? AND kind = 'turn_auto_retry'")
        .get(row.id),
      ...(['queued', 'resolving'].includes(row.phase) && savedDraft?.progress
        ? { progress: savedDraft.progress }
        : {}),
      diagnostics: [
        ...new Set(
          (
            this.db
              .prepare(
                "SELECT kind, payload FROM events WHERE turn_id = ? AND kind LIKE 'stage:%' ORDER BY id",
              )
              .all(row.id) as { kind: string; payload: string }[]
          ).flatMap((event) => {
            const stage = event.kind.slice('stage:'.length);
            const data = JSON.parse(event.payload);
            return [
              ...(data.fallback
                ? [`${stage}: ${data.fallback}`]
                : data.failure
                  ? [`${stage}: ${data.failure}`]
                  : []),
              ...(data.corrections ?? []).map((item: { feedback: string }) => `${stage}: ${item.feedback}`),
            ];
          }),
        ),
      ],
      resolution: savedDraft?.resolution,
      ...(row.phase === 'complete' && savedDraft?.factions
        ? {
            factionChanges: (
              (savedDraft.receipts.factionReputation as
                import('../shared/factions').ReputationReceipt[] | undefined) ?? []
            ).filter((receipt) =>
              savedDraft.factions!.factions.some(
                (faction) => faction.id === receipt.factionId && faction.discoveredTurn !== null,
              ),
            ),
          }
        : {}),
      equipmentChanges: (
        this.db
          .prepare("SELECT payload FROM events WHERE turn_id = ? AND kind = 'equipment_changed' ORDER BY id")
          .all(row.id) as { payload: string }[]
      ).map((event) => {
        const { memberId, characterName, description } = JSON.parse(event.payload);
        return { memberId, characterName, description };
      }),
      actions: (
        this.db.prepare('SELECT * FROM actions WHERE turn_id = ? ORDER BY rowid').all(row.id) as {
          member_id: string;
          text: string;
          passed: number;
          accepts_lethal_risk: number;
          ability_name: string | null;
          support_action: string | null;
          gathering: string | null;
          submitted_at: string | null;
        }[]
      ).map((a) => ({
        memberId: a.member_id,
        text: a.text,
        passed: !!a.passed,
        ...(a.submitted_at ? { submittedAt: a.submitted_at } : {}),
        acceptsLethalRisk: !!a.accepts_lethal_risk,
        ...(a.ability_name ? { abilityName: a.ability_name } : {}),
        ...(a.support_action ? { supportAction: JSON.parse(a.support_action) } : {}),
        ...(a.gathering ? { gathering: JSON.parse(a.gathering) } : {}),
        ...(actors.find((member) => member.id === a.member_id)
          ? { characterName: actors.find((member) => member.id === a.member_id)!.character.name }
          : {}),
      })),
      rolls: (
        this.db.prepare('SELECT result FROM rolls WHERE turn_id = ? ORDER BY rowid').all(row.id) as {
          result: string;
        }[]
      ).map((r) => JSON.parse(r.result)),
    };
  }
  pending(id: string) {
    return this.db.prepare("SELECT * FROM turns WHERE campaign_id = ? AND phase != 'complete'").get(id) as
      TurnRow | undefined;
  }
  snapshot(id: string, playerId: string): Snapshot {
    const c = this.campaign(id);
    const pending = this.pending(id);
    const members = this.members(id);
    const world: FactionWorld | undefined = c.factions
      ? factionWorldSchema.parse(JSON.parse(c.factions))
      : undefined;
    const viewTurn = (row: TurnRow): Turn => {
      const turn = this.turn(row);
      const draft: Draft | undefined = row.draft ? JSON.parse(row.draft) : undefined;
      if (draft?.factions && row.phase !== 'complete') delete turn.resolution;
      if (draft?.factions) {
        const known = new Set(publicFactions(world).map((faction) => faction.id));
        const hidden = draft.factions.factions.filter((faction) => !known.has(faction.id));
        const redact = (text: string) =>
          hidden.some((faction) => text.includes(faction.name) || text.includes(faction.id))
            ? 'The GM needs to retry from the saved checkpoint.'
            : text;
        turn.error = turn.error ? redact(turn.error) : null;
        turn.diagnostics = turn.diagnostics?.map(redact);
      }
      return turn;
    };
    return {
      id,
      ...(world ? { factions: publicFactions(world) } : {}),
      config: JSON.parse(c.config),
      scene: c.scene ? JSON.parse(c.scene) : initialScene(JSON.parse(c.config).setting),
      status: c.status,
      paused: !!c.paused,
      version: c.version,
      isHost: c.owner_id === playerId,
      myMemberId: members.find((m) => m.playerId === playerId)?.id ?? null,
      leaderName: (
        this.db.prepare('SELECT name FROM players WHERE id = ?').get(c.owner_id) as { name: string }
      ).name,
      members: members.map((member) => publicMember(member, world)),
      turn: pending ? viewTurn(pending) : null,
      history: (
        this.db
          .prepare(
            "SELECT * FROM (SELECT * FROM turns WHERE campaign_id = ? AND phase = 'complete' ORDER BY number DESC LIMIT 30) ORDER BY number",
          )
          .all(id) as TurnRow[]
      ).map(viewTurn),
      journal: projectJournal(
        this.db
          .prepare('SELECT kind, name, detail, item_id AS itemId FROM journal WHERE campaign_id = ?')
          .all(id) as Outcome['journal'],
        c.scene ? JSON.parse(c.scene) : initialScene(JSON.parse(c.config).setting),
        members,
        JSON.parse(c.config).language,
      ),
      ...(c.owner_id === playerId ? { inviteCode: c.code, displayToken: c.display_token } : {}),
    };
  }
  private newTurn(id: string, number: number, phase: Turn['phase']) {
    const roster = this.members(id)
      .filter((m) => m.active && m.state.hp > 0)
      .map((m) => m.id);
    this.db
      .prepare('INSERT INTO turns(id, campaign_id, number, phase, roster) VALUES(?, ?, ?, ?, ?)')
      .run(randomUUID(), id, number, phase, json(roster));
    if (phase === 'collecting') this.queueIfReady(id);
  }
  start(id: string, playerId: string) {
    this.db.transaction(() => {
      const c = this.requireHost(id, playerId);
      if (c.status !== 'lobby') throw new GameError('This campaign has already started.', 409);
      if (!this.members(id).some((m) => m.active))
        throw new GameError('At least one player needs to join first.');
      if (this.members(id).some((m) => m.active && !m.state.equipmentChosen))
        throw new GameError('Every player must choose two starting equipment pieces first.');
      this.db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").run(id);
      this.newTurn(id, 0, 'queued');
    })();
    this.emit(id);
    this.kick(id);
  }
  callGathering(id: string, playerId: string, turnId: string) {
    this.db.transaction(() => {
      const row = this.pending(id);
      if (!row || row.id !== turnId || row.phase !== 'collecting')
        throw new GameError('Gathering calls can only be made while players choose their actions.', 409);
      const member = this.members(id).find((member) => member.playerId === playerId && member.active);
      if (!member || !(JSON.parse(row.roster) as string[]).includes(member.id))
        throw new GameError('Only a participating character can call a gathering.', 403);
      if (member.state.hp <= 0 || incapacitatingCondition(member.state))
        throw new GameError('Your character cannot call a gathering right now.');
      const scene: Scene = JSON.parse(this.campaign(id).scene!);
      if (isInCombat(memberScene(scene, member.id), member.state))
        throw new GameError('Finish or leave combat before calling a gathering.');
      const locationId = memberScene(scene, member.id).location.id!;
      if (scene.gathering?.memberId === member.id && scene.gathering.locationId === locationId) return;
      if (this.turn(row).actions.some((action) => action.gathering))
        throw new GameError(
          'Players have joined this gathering. Choose another meeting point next turn.',
          409,
        );
      scene.gathering = { id: randomUUID(), memberId: member.id, locationId };
      this.db
        .prepare('UPDATE campaigns SET scene = ?, version = version + 1 WHERE id = ?')
        .run(json(scene), id);
    })();
    this.emit(id);
  }
  submit(
    id: string,
    playerId: string,
    turnId: string,
    text: string,
    passed: boolean,
    acceptsLethalRisk = false,
    abilityName: string | null = null,
    supportAction: SupportAction | null = null,
    gatheringId: string | null = null,
  ) {
    this.db.transaction(() => {
      const row = this.pending(id);
      if (!row || row.id !== turnId || row.phase !== 'collecting')
        throw new GameError('That turn is already processing. Refresh to see the current turn.', 409);
      const member = this.members(id).find((m) => m.playerId === playerId);
      if (!member || !(JSON.parse(row.roster) as string[]).includes(member.id))
        throw new GameError('You join the action from the next turn.', 403);
      if (member.state.hp <= 0) throw new GameError('This character’s run has ended.');
      const incapacitated = incapacitatingCondition(member.state);
      if (incapacitated)
        throw new GameError(
          `You are ${incapacitated}. Your turn is skipped automatically; no action is needed.`,
        );
      if (this.turn(row).actions.find((action) => action.memberId === member.id)?.supportAction)
        throw new GameError('Helping your ally has already used your action for this turn.');
      if (member.state.pendingLevelUps > 0)
        throw new GameError('Choose your level-up reward before taking another action.');
      if (!member.state.equipmentChosen) throw new GameError('Choose two starting equipment pieces first.');
      let gathering: Action['gathering'];
      if (gatheringId) {
        if (passed || abilityName || supportAction)
          throw new GameError('Joining a gathering uses the whole turn for travel.');
        if (this.turn(row).actions.some((action) => action.memberId === member.id))
          throw new GameError('Cancel your submitted action before joining the gathering.', 409);
        const scene: Scene = JSON.parse(this.campaign(id).scene!);
        if (!scene.gathering || scene.gathering.id !== gatheringId)
          throw new GameError('The meeting point changed. Refresh before joining.', 409);
        const place = memberScene(scene, member.id);
        if (isInCombat(place, member.state))
          throw new GameError('Characters in combat cannot join a gathering.');
        if (place.location.id === scene.gathering.locationId)
          throw new GameError('You are already at the meeting point.');
        const route = gatheringRoute(scene, place.location.id!, scene.gathering.locationId);
        if (!route) throw new GameError('There is no known open route to the gathering outside combat.');
        gathering = { id: gatheringId, locationId: scene.gathering.locationId, route };
        const name = knownLocations(scene)[gathering.locationId];
        text =
          JSON.parse(this.campaign(id).config).language === 'Nederlands'
            ? `Ik reis naar de bijeenkomst bij ${name}.`
            : `I travel to the gathering at ${name}.`;
      }
      if (passed && abilityName) throw new GameError('Passing cannot use an ability.');
      if (abilityName) {
        const scene: Scene = JSON.parse(this.campaign(id).scene!);
        const place = memberScene(scene, member.id);
        const inCombat = place.encounter && !place.encounter.victory && !place.encounter.escaped;
        const ability = availableAbility(member.character, member.state, abilityName);
        if (!inCombat && ability.kind === 'combat' && !['strike', 'mend', 'cleanse'].includes(ability.effect))
          throw new GameError(
            'Choose a utility, obstacle strike, healing, or cleansing ability outside combat.',
          );
      }
      this.db
        .prepare(
          'INSERT INTO actions(turn_id, member_id, text, passed, accepts_lethal_risk, ability_name, support_action, gathering, submitted_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(turn_id, member_id) DO UPDATE SET text = excluded.text, passed = excluded.passed, accepts_lethal_risk = excluded.accepts_lethal_risk, ability_name = excluded.ability_name, support_action = excluded.support_action, gathering = excluded.gathering, submitted_at = excluded.submitted_at',
        )
        .run(
          turnId,
          member.id,
          passed ? '' : text,
          +passed,
          +acceptsLethalRisk,
          abilityName,
          supportAction ? json(supportAction) : null,
          gathering ? json(gathering) : null,
          new Date().toISOString(),
        );
      this.queueIfReady(id);
      this.db.prepare('UPDATE campaigns SET version = version + 1 WHERE id = ?').run(id);
    })();
    this.emit(id);
    this.kick(id);
  }
  cancelAction(id: string, playerId: string, turnId: string) {
    this.db.transaction(() => {
      const row = this.pending(id);
      if (!row || row.id !== turnId || row.phase !== 'collecting')
        throw new GameError('That turn is already processing. Refresh to see the current turn.', 409);
      const member = this.members(id).find((member) => member.playerId === playerId);
      if (!member || !(JSON.parse(row.roster) as string[]).includes(member.id))
        throw new GameError('You join the action from the next turn.', 403);
      this.db.prepare('DELETE FROM actions WHERE turn_id = ? AND member_id = ?').run(turnId, member.id);
      this.db.prepare('UPDATE campaigns SET version = version + 1 WHERE id = ?').run(id);
    })();
    this.emit(id);
  }
  private queueIfReady(id: string) {
    const row = this.pending(id);
    if (!row || row.phase !== 'collecting' || this.campaign(id).paused) return;
    const roster = JSON.parse(row.roster) as string[];
    const actions = this.turn(row).actions;
    const members = this.members(id);
    if (
      roster.length &&
      roster.every(
        (memberId) =>
          actions.some((a) => a.memberId === memberId) ||
          members.some((member) => member.id === memberId && incapacitatingCondition(member.state)),
      )
    )
      this.db.prepare("UPDATE turns SET phase = 'queued' WHERE id = ? AND phase = 'collecting'").run(row.id);
  }
  private resolveSupport(id: string, turnId: string): SupportResult[] {
    return this.withDraft(id, turnId, (draft) => {
      if (draft.receipts.support) return draft.receipts.support as SupportResult[];
      const results: SupportResult[] = [];
      for (const action of this.turn(this.pending(id)!).actions) {
        if (!action.supportAction) continue;
        if (hasCombat(memberScene(draft.scene, action.memberId)) || fought(draft, action.memberId)) continue;
        const support = action.supportAction;
        const member = draft.members.find((member) => member.id === action.memberId)!;
        const target = draft.members.find((member) => member.id === support.targetId)!;
        const sourceName =
          support.type === 'help-up'
            ? 'Help up'
            : member.state.inventory.find((item) => item.id === support.itemId)!.name;
        let restored = 0;
        let log: string;
        try {
          if (
            memberScene(draft.scene, member.id).location.id !==
            memberScene(draft.scene, target.id).location.id
          )
            throw new GameError('Helping an ally requires being at the same location.');
          if (incapacitatingCondition(member.state))
            throw new GameError('This character cannot use their main action while incapacitated.');
          restored =
            support.type === 'help-up'
              ? helpUp(target.state)
              : target.state.hp >= target.state.maxHp
                ? 0
                : healWithItem(member.character, member.state, support.itemId!, target);
          log =
            support.type === 'help-up'
              ? `${member.character.name} helps ${target.character.name} up at 1 HP. They can act next turn.`
              : `${member.character.name} uses ${sourceName} on ${target.character.name}, restoring ${restored} HP.`;
        } catch (error) {
          log = `${member.character.name}'s ${sourceName} has no effect: ${(error as Error).message}. The main action is spent.`;
        }
        results.push({
          memberId: member.id,
          targetId: target.id,
          type: support.type,
          sourceName,
          restored,
          log,
        });
      }
      draft.receipts.support = results;
      return results;
    });
  }
  pause(id: string, playerId: string, paused: boolean) {
    this.db.transaction(() => {
      this.requireHost(id, playerId);
      this.db.prepare('UPDATE campaigns SET paused = ? WHERE id = ?').run(+paused, id);
      if (!paused) this.queueIfReady(id);
    })();
    this.emit(id);
    this.kick(id);
  }
  setLanguage(id: string, playerId: string, input: unknown) {
    this.db.transaction(() => {
      const campaign = this.requireHost(id, playerId);
      const language = campaignLanguageSchema.parse(input);
      const pending = this.pending(id);
      if (
        pending?.phase === 'queued' ||
        pending?.phase === 'resolving' ||
        this.members(id).some((member) => this.leveling.has(member.id))
      )
        throw new GameError('Wait for GM generation to finish before changing the output language.', 409);
      const config: CampaignConfig = JSON.parse(campaign.config);
      this.db
        .prepare('UPDATE campaigns SET config = ?, version = version + 1 WHERE id = ?')
        .run(json({ ...config, language }), id);
    })();
    this.emit(id);
  }
  setPartyGoal(id: string, playerId: string, input: unknown) {
    this.db.transaction(() => {
      const campaign = this.requireHost(id, playerId);
      const partyGoal = campaignSchema.parse({ ...JSON.parse(campaign.config), partyGoal: input }).partyGoal;
      const pending = this.pending(id);
      if (pending && pending.phase !== 'collecting')
        throw new GameError('Wait until this turn finishes before changing the party goal.', 409);
      this.db
        .prepare('UPDATE campaigns SET config = ?, version = version + 1 WHERE id = ?')
        .run(json({ ...JSON.parse(campaign.config), partyGoal }), id);
    })();
    this.emit(id);
  }
  setActive(id: string, playerId: string, memberId: string, active: boolean) {
    this.db.transaction(() => {
      this.requireHost(id, playerId);
      const member = this.members(id).find((m) => m.id === memberId);
      if (!member) throw new GameError('Player not found.', 404);
      this.db.prepare('UPDATE members SET active = ? WHERE id = ?').run(+active, memberId);
      const row = this.pending(id);
      if (row?.phase === 'collecting' && !active) {
        const roster = (JSON.parse(row.roster) as string[]).filter((m) => m !== memberId);
        this.db.prepare('UPDATE turns SET roster = ? WHERE id = ?').run(json(roster), row.id);
        this.db.prepare('DELETE FROM actions WHERE turn_id = ? AND member_id = ?').run(row.id, memberId);
      } else if (
        row?.phase === 'collecting' &&
        active &&
        (JSON.parse(row.roster) as string[]).length === 0 &&
        member.state.hp > 0
      ) {
        this.db.prepare('UPDATE turns SET roster = ? WHERE id = ?').run(json([memberId]), row.id);
      }
      this.queueIfReady(id);
    })();
    this.emit(id);
    this.kick(id);
  }
  setFactionPreference(id: string, playerId: string, preference: 'allow' | 'unaffiliated') {
    this.db.transaction(() => {
      if (this.campaign(id).status !== 'lobby')
        throw new GameError('Choose starting faction connections before the story starts.', 409);
      const member = this.members(id).find((member) => member.playerId === playerId);
      if (!member) throw new GameError('Join this campaign first.', 403);
      member.state.factionConnectionPreference = preference;
      this.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(json(member.state), member.id);
      this.db.prepare('UPDATE campaigns SET version = version + 1 WHERE id = ?').run(id);
    })();
    this.emit(id);
  }
  retry(id: string, playerId: string) {
    this.requireHost(id, playerId);
    const row = this.pending(id);
    if (row?.phase !== 'failed') throw new GameError('This turn does not need a retry.', 409);
    this.db.prepare("UPDATE turns SET phase = 'queued', error = NULL WHERE id = ?").run(row.id);
    this.emit(id);
    this.kick(id);
  }
  roll(id: string, turnId: string, input: Check): Roll {
    const check = checkSchema.parse(input);
    const row = this.pending(id);
    if (!row || row.id !== turnId || row.phase !== 'resolving') throw new GameError('No active resolution.');
    if (row.draft && (JSON.parse(row.draft) as Draft).adjudication)
      throw new GameError('Gameplay is locked after accepted adjudication.');
    const turn = this.turn(row);
    const action = turn.actions.find((action) => action.memberId === check.memberId && !action.passed);
    if (!action || turn.number === 0 || !turn.roster.includes(check.memberId))
      throw new GameError('Only a character acting this turn can make a check.');
    if (action.supportAction) throw new GameError('Helping an ally uses this character’s main action.');
    if (action.gathering && check.abilityName)
      throw new GameError('Joining a gathering uses the whole turn for travel without an ability.');
    if (action.abilityName && action.abilityName !== check.abilityName)
      throw new GameError('Use exactly the ability selected by the player.');
    // One immutable check per character. Retries reuse its dice and consumed ability use.
    const prior = this.db
      .prepare('SELECT parameters, result FROM rolls WHERE turn_id = ? AND check_key = ?')
      .get(turnId, check.memberId) as { parameters: string; result: string } | undefined;
    if (prior) {
      const original = JSON.parse(prior.parameters) as Check;
      if (
        original.stat !== check.stat ||
        original.dc !== check.dc ||
        original.mode !== check.mode ||
        (original.circumstances?.favorable ?? null) !== (check.circumstances?.favorable ?? null) ||
        (original.circumstances?.adverse ?? null) !== (check.circumstances?.adverse ?? null) ||
        original.lethal !== check.lethal ||
        (original.abilityName ?? null) !== (check.abilityName ?? null) ||
        (original.assistsMemberId ?? null) !== (check.assistsMemberId ?? null) ||
        json([...(original.assistedBy ?? [])].sort()) !== json([...(check.assistedBy ?? [])].sort())
      )
        throw new GameError('A check is already locked for this character. Use its saved result.');
      return JSON.parse(prior.result);
    }
    const result = this.withDraft(id, turnId, (draft) => {
      assertPublicFactionText(draft.factions, check.reason);
      const scene = memberScene(draft.scene, check.memberId);
      if ((draft.receipts.loot as { memberId?: string } | undefined)?.memberId === check.memberId)
        throw new GameError(
          'Resolve uncertain searches before offering their loot. This discovery is already recorded as routine.',
        );
      if ((hasCombat(scene) && !startedCombats(draft)[scene.location.id!]) || fought(draft, check.memberId))
        throw new GameError('Use resolve_combat to adjudicate a combat round.');
      const member = draft.members.find((member) => member.id === check.memberId)!;
      if (incapacitatingCondition(member.state))
        throw new GameError('This character cannot make a check while incapacitated.');
      if (check.assistsMemberId) {
        const target = draft.members.find((candidate) => candidate.id === check.assistsMemberId);
        if (
          !target ||
          target.id === member.id ||
          memberScene(draft.scene, target.id).location.id !== scene.location.id ||
          target.state.hp <= 0 ||
          !turn.roster.includes(target.id) ||
          !turn.actions.some((submitted) => submitted.memberId === target.id && !submitted.passed)
        )
          throw new GameError('Assistance requires another living character acting this turn.');
        if (turn.rolls.some((roll) => roll.memberId === target.id && !roll.notation))
          throw new GameError('Resolve assistance before the dependent check; its dice are already locked.');
      }
      const helpers = check.assistedBy ?? [];
      if (new Set(helpers).size !== helpers.length || helpers.includes(member.id))
        throw new GameError('Assisting characters must be distinct from the acting character.');
      for (const helper of helpers) {
        const receipt = turn.rolls.find((roll) => roll.memberId === helper && !roll.notation);
        if (!receipt?.success || receipt.assistsMemberId !== member.id)
          throw new GameError('Assistance needs an earlier successful check supporting this character.');
      }
      if (
        Object.entries(draft.receipts).some(
          ([key, value]) =>
            key.startsWith('resource:') &&
            (value as ResourceReceipt).memberId === member.id &&
            resourceSlot(value as ResourceReceipt) === 'main',
        )
      )
        throw new GameError(
          'This character has already spent their main action helping an ally or using a healing ability.',
        );
      const utility = requestedAbility(member.character, action, 'utility', check.abilityName, member.state);
      const strike = requestedAbility(member.character, action, 'combat', check.abilityName, member.state);
      const requested =
        utility ??
        (strike?.effect === 'strike' &&
        (action.abilityName === strike.name || action.text.toLowerCase().includes(strike.name.toLowerCase()))
          ? strike
          : undefined);
      if (check.abilityName && requested?.name !== check.abilityName)
        throw new GameError(
          'Use a saved utility ability requested in the player’s action, or an explicitly named/selected strike against an obstacle.',
        );
      if (!check.abilityName && requiresUtilityCheck(member.character, action, member.state))
        throw new GameError('Resolve the requested utility ability with its saved name and stat.');
      if (!check.abilityName && requested?.effect === 'strike')
        throw new GameError(
          'Resolve the requested strike against the obstacle with its saved name and stat.',
        );
      const ability = check.abilityName
        ? availableAbility(member.character, member.state, check.abilityName)
        : null;
      if (
        ability &&
        !(ability.kind === 'utility' && ability.effect === 'assist') &&
        ability.effect !== 'strike'
      )
        throw new GameError(
          'Only utility assist or a strike against a noncombat obstacle uses a check; execute Mend or Cleanse through use_resource.',
        );
      if (ability && ability.stat !== check.stat)
        throw new GameError('This ability must use its saved attribute for the relevant check.');
      const favorable = check.circumstances?.favorable ?? check.mode === 'advantage';
      const adverse = check.circumstances?.adverse ?? check.mode === 'disadvantage';
      const advantage = favorable || ability?.kind === 'utility' || helpers.length > 0;
      const mode = advantage === adverse ? 'normal' : adverse ? 'disadvantage' : 'advantage';
      const dice = Array.from({ length: mode === 'normal' ? 1 : 2 }, () => this.die(id, 20));
      if (dice.some((die) => !Number.isInteger(die) || die < 1 || die > 20))
        throw new Error('Random source returned an invalid die.');
      const selected = mode === 'disadvantage' ? Math.min(...dice) : Math.max(...dice);
      const equipmentBonuses = equippedItems(member.state)
        .filter((item) => item.scaling.includes(check.stat) && item.checkBonus)
        .map((item) => ({ itemId: item.id, name: item.name, bonus: item.checkBonus }));
      const bonus =
        modifier(member.state.stats[check.stat]) +
        equipmentBonus(member.state, check.stat, 'checkBonus') +
        (ability ? abilityBonus(ability) : 0) -
        ailmentCheckPenalty(member.state, check.stat);
      const total = selected + bonus;
      const result: Roll = {
        ...check,
        mode,
        id: randomUUID(),
        dice,
        modifier: bonus,
        equipmentBonuses,
        total,
        success: selected !== 1 && (selected === 20 || total >= check.dc),
        critical: selected === 1 ? 'failure' : selected === 20 ? 'success' : undefined,
        source: this.source(id),
        ...(ability ? { label: `${member.character.name} · ${ability.name} · ${check.stat}` } : {}),
      };
      this.db
        .prepare('INSERT INTO rolls VALUES(?, ?, ?, ?, ?)')
        .run(result.id, turnId, check.memberId, json(check), json(result));
      if (ability) spendAbility(member.state, ability);
      if (check.lethal && selected === 1) {
        damage(member.state, member.state.hp, `Catastrophic failure: ${check.reason}`, true);
        draft.receipts[`check-effect:${result.id}`] = {
          memberId: member.id,
          fact: `${member.character.name} ${isDowned(member.state) ? 'is Downed at 0 HP' : 'dies permanently'} after a catastrophic failed check.`,
        };
      }
      return result;
    });
    this.emit(id);
    return result;
  }
  private withDraft<T>(id: string, turnId: string, callback: (draft: Draft) => T, checkpoint = false): T {
    const result = this.db.transaction(() => {
      const row = this.pending(id);
      if (!row || row.id !== turnId || row.phase !== 'resolving')
        throw new GameError('No active resolution.');
      const draft: Draft = row.draft
        ? JSON.parse(row.draft)
        : {
            members: this.members(id),
            scene: this.snapshot(id, this.campaign(id).owner_id).scene,
            receipts: {},
          };
      try {
        if (!draft.resolution)
          ensureLocations(
            draft.scene,
            draft.members.map((member) => member.id),
          );
        if (!checkpoint && (draft.adjudication || draft.resolution))
          throw new GameError(
            'Gameplay is locked after accepted adjudication. Retry narration from the saved result.',
          );
        const value = callback(draft);
        this.db.prepare('UPDATE turns SET draft = ? WHERE id = ?').run(json(draft), turnId);
        return { value };
      } catch (error) {
        return { error };
      } // Preserve any dice receipts, but discard partial mechanics.
    })();
    if ('error' in result) throw result.error;
    return result.value!;
  }
  private mechanicalDie(
    id: string,
    turnId: string,
    sides: number,
    label: string,
    actor: string,
    stat: Stat,
    bonus = 0,
    dc = 10,
    receiptKey?: string,
  ) {
    const index = this.mechanicalIndex.get(turnId) ?? 0;
    if (!receiptKey) this.mechanicalIndex.set(turnId, index + 1);
    const key = receiptKey ?? `mechanic:${index}`;
    const prior = this.db
      .prepare('SELECT parameters, result FROM rolls WHERE turn_id = ? AND check_key = ?')
      .get(turnId, key) as { parameters: string; result: string } | undefined;
    const parameters = { sides, actor, stat, bonus, dc, label };
    if (prior) {
      if (prior.parameters !== json(parameters))
        throw new GameError(
          'Combat dice are locked. Retry the original actions without changing their mechanics.',
        );
      return (JSON.parse(prior.result) as Roll).dice[0];
    }
    const die = this.die(id, sides);
    if (!Number.isInteger(die) || die < 1 || die > sides) throw new GameError('Invalid randomness source.');
    const receipt: Roll = {
      id: randomUUID(),
      memberId: actor,
      stat,
      dc: dc as Check['dc'],
      mode: 'normal',
      lethal: false,
      reason: label,
      label,
      notation: `d${sides}`,
      dice: [die],
      modifier: bonus,
      total: die + bonus,
      success: sides === 20 ? die !== 1 && (die === 20 || die + bonus >= dc) : true,
      critical: sides === 20 && die === 1 ? 'failure' : sides === 20 && die === 20 ? 'success' : undefined,
      source: this.source(id),
    };
    this.db
      .prepare('INSERT INTO rolls VALUES(?, ?, ?, ?, ?)')
      .run(receipt.id, turnId, key, json(parameters), json(receipt));
    return die;
  }
  prepareEncounters(id: string, turnId: string, value: TurnAdjudication): EncounterCheck[] {
    return this.withDraft(id, turnId, (draft) => {
      const context = this.resolutionContext(draft, this.pending(id)!);
      const baseline = draft.receipts.encounterProposal as TurnAdjudication | undefined;
      if (baseline) assertEncounterProposal(context, value, baseline);
      const checks = (draft.receipts.encounterChecks ??= {}) as EncounterChecks;
      const prepared = prepareEncounterChecks(context, value, checks, (locationId) =>
        this.mechanicalDie(
          id,
          turnId,
          6,
          'Random encounter',
          locationId,
          'WIS',
          0,
          10,
          `encounter:${locationId}`,
        ),
      );
      if (prepared.required.length && !baseline) draft.receipts.encounterProposal = structuredClone(value);
      return prepared.required;
    });
  }
  startCombat(id: string, turnId: string, input: unknown, locationId?: string) {
    const proposed = enemySchema.array().min(1).max(10).parse(input);
    this.mechanicalIndex.set(turnId, 0);
    return this.withDraft(id, turnId, (draft) => {
      const targetId = locationId === 'current' || !locationId ? draft.scene.location.id! : locationId;
      const starts = startedCombats(draft);
      if (starts[targetId]) return starts[targetId];
      const place = targetId.startsWith('new:') ? null : placeScene(draft.scene, targetId);
      const check = (draft.receipts.encounterChecks as EncounterChecks | undefined)?.[targetId];
      if (draft.receipts.encounterProposal && !check?.triggered)
        throw new GameError('Exploration is resolved. Introduce only the saved triggered encounters.');
      const present = (memberId: string) =>
        check
          ? check.memberIds.includes(memberId)
          : memberScene(draft.scene, memberId).location.id === targetId;
      let draw = 0;
      const legacyDice =
        targetId === draft.scene.location.id &&
        !!this.db
          .prepare('SELECT id FROM rolls WHERE turn_id = ? AND check_key = ?')
          .get(turnId, 'mechanic:0');
      const die = (sides: number, label: string, actor: string, stat: Stat, bonus = 0) =>
        this.mechanicalDie(
          id,
          turnId,
          sides,
          label,
          actor,
          stat,
          bonus,
          10,
          legacyDice ? undefined : `combat:${targetId}:start:${draw++}`,
        );
      const turn = this.turn(this.pending(id)!);
      if (
        turn.actions.some(
          (action) =>
            !action.passed &&
            present(action.memberId) &&
            !incapacitatingCondition(draft.members.find((member) => member.id === action.memberId)!.state) &&
            !draft.receipts[`resource:ability:${action.memberId}`] &&
            requiresUtilityCheck(
              draft.members.find((member) => member.id === action.memberId)!.character,
              action,
              draft.members.find((member) => member.id === action.memberId)!.state,
            ) &&
            !turn.rolls.some(
              (roll) =>
                roll.memberId === action.memberId &&
                !!roll.abilityName &&
                (!action.abilityName || roll.abilityName === action.abilityName),
            ),
        )
      )
        throw new GameError('Resolve the selected utility ability checks before starting combat.');
      if (
        turn.actions.some(
          (action) =>
            !action.passed &&
            present(action.memberId) &&
            !action.supportAction &&
            !incapacitatingCondition(draft.members.find((member) => member.id === action.memberId)!.state) &&
            !draft.receipts[`resource:item:${action.memberId}`] &&
            requestedConsumable(
              draft.members.find((member) => member.id === action.memberId)!,
              action,
            ),
        )
      )
        throw new GameError('Execute requested consumables through use_resource before starting combat.');
      if (place && hasCombat(place)) throw new GameError('Combat is already active.');
      const context = this.resolutionContext(draft, this.pending(id)!);
      const proposal = draft.receipts.encounterProposal as TurnAdjudication | undefined;
      if (proposal?.npcUpdates?.length)
        applyNPCUpdates(context.scene, proposal, adjudicationPlaceRef(context, proposal));
      const enemies = proposed.map((enemy) => persistentEnemy(context, enemy, targetId));
      const otherEnemies = [
        ...Object.entries(starts)
          .filter(([key]) => key !== targetId)
          .flatMap(([, encounter]) => encounter.enemies),
        ...[draft.scene, ...Object.keys(draft.scene.places ?? {}).map((key) => placeScene(draft.scene, key))]
          .filter((other) => other.location.id !== targetId && hasCombat(other))
          .flatMap((other) => other.encounter!.enemies),
      ];
      if (
        new Set(enemies.map((e) => e.id)).size !== enemies.length ||
        enemies.some(
          (e) => draft.members.some((m) => m.id === e.id) || otherEnemies.some((other) => other.id === e.id),
        )
      )
        throw new GameError('Enemy IDs must be unique across active encounters.');
      const roster = this.turn(this.pending(id)!).roster;
      const initiative = draft.members
        .filter((m) => present(m.id) && roster.includes(m.id) && m.state.hp > 0)
        .map((m) => ({
          id: m.id,
          total:
            die(20, `${m.character.name}: initiative`, m.id, 'DEX', modifier(m.state.stats.DEX)) +
            modifier(m.state.stats.DEX) +
            Object.values(m.state.equipment)
              .filter((x, i, all) => x && all.findIndex((y) => y?.id === x.id) === i)
              .reduce((n, x) => n + (x?.initiativePenalty ?? 0), 0),
        }));
      const generated = enemies.map((e) => {
        const total = die(20, `${e.name}: initiative`, e.id, 'DEX');
        initiative.push({ id: e.id, total });
        const equipment =
          'equipment' in e && e.equipment !== undefined
            ? e.equipment
            : rollEnemyLoot(
                randomUUID(),
                Math.max(
                  1,
                  ...draft.members.filter((member) => present(member.id)).map((member) => member.state.level),
                ),
                e,
                (sides, label) => die(sides, `${e.name}: ${label}`, e.id, 'INT'),
                (JSON.parse(this.campaign(id).config) as CampaignConfig).language,
              );
        return { ...e, equipment, maxHp: e.maxHp ?? e.hp, initiative: total };
      });
      for (const member of draft.members.filter((member) => present(member.id)))
        delete member.state.respawnReady;
      const encounter: Encounter = {
        enemies: generated,
        round: 1,
        initiative: initiative.sort((a, b) => b.total - a.total),
        victory: false,
        escaped: false,
      };
      for (const [index, enemy] of encounter.enemies.entries())
        rememberNPCReaction(draft.scene, enemy.id, proposed[index].name, targetId, enemy.description, true);
      saveNPCEncounter(draft.scene, targetId, encounter);
      if (place) {
        place.encounter = encounter;
        savePlace(draft.scene, place);
      }
      draft.receipts.startCombatByLocation = { ...starts, [targetId]: structuredClone(encounter) };
      draft.receipts.startCombat ??= structuredClone(encounter);
      if (!locationId) draft.receipts.startCombatLegacyLocation = targetId;
      return encounter;
    });
  }
  private prepareNPCReactions(id: string, turnId: string, input: unknown, locationId?: string) {
    this.withDraft(id, turnId, (draft) => {
      const target = !locationId || locationId === 'current' ? draft.scene.location.id! : locationId;
      if (combatReceipts(draft)[target]) return;
      const place = placeScene(draft.scene, target);
      if (!hasCombat(place) || startedCombats(draft)[target])
        throw new GameError(
          'NPC reinforcements require an ongoing encounter, before its next round executes.',
        );
      const all = (draft.receipts.npcReactionsByLocation ??= {}) as Record<string, NPCReactionReceipt>;
      const context = this.combatContext(this.resolutionContext(draft, this.pending(id)!), target);
      const reactions = validateNPCReactions(context, input);
      if (all[target]) return;
      const known = [draft.scene, ...Object.values(draft.scene.places ?? {})].flatMap((place) =>
        hasCombat(place) ? place.encounter!.enemies : [],
      );
      if (
        reactions.some(
          (reaction) =>
            draft.members.some(
              (member) =>
                member.id === reaction.npcId ||
                member.character.name.toLowerCase() === reaction.npcName.toLowerCase(),
            ) ||
            known.some(
              (enemy) =>
                enemy.id === reaction.npcId || enemy.name.toLowerCase() === reaction.npcName.toLowerCase(),
            ),
        )
      )
        throw new GameError('A saved enemy cannot be duplicated or resurrected as an NPC reinforcement.');
      for (const reaction of reactions) {
        rememberNPCReaction(
          draft.scene,
          reaction.npcId,
          reaction.npcName,
          reaction.enemy
            ? target
            : reaction.originLocationId === 'current'
              ? target
              : reaction.originLocationId,
          reaction.fact,
          !!reaction.enemy,
        );
        if (!reaction.enemy) continue;
        const enemy = reaction.enemy;
        let draw = 0;
        const die = (sides: number, label: string) =>
          this.mechanicalDie(
            id,
            turnId,
            sides,
            `${enemy.name}: ${label}`,
            enemy.id,
            'DEX',
            0,
            10,
            `combat:${target}:reinforce:${enemy.id}:${draw++}`,
          );
        const initiative = die(20, 'joins initiative');
        const previous = draft.scene.npcs?.[enemy.id]?.enemy;
        const equipment =
          previous?.equipment ??
          rollEnemyLoot(
            randomUUID(),
            Math.max(
              1,
              ...draft.members
                .filter((member) => memberScene(draft.scene, member.id).location.id === target)
                .map((member) => member.state.level),
            ),
            enemy,
            die,
            context.config.language,
          );
        place.encounter!.enemies.push({
          ...enemy,
          ...previous,
          withdrawn: false,
          maxHp: previous?.maxHp ?? enemy.hp,
          initiative,
          equipment,
          readyRound: place.encounter!.round + 1,
        });
        place.encounter!.initiative.push({ id: enemy.id, total: initiative });
      }
      place.encounter!.initiative.sort((a, b) => b.total - a.total);
      savePlace(draft.scene, place);
      saveNPCEncounter(draft.scene, target, place.encounter!);
      all[target] = { reactions };
    });
  }
  combat(id: string, turnId: string, input: CombatInput, locationId?: string): CombatReceipt {
    const parsed = combatSchema.parse(input);
    if (parsed.npcReactions?.length) this.prepareNPCReactions(id, turnId, parsed.npcReactions, locationId);
    this.mechanicalIndex.set(turnId, 100);
    return this.withDraft(id, turnId, (draft) => {
      const targetId = locationId === 'current' || !locationId ? draft.scene.location.id! : locationId;
      const receipts = combatReceipts(draft);
      if (receipts[targetId]) return receipts[targetId];
      const place = placeScene(draft.scene, targetId);
      if (!hasCombat(place)) throw new GameError('There is no active combat.');
      if (startedCombats(draft)[targetId])
        throw new GameError('The encounter has just begun. Let players choose their first combat actions.');
      let draw = 0;
      const legacyDice =
        targetId === draft.scene.location.id &&
        !!this.db
          .prepare('SELECT id FROM rolls WHERE turn_id = ? AND check_key = ?')
          .get(turnId, 'mechanic:100');
      const die = (sides: number, label: string, actor: string, stat: Stat, bonus = 0, dc = 10) =>
        this.mechanicalDie(
          id,
          turnId,
          sides,
          label,
          actor,
          stat,
          bonus,
          dc,
          legacyDice ? undefined : `combat:${targetId}:round:${draw++}`,
        );
      const turn = this.turn(this.pending(id)!);
      const atEncounter = (memberId: string) => memberScene(draft.scene, memberId).location.id === targetId;
      const required = turn.actions
        .filter((a) => !a.passed && atEncounter(a.memberId))
        .map((a) => a.memberId);
      if (
        parsed.actions.length !== required.length ||
        parsed.actions.some((a) => !required.includes(a.memberId))
      )
        throw new GameError(
          'Interpret exactly the submitted non-pass actions; never invent player decisions.',
        );
      const journal = parsed.actions.some((action) => action.environment)
        ? (this.db
            .prepare('SELECT kind, name, detail FROM journal WHERE campaign_id = ?')
            .all(id) as Outcome['journal'])
        : [];
      for (const action of parsed.actions) {
        const submitted = turn.actions.find((submitted) => submitted.memberId === action.memberId)!;
        const member = draft.members.find((member) => member.id === action.memberId)!;
        if (action.environment) {
          const checked = validateEnvironmentalAction({ scene: place, journal }, action.environment);
          if (json(checked) !== json(action.environment))
            throw new GameError('Reuse the saved validated environmental profile.');
        }
        if (submitted.supportAction) {
          const support = submitted.supportAction;
          if (
            action.main !== (support.type === 'help-up' ? 'help-up' : 'heal') ||
            action.targetId !== support.targetId ||
            action.mainItemId !== (support.type === 'heal-ally' ? support.itemId : null) ||
            action.minor !== 'none'
          )
            throw new GameError('Resolve exactly the ally support action selected by the player.');
        }
        if (action.intent === 'orientation') {
          if (
            submitted.supportAction ||
            action.main !== 'interact' ||
            action.minor !== 'none' ||
            action.abilityName ||
            action.targetId ||
            action.mainItemId ||
            action.weaponSlot ||
            action.dc ||
            action.effect ||
            action.environment ||
            action.cureCondition ||
            action.reengage
          )
            throw new GameError('Combat orientation must remain an information-only interaction.');
          continue;
        }
        const ability = requestedAbility(
          member.character,
          submitted,
          undefined,
          action.abilityName,
          member.state,
        );
        const utilityCheck = ability?.kind === 'utility' && ability.effect === 'assist';
        if (
          (action.abilityName ?? null) !== (ability?.name ?? null) ||
          (utilityCheck
            ? !['creative', 'flee', 'move', 'interact', 'ability'].includes(action.main)
            : (action.main === 'ability') !== !!ability)
        )
          throw new GameError('Resolve exactly the combat ability selected by the player.');
      }
      const active = draft.members.filter(
        (m) =>
          atEncounter(m.id) &&
          (turn.roster.includes(m.id) || isDowned(m.state) || m.state.conditions.includes('Escaped')),
      );
      for (const member of active)
        if (member.state.hp > 0 && !place.encounter!.initiative.some((i) => i.id === member.id)) {
          const mod = modifier(member.state.stats.DEX);
          const total = die(20, `${member.character.name}: joins initiative`, member.id, 'DEX', mod) + mod;
          place.encounter!.initiative.push({ id: member.id, total });
        }
      place.encounter!.initiative.sort((a, b) => b.total - a.total);
      const events: CombatEvent[] = [];
      const logs = runCombat(
        active,
        place.encounter!,
        parsed,
        (sides, label, actor, stat, bonus, dc) => die(sides, label, actor, stat, bonus, dc),
        (event) => events.push(event),
        place.environment ??
          (parsed.actions.some((action) => action.environment)
            ? (place.environment = { sources: {}, spentResources: [] })
            : undefined),
      );
      if (place.encounter!.victory) {
        logs.push(
          ...recoverAfterEncounter(
            draft.members.filter(
              (member) => member.active && atEncounter(member.id) && !active.includes(member),
            ),
          ),
        );
        for (const enemy of place.encounter!.enemies.filter((enemy) => enemy.hp === 0)) {
          // Older saved encounters predate enemy equipment.
          const equipment = enemy.equipment?.length
            ? enemy.equipment
            : [
                {
                  ...baseItem(randomUUID(), `${enemy.name}'s weapon`.slice(0, 100), 'weapon'),
                  damage: enemy.damage,
                },
              ];
          for (const loot of equipment) {
            offerGroundItem(place, loot);
            logs.push(`${enemy.name} drops ${loot.name}. It is available as scene loot.`);
          }
          enemy.equipment = [];
        }
        draft.scene.encounters++;
        for (const member of draft.members.filter((member) => atEncounter(member.id)))
          if (isDead(member.state)) member.state.respawnReady = true;
      }
      saveNPCEncounter(draft.scene, targetId, place.encounter!);
      const receipt: CombatReceipt = {
        locationId: targetId,
        participantIds: active.map((member) => member.id),
        logs,
        events: [
          ...events.map((event) => ({ ...event, locationId: targetId })),
          ...logs.slice(events.length).map((fact) => ({
            locationId: targetId,
            actorId: null,
            phase: 'aftermath' as const,
            status: null,
            fact,
            presentation: 'log' as const,
          })),
        ],
        encounter: structuredClone(place.encounter!),
        characters: active.map((m) => ({ id: m.id, name: m.character.name, state: m.state })),
        loot: structuredClone(place.loot),
      };
      savePlace(draft.scene, place);
      const byLocation = { ...receipts, [targetId]: receipt };
      draft.receipts.combatByLocation = byLocation;
      const all = Object.values(byLocation);
      draft.receipts.combat = {
        participantIds: all.flatMap((entry) => entry.participantIds ?? []),
        logs: all.flatMap((entry) => entry.logs),
        events: all.flatMap((entry) => entry.events ?? []),
        encounter: (byLocation[draft.scene.location.id!] ?? all[0]).encounter,
        encounters: Object.fromEntries(
          Object.entries(byLocation).map(([key, entry]) => [key, entry.encounter]),
        ),
        characters: all.flatMap((entry) => entry.characters),
        loot: all.flatMap((entry) => entry.loot),
      } satisfies CombatReceipt;
      return receipt;
    });
  }
  useResource(id: string, turnId: string, input: ResourceUse): ResourceReceipt {
    const use = resourceUseSchema.parse(input);
    if (!!use.itemId === !!use.abilityName)
      throw new GameError('Choose a consumable item or a healing ability.');
    return this.withDraft(id, turnId, (draft) => {
      const turn = this.turn(this.pending(id)!);
      const action = turn.actions.find((action) => action.memberId === use.memberId && !action.passed);
      if (!action || turn.number === 0 || !turn.roster.includes(use.memberId))
        throw new GameError('Only a character acting this turn can use a resource.');
      if (action.gathering) throw new GameError('Joining a gathering uses the whole turn for travel.');
      const targetId = use.targetId ?? use.memberId;
      const key = `resource:${use.itemId ? 'item' : 'ability'}:${use.memberId}`;
      const prior = draft.receipts[key] as ResourceReceipt | undefined;
      if (prior) {
        if (
          prior.itemId !== use.itemId ||
          prior.abilityName !== use.abilityName ||
          prior.targetId !== targetId
        )
          throw new GameError('This resource use is already locked. Reuse its saved result.');
        return prior;
      }
      if (
        (hasCombat(memberScene(draft.scene, use.memberId)) &&
          !startedCombats(draft)[memberScene(draft.scene, use.memberId).location.id!]) ||
        fought(draft, use.memberId)
      )
        throw new GameError('Use resolve_combat for item and ability usage during combat.');
      const slot = resourceSlot({ ...use, targetId });
      const spent = Object.entries(draft.receipts).some(
        ([key, value]) =>
          key.startsWith('resource:') &&
          (value as ResourceReceipt).memberId === use.memberId &&
          resourceSlot(value as ResourceReceipt) === slot,
      );
      if (
        spent ||
        (slot === 'main' &&
          (action.supportAction ||
            (draft.receipts.support as SupportResult[] | undefined)?.some(
              (receipt) => receipt.memberId === use.memberId,
            ) ||
            turn.rolls.some((roll) => roll.memberId === use.memberId && !roll.notation)))
      )
        throw new GameError(`This character has already spent their ${slot} action.`);
      const member = draft.members.find((member) => member.id === use.memberId)!;
      const target = draft.members.find((member) => member.id === targetId);
      if (!target) throw new GameError('Choose an ally in this campaign.');
      if (
        memberScene(draft.scene, target.id).location.id !== memberScene(draft.scene, use.memberId).location.id
      )
        throw new GameError('That ally is at another location.');
      if (member.state.hp <= 0) throw new GameError('Only a conscious character can use a resource.');
      const incapacitated = incapacitatingCondition(member.state);
      if (incapacitated && (incapacitated !== 'Stunned' || use.abilityName || targetId !== member.id))
        throw new GameError('This character cannot use that action while incapacitated.');
      if (action.supportAction)
        throw new GameError('This support action has already been resolved by the server.');
      if (isDead(target.state)) throw new GameError('A dead character cannot be healed.');
      let restored = 0;
      const originalConditions = [...target.state.conditions];
      let sourceName: string;
      if (use.itemId) {
        const item = member.state.inventory.find((item) => item.id === use.itemId);
        if (!item || item.kind !== 'consumable') throw new GameError('Choose an owned consumable item.');
        if (requestedConsumable(member, action, item.id)?.id !== item.id)
          throw new GameError('Use the consumable requested in the player’s action.');
        sourceName = item.name;
        if (item.healing) restored = healWithItem(member.character, member.state, item.id, target);
        else removeItem(member.state, item.id);
      } else {
        if (
          requestedAbility(member.character, action, undefined, use.abilityName, member.state)?.name !==
          use.abilityName
        )
          throw new GameError('Use a saved healing ability requested in the player’s action.');
        sourceName = use.abilityName!;
        restored = mendWithAbility(
          member.character,
          member.state,
          sourceName,
          target,
          (sides, label, _actor, stat, bonus, dc) =>
            this.mechanicalDie(id, turnId, sides, label, member.id, stat, bonus, dc, key),
        );
      }
      const receipt: ResourceReceipt = {
        ...use,
        targetId,
        slot,
        sourceName,
        restored,
        cured: originalConditions.filter(
          (condition) => isAilment(condition) && !target.state.conditions.includes(condition),
        ),
        state: structuredClone(member.state),
        targetState: structuredClone(target.state),
      };
      draft.receipts[key] = receipt;
      return receipt;
    });
  }
  offerLoot(id: string, turnId: string, input: Parameters<GameTools['offerLoot']>[0]) {
    const blueprint = lootSchema.parse(input.item);
    const sourceId = input.sourceId?.normalize('NFKC').trim().toLowerCase();
    if (input.sourceId !== undefined && (!sourceId || sourceId.length > 200))
      throw new GameError('Loot needs a stable, location-qualified source ID of at most 200 characters.');
    if (blueprint.kind === 'tool' && (!input.memberId || !sourceId))
      throw new GameError('A story item needs its searching character and discovery source.');
    this.mechanicalIndex.set(turnId, 200);
    return this.withDraft(id, turnId, (draft) => {
      if (draft.receipts.loot) return draft.receipts.loot;
      const turn = this.turn(this.pending(id)!);
      if (
        turn.number === 0 ||
        !turn.actions.some((a) => !a.passed) ||
        !input.reason?.trim() ||
        input.reason.length > 500
      )
        throw new GameError('Loot requires a completed player action and a reason.');
      if (input.memberId) {
        if (!turn.actions.some((action) => action.memberId === input.memberId && !action.passed))
          throw new GameError('Loot must belong to a submitted discovery action.');
        const check = turn.rolls.find((roll) => roll.memberId === input.memberId && !roll.notation);
        if (check && !check.success)
          throw new GameError(
            'A failed search cannot produce its requested loot. Preserve the failed result.',
          );
      }
      const destination =
        input.locationId === 'destination' ||
        input.locationId?.startsWith('new:') ||
        (!!input.locationId &&
          !!input.memberId &&
          !!draft.scene.worldMap?.nodes[input.locationId] &&
          memberScene(draft.scene, input.memberId).location.id !== input.locationId);
      if (destination && !input.memberId)
        throw new GameError('Destination loot needs its discovering character.');
      const place = destination
        ? null
        : input.locationId
          ? placeScene(draft.scene, input.locationId)
          : input.memberId
            ? memberScene(draft.scene, input.memberId)
            : draft.scene;
      if (
        place &&
        input.memberId &&
        place.location.id !== memberScene(draft.scene, input.memberId).location.id
      )
        throw new GameError('A character cannot search a remote location.');
      if (
        (place && hasCombat(place) && !startedCombats(draft)[place.location.id!]) ||
        (input.memberId && fought(draft, input.memberId))
      )
        throw new GameError('Combat loot is awarded by resolve_combat.');
      if (sourceId && place && Object.hasOwn(place.searchedLoot ?? {}, sourceId))
        return { exhausted: true, sourceId, itemName: place.searchedLoot![sourceId] };
      const item = randomLoot(
        randomUUID(),
        Math.max(1, ...draft.members.map((member) => member.state.level)),
        (sides) => this.mechanicalDie(id, turnId, sides, 'Exploration loot rarity', 'world', 'INT'),
        blueprint,
      );
      if (place) {
        offerGroundItem(place, item);
        if (sourceId) place.searchedLoot = { ...place.searchedLoot, [sourceId]: item.name };
        savePlace(draft.scene, place);
      }
      draft.receipts.loot = {
        item,
        reason: input.reason,
        locationId: destination ? input.locationId : place!.location.id,
        ...(destination ? { pendingPlacement: true } : {}),
        ...(sourceId ? { sourceId } : {}),
        ...(input.memberId ? { memberId: input.memberId } : {}),
      };
      return draft.receipts.loot;
    });
  }
  completeChallenge(
    id: string,
    turnId: string,
    input: { memberId: string; reason: string; bossEquivalent: boolean },
  ) {
    return this.withDraft(id, turnId, (draft) => {
      if (draft.receipts.challenge) return draft.receipts.challenge;
      if (!input.reason?.trim() || input.reason.length > 500)
        throw new GameError('Describe the challenge overcome.');
      const locationId = memberScene(draft.scene, input.memberId).location.id!;
      const local = (member: Member) => memberScene(draft.scene, member.id).location.id === locationId;
      if (hasCombat(memberScene(draft.scene, input.memberId)))
        throw new GameError('Resolve or escape combat first.');
      const turn = this.turn(this.pending(id)!);
      const check = turn.rolls.find(
        (r) =>
          r.memberId === input.memberId && !r.notation && r.success && (!input.bossEquivalent || r.dc >= 15),
      );
      if (!check)
        throw new GameError(
          'A completed challenge needs a successful check this turn; a boss equivalent requires DC 15 or higher.',
        );
      if (fought(draft, input.memberId)) throw new GameError('Combat already completed this encounter.');
      draft.scene.encounters++;
      if (input.bossEquivalent) {
        draft.receipts.bossReward = 100;
        for (const member of draft.members)
          if (local(member) && member.state.hp > 0 && turn.roster.includes(member.id)) {
            grantXp(member.character, member.state, 100);
            member.state.bosses++;
          }
      }
      const downed = draft.members.filter(
        (member) => local(member) && member.active && isDowned(member.state),
      );
      const recovery = recoverAfterEncounter(
        draft.members.filter((member) => local(member) && member.active),
      );
      for (const member of draft.members.filter(local))
        if (isDead(member.state)) member.state.respawnReady = true;
      draft.receipts.challenge = {
        locationId,
        reason: input.reason,
        recovery,
        logRecovery: true,
        revived: downed.filter((member) => member.state.hp > 0).map((member) => member.character.name),
        xp: input.bossEquivalent ? 100 : 0,
        members: draft.members.filter((m) => local(m) && turn.roster.includes(m.id)),
      };
      return draft.receipts.challenge;
    });
  }
  private assertResolved(turn: Turn, draft: Draft, outcome: Outcome, adjudication = draft.adjudication) {
    assertCombatClaims(occupiedPlaces(draft.scene), [
      { text: outcome.narration, locationId: draft.scene.location.id },
      { text: outcome.summary, locationId: draft.scene.location.id },
      ...outcome.journal.map((entry) => ({ text: entry.detail })),
      ...(outcome.location
        ? [
            {
              text: `${outcome.location.atmosphere}\n${outcome.location.hazard}`,
              locationId: draft.scene.location.id,
            },
          ]
        : []),
      ...(outcome.placeUpdates ?? []).map((update) => ({
        text: `${update.location.atmosphere}\n${update.location.hazard}`,
        locationId: draft.placeRefs?.[update.ref] ?? update.ref,
      })),
    ]);
    if (outcome.mapUpdates && adjudication?.version !== 2)
      throw new GameError('Map discoveries require structured adjudication with route evidence.');
    const starts = startedCombats(draft);
    const receipts = combatReceipts(draft);
    const localCombat = (memberId: string) =>
      hasCombat(memberScene(draft.scene, memberId)) &&
      !starts[memberScene(draft.scene, memberId).location.id!];
    const blocked = (action: Action, phase: 'main' | 'minor') => {
      if (adjudication?.version !== 2) return false;
      const component = adjudication.actions.find((item) => item.memberId === action.memberId)?.components[
        phase
      ];
      return component?.status === 'blocked' && component.basis === 'none' && !component.receiptRefs.length;
    };
    const orientation = (action: Action) =>
      adjudication?.version === 2 &&
      adjudication.actions.some(
        (result) => result.memberId === action.memberId && result.intent === 'orientation',
      );
    const describeAction = (action: Action) => {
      const member = draft.members.find((member) => member.id === action.memberId);
      const ability = member && requestedAbility(member.character, action, 'utility', null, member.state);
      const text = action.text.length > 100 ? `${action.text.slice(0, 100)}…` : action.text;
      return `${action.characterName ?? member?.character.name ?? action.memberId}${ability ? ` · ${ability.name} (${ability.stat})` : ''}: ${action.passed ? 'passed' : JSON.stringify(text)}`;
    };
    if (turn.number === 0 && outcome.changes.length)
      throw new GameError('The opening scene cannot change characters.');
    // A location update may place the party in the encounter introduced this turn.
    const travelling =
      outcome.sceneFocus && outcome.sceneFocus !== 'current'
        ? (draft.placeRefs?.[outcome.sceneFocus] ?? outcome.sceneFocus) !== draft.scene.location.id
        : outcome.location &&
          (outcome.location.id === null ||
            (outcome.location.id
              ? outcome.location.id !== draft.scene.location.id
              : outcome.location.name !== draft.scene.location.name));
    if (
      hasCombat(draft.scene) &&
      travelling &&
      !starts[draft.scene.location.id!] &&
      !outcome.memberLocations?.length &&
      adjudication?.version !== 2
    )
      throw new GameError('The party cannot leave an active combat through a narrative update.');
    for (const position of outcome.memberLocations ?? []) {
      const member = draft.members.find((candidate) => candidate.id === position.memberId);
      if (!member) throw new GameError('Unknown character location.');
      const place = memberScene(draft.scene, member.id);
      const target =
        position.locationId === 'destination'
          ? outcome.sceneFocus === 'current'
            ? draft.scene.location.id
            : outcome.sceneFocus
              ? (draft.placeRefs?.[outcome.sceneFocus] ?? outcome.sceneFocus)
              : outcome.location?.id
          : position.locationId === 'current'
            ? draft.scene.location.id
            : position.locationId;
      if (
        hasCombat(place) &&
        !starts[place.location.id!] &&
        target !== place.location.id &&
        !member.state.conditions.includes('Escaped')
      )
        throw new GameError('Leaving combat requires a successful escape through the rules engine.');
    }
    for (const locationId of combatLocations(draft.scene)) {
      const encounter = placeScene(draft.scene, locationId).encounter!;
      if (!starts[locationId] && !receipts[locationId])
        throw new GameError(
          `The GM skipped combat resolution for round ${encounter.round} at ${locationId}. Submitted actions: ${turn.actions.map(describeAction).join('; ')}. Retry this saved turn.`,
        );
    }
    if (outcome.changes.some((change) => fought(draft, change.memberId) || localCombat(change.memberId)))
      throw new GameError('Combat state comes from the rules engine; do not apply narrative changes again.');
    const budgets = new Map<string, number>();
    for (const change of outcome.changes) {
      const member = draft.members.find((member) => member.id === change.memberId);
      const removingCondition = change.type === 'condition' && change.remove;
      if (!member || (!turn.roster.includes(member.id) && !(removingCondition && member.active)))
        throw new GameError('The GM referenced a character outside this turn.');
      if (isDead(member.state)) throw new GameError('Permadeath cannot be undone by narrative changes.');
      if (isDowned(member.state) && !removingCondition)
        throw new GameError('A downed character needs healing from an ally.');
      if (change.type === 'hp') {
        if (change.amount > 0)
          throw new GameError(
            'Healing requires use_resource with a spent item or ability; do not add narrative HP.',
          );
        const spent = (budgets.get(member.id) ?? 0) + Math.abs(change.amount);
        if (spent > 6) throw new GameError('Narrative health changes exceed the per-turn limit.');
        budgets.set(member.id, spent);
      }
      if (change.type === 'item')
        throw new GameError(
          'Do not automatically take or discard player items. Offer loot and let the player decide.',
        );
      if (change.type === 'condition' && change.name.toLowerCase() === 'downed')
        throw new GameError('The rules engine controls downing and revival.');
      if (removingCondition && isAilment(change.name)) {
        const actors = turn.actions.filter((action) => {
          const actor = draft.members.find((candidate) => candidate.id === action.memberId)!;
          return (
            !action.passed &&
            !action.supportAction &&
            !incapacitatingCondition(actor.state) &&
            !action.abilityName &&
            !draft.receipts[`resource:ability:${actor.id}`] &&
            memberScene(draft.scene, actor.id).location.id ===
              memberScene(draft.scene, member.id).location.id &&
            !fought(draft, actor.id) &&
            !localCombat(actor.id) &&
            (actor.id === member.id ||
              action.text.toLowerCase().includes(member.character.name.toLowerCase())) &&
            !turn.rolls.some((roll) => roll.memberId === actor.id && !roll.notation && !roll.success)
          );
        });
        if (!actors.length)
          throw new GameError(
            'Removing an ailment requires an available submitted treatment action with a successful check when risky.',
          );
      }
    }
    const unresolved = turn.actions.filter((action) => {
      if (
        action.passed ||
        orientation(action) ||
        fought(draft, action.memberId) ||
        (localCombat(action.memberId) && !starts[memberScene(draft.scene, action.memberId).location.id!]) ||
        action.supportAction ||
        blocked(action, 'main') ||
        draft.receipts[`resource:ability:${action.memberId}`]
      )
        return false;
      const member = draft.members.find((member) => member.id === action.memberId)!;
      if (incapacitatingCondition(member.state)) return false;
      const ability = requestedAbility(member.character, action, 'utility', null, member.state);
      return (
        requiresUtilityCheck(member.character, action, member.state) &&
        !turn.rolls.some(
          (roll) =>
            roll.memberId === action.memberId &&
            !!roll.abilityName &&
            (!ability || roll.abilityName === ability.name),
        )
      );
    });
    if (unresolved.length)
      throw new GameError(
        `The GM skipped the selected utility ability check for: ${unresolved.map(describeAction).join('; ')}. Retry this saved turn.`,
      );
    for (const action of turn.actions) {
      const member = draft.members.find((member) => member.id === action.memberId)!;
      if (
        action.passed ||
        fought(draft, member.id) ||
        (localCombat(member.id) && !starts[memberScene(draft.scene, member.id).location.id!]) ||
        orientation(action) ||
        action.supportAction ||
        member.state.hp <= 0 ||
        incapacitatingCondition(member.state)
      )
        continue;
      const item = requestedConsumable(member, action);
      if (
        item &&
        !draft.receipts[`resource:item:${member.id}`] &&
        !blocked(action, 'main') &&
        !blocked(action, 'minor')
      )
        throw new GameError(
          `Execute ${member.character.name}'s requested ${item.name} through use_resource.`,
        );
      const ability = requestedAbility(member.character, action, undefined, null, member.state);
      if (
        ability?.effect === 'strike' &&
        !blocked(action, 'main') &&
        !turn.rolls.some((roll) => roll.memberId === member.id && roll.abilityName === ability.name)
      )
        throw new GameError(
          `Resolve ${member.character.name}'s requested ${ability.name} against the obstacle through roll_check.`,
        );
      if (
        !ability ||
        blocked(action, 'main') ||
        !['mend', 'cleanse'].includes(ability.effect) ||
        draft.receipts[`resource:ability:${member.id}`] ||
        (member.state.abilityUses?.[abilityUseKey(ability)] ?? 0) >= 1 ||
        turn.rolls.some((roll) => roll.memberId === member.id && !!roll.abilityName)
      )
        continue;
      const target =
        draft.members.find(
          (ally) =>
            ally.id !== member.id && action.text.toLowerCase().includes(ally.character.name.toLowerCase()),
        ) ?? member;
      if (
        !isDead(target.state) &&
        (ability.effect === 'cleanse'
          ? matchingCures(ability, target.state).length > 0
          : target.state.hp < target.state.maxHp || matchingCures(ability, target.state).length > 0)
      )
        throw new GameError(
          `Execute ${member.character.name}'s requested ${ability.name} through use_resource.`,
        );
    }
  }
  private validateResolution(id: string, turnId: string, outcome: Outcome) {
    const row = this.pending(id);
    if (!row || row.id !== turnId || row.phase !== 'resolving')
      throw new GameError('This turn is no longer resolving.', 409);
    const draft: Draft = row.draft
      ? JSON.parse(row.draft)
      : {
          members: this.members(id),
          scene: this.snapshot(id, this.campaign(id).owner_id).scene,
          receipts: {},
        };
    this.assertResolved(this.turn(row), draft, outcomeSchema.parse(outcome));
  }
  private finalizeScene(draft: Draft, outcome: Outcome, opening: boolean, savedMap?: Scene['worldMap']) {
    ensureLocations(
      draft.scene,
      draft.members.map((member) => member.id),
    );
    const priorId = draft.scene.location.id!;
    const origins = { ...draft.scene.memberLocations };
    const starts = startedCombats(draft);
    const legacyId =
      (draft.receipts.startCombatLegacyLocation as string | undefined) ??
      (!draft.receipts.startCombatByLocation && draft.receipts.startCombat ? priorId : undefined);
    const introduced = legacyId ? structuredClone(starts[legacyId]) : null;
    const refs = (draft.placeRefs ??= {});
    for (const update of [...(outcome.placeUpdates ?? []), ...(outcome.mapUpdates?.locations ?? [])])
      if (update.ref.startsWith('new:')) refs[update.ref] ??= randomUUID();
    const focusId =
      outcome.sceneFocus === 'current'
        ? priorId
        : outcome.sceneFocus
          ? (refs[outcome.sceneFocus] ?? outcome.sceneFocus)
          : undefined;
    const moving = focusId
      ? focusId !== priorId
      : outcome.location &&
        (outcome.location.id === null ||
          (outcome.location.id
            ? outcome.location.id !== priorId
            : outcome.location.name !== draft.scene.location.name));
    if (moving && introduced) draft.scene.encounter = draft.context?.scene.encounter ?? null;
    registerPlaces(draft.scene, outcome.placeUpdates ?? [], refs);
    registerMap(draft.scene, outcome.mapUpdates, refs, priorId);
    const focusLocation = focusId ? placeScene(draft.scene, focusId).location : outcome.location;
    const transition = focusLocation
      ? updateLocation(draft.scene, focusLocation)
      : { priorId, destinationId: priorId, travelled: false };
    if (introduced && transition.travelled) {
      if (hasCombat(draft.scene)) throw new GameError('The destination already has an active encounter.');
      draft.scene.encounter = introduced;
    }
    if (
      opening ||
      (draft.adjudication?.version !== 2 &&
        transition.travelled &&
        outcome.location?.id === undefined &&
        !outcome.memberLocations)
    ) {
      // Compatibility: old outputs describe party travel, without individual positions.
      for (const member of draft.members) draft.scene.memberLocations![member.id] = transition.destinationId;
    }
    for (const position of outcome.memberLocations ?? [])
      draft.scene.memberLocations![position.memberId] =
        position.locationId === 'destination'
          ? transition.destinationId
          : position.locationId === 'current'
            ? priorId
            : (refs[position.locationId] ?? position.locationId);
    if (opening && !Object.values(draft.scene.memberLocations!).includes(priorId)) {
      // The campaign setting was a placeholder, not a room the party traversed.
      delete draft.scene.places![priorId];
      delete draft.scene.worldMap!.nodes[priorId];
      draft.scene.worldMap!.connections = draft.scene.worldMap!.connections.filter(
        (edge) => edge.from !== priorId && edge.to !== priorId,
      );
    } else if (!opening)
      recordTravel(
        draft.scene,
        Object.fromEntries(
          Object.entries(origins).filter(
            ([memberId]) =>
              !draft.context?.turn.actions.some((action) => action.memberId === memberId && action.gathering),
          ),
        ),
      );
    if (introduced && transition.travelled && legacyId) {
      delete starts[legacyId];
      starts[transition.destinationId] = introduced;
    }
    const placedStarts: Record<string, Encounter> = {};
    for (const [ref, encounter] of Object.entries(starts)) {
      const locationId = refs[ref] ?? ref;
      if (ref.startsWith('new:') && !refs[ref])
        throw new GameError('A combat destination must be declared in placeUpdates.');
      const place = placeScene(draft.scene, locationId);
      place.encounter = structuredClone(encounter);
      place.encounter.initiative = place.encounter.initiative.filter(
        (entry) =>
          !draft.members.some((member) => member.id === entry.id) ||
          draft.scene.memberLocations![entry.id] === locationId,
      );
      for (const member of draft.members)
        if (draft.scene.memberLocations![member.id] === locationId) delete member.state.respawnReady;
      savePlace(draft.scene, place);
      placedStarts[locationId] = structuredClone(place.encounter);
    }
    if (Object.keys(placedStarts).length) draft.receipts.startCombatByLocation = placedStarts;
    for (const [locationId, encounter] of Object.entries(placedStarts))
      saveNPCEncounter(draft.scene, locationId, encounter);
    const loot = draft.receipts.loot as
      | { item: Item; locationId?: string; pendingPlacement?: boolean; sourceId?: string; memberId?: string }
      | undefined;
    if (loot?.pendingPlacement) {
      const lootId =
        loot.locationId === 'destination'
          ? transition.destinationId
          : (refs[loot.locationId!] ?? loot.locationId);
      if (!loot.memberId || !lootId || draft.scene.memberLocations![loot.memberId] !== lootId)
        throw new GameError('Destination loot requires its discovering character to reach that location.');
      const place = placeScene(draft.scene, lootId);
      if (loot.sourceId && Object.hasOwn(place.searchedLoot ?? {}, loot.sourceId))
        throw new GameError('This destination discovery source is already exhausted.');
      const collected = (draft.receipts.pickups as PickupResult[] | undefined)?.some(
        (pickup) => pickup.itemId === loot.item.id,
      );
      if (!collected) offerGroundItem(place, loot.item);
      if (loot.sourceId) place.searchedLoot = { ...place.searchedLoot, [loot.sourceId]: loot.item.name };
      savePlace(draft.scene, place);
      loot.locationId = lootId;
      delete loot.pendingPlacement;
    }
    ensureWorldMapPositions(draft.scene, savedMap);
    return transition;
  }
  private finalize(id: string, turnId: string) {
    const saved: Draft = JSON.parse(this.pending(id)!.draft!);
    if (saved.resolution) return saved.resolution;
    if (!saved.adjudication) throw new GameError('Finalization requires saved adjudication.');
    if (saved.adjudication.version === 2) assertMovementPositions(saved.context!, saved.adjudication);
    const outcome = adjudicationOutcome(saved.adjudication);
    const criticalImpacts = new Set<number>();
    if (outcome.changes.some((change) => change.type === 'hp' && change.amount < 0))
      this.withDraft(
        id,
        turnId,
        (draft) => {
          const turn = this.turn(this.pending(id)!);
          this.assertResolved(turn, draft, outcome);
          const health = new Map(draft.members.map((member) => [member.id, member.state.hp]));
          outcome.changes.forEach((change, index) => {
            if (change.type !== 'hp') return;
            const hp = health.get(change.memberId) ?? 0;
            if (change.amount < 0 && hp > 0) {
              const failedCritically = turn.rolls.some(
                (roll) => roll.memberId === change.memberId && !roll.notation && roll.critical === 'failure',
              );
              if (
                failedCritically ||
                (-change.amount >= hp &&
                  this.mechanicalDie(
                    id,
                    turnId,
                    20,
                    `Environmental impact (${change.amount} HP): ${change.reason}`,
                    change.memberId,
                    'DEX',
                    0,
                    10,
                    `impact:${change.memberId}`,
                  ) === 20)
              )
                criticalImpacts.add(index);
            }
            health.set(change.memberId, Math.max(0, hp + change.amount));
          }, true);
        },
        true,
      );
    return this.withDraft(
      id,
      turnId,
      (draft) => {
        if (draft.resolution) return draft.resolution;
        const row = this.pending(id)!;
        let adjudication = draft.adjudication!;
        if (adjudication.version === 2 && adjudication.pickups?.length) {
          const pickup = resolvePickups(this.resolutionContext(draft, row), adjudication);
          adjudication = pickup.value;
          draft.members = pickup.members;
          draft.scene = pickup.scene;
          draft.receipts.pickups = pickup.results;
        }
        const config = draft.context!.config;
        const turn = this.turn(row);
        this.assertResolved(turn, draft, outcome);
        const events: TurnResolution['events'][number][] = structuredClone(adjudication.events);
        const add = (fact: string, memberId: string | null, receiptRefs: string[]) => {
          events.push({
            id: `final:${events.length}`,
            sequence: events.length,
            kind: 'mechanics',
            memberId,
            actionId: null,
            fact: combatFact({ config, members: draft.members, turn }, fact),
            receiptRefs,
            dependsOn: [],
            ...(adjudication.version === 2 ? { phase: 'aftermath' as const, result: null } : {}),
          });
        };
        for (const [index, change] of outcome.changes.entries()) {
          const member = draft.members.find((member) => member.id === change.memberId)!;
          if (isDead(member.state)) throw new GameError('Permadeath cannot be undone by narrative changes.');
          if (change.type === 'hp') {
            if (isDowned(member.state)) throw new GameError('A downed character needs healing from an ally.');
            const before = member.state.hp;
            damage(member.state, -change.amount, change.reason, criticalImpacts.has(index));
            add(
              `${member.character.name} loses ${before - member.state.hp} HP: ${change.reason}${member.state.hp === 0 ? (isDowned(member.state) ? ' They are Downed at 0 HP.' : ' They die permanently.') : ''}`,
              member.id,
              turn.rolls.filter((roll) => roll.memberId === member.id).map((roll) => `roll:${roll.id}`),
            );
          } else if (change.type === 'condition') {
            if (change.remove) removeCondition(member.state, change.name);
            else applyCondition(member.state, change.name, member.character);
            add(
              `${member.character.name} ${change.remove ? 'loses' : 'gains'} ${change.name}: ${change.reason}`,
              member.id,
              [],
            );
          }
        }
        if (row.number > 0) {
          const logs: string[] = [];
          for (const member of draft.members.filter((member) => member.active && !fought(draft, member.id))) {
            const action = turn.actions.find((action) => action.memberId === member.id);
            const moving =
              !!action &&
              !action.passed &&
              !incapacitatingCondition(member.state) &&
              !action.abilityName &&
              !action.supportAction &&
              /\b(?:move|walk|run|flee|escape|crawl|climb|jump|loop|ren|vlucht|ontsnap|kruip|klim|spring|beweeg)\b/i.test(
                action.text,
              ) &&
              !/\b(?:do not|don't|won't|will not|niet|geen)\b/i.test(action.text);
            for (const fact of tickConditions(member, moving)) {
              logs.push(fact);
              add(fact, member.id, ['tool:ailments']);
            }
          }
          draft.receipts.ailments = logs;
        }
        for (const member of draft.members) {
          if (
            row.number > 0 &&
            !fought(draft, member.id) &&
            (!hasCombat(memberScene(draft.scene, member.id)) ||
              !!startedCombats(draft)[memberScene(draft.scene, member.id).location.id!]) &&
            turn.roster.includes(member.id)
          ) {
            grantXp(member.character, member.state, bossRewarded(draft, member.id) ? 0 : outcome.xp);
            member.state.gold += outcome.gold;
          }
        }
        const rewards = draft.members.flatMap((member) => {
          const previous = draft.startingMembers!.find((previous) => previous.id === member.id)!;
          const xp = (member.state.level - previous.state.level) * 100 + member.state.xp - previous.state.xp;
          const gold = member.state.gold - previous.state.gold;
          return xp || gold
            ? [
                {
                  memberId: member.id,
                  characterName: member.character.name,
                  xp,
                  gold,
                  reason: fought(draft, member.id)
                    ? 'Resolved combat rewards.'
                    : bossRewarded(draft, member.id)
                      ? 'Completed significant challenge.'
                      : adjudication.rewards.reason,
                },
              ]
            : [];
        });
        this.finalizeScene(draft, outcome, row.number === 0, JSON.parse(this.campaign(id).scene!).worldMap);
        if (adjudication.version === 2) {
          const resolve = (ref: string) =>
            ref === 'current'
              ? draft.context!.scene.location.id!
              : ref === 'destination'
                ? draft.scene.location.id!
                : (draft.placeRefs?.[ref] ?? ref);
          saveEncounterRisks(draft.scene, adjudication, resolve);
          applyNPCUpdates(draft.scene, adjudication, resolve);
          applyFeatureUpdates(draft.scene, adjudication, resolve);
          draft.scene.worldProgression = advanceWorldProgression(draft.context!, adjudication, resolve);
        }
        if (adjudication.version === 2)
          for (const action of adjudication.actions) {
            const search = action.search;
            if (!search) continue;
            const member = draft.members.find((member) => member.id === action.memberId)!;
            const place = memberScene(draft.scene, member.id);
            const information = events.find((event) => event.id === search.informationEventId)!.fact;
            const prior = place.searches?.[search.sourceId];
            const discovery = draft.receipts.loot as { sourceId?: string; locationId?: string } | undefined;
            const discoveryPlace =
              discovery?.locationId === 'destination'
                ? draft.scene.location.id
                : discovery?.locationId === 'current'
                  ? draft.context!.scene.location.id
                  : (draft.placeRefs?.[discovery?.locationId ?? ''] ?? discovery?.locationId);
            const record = {
              ...prior,
              information,
              rewardRolled:
                !!prior?.rewardRolled ||
                (Object.hasOwn(place.searchedLoot ?? {}, search.sourceId) &&
                  !(discovery?.sourceId === search.sourceId && discoveryPlace === place.location.id)),
            };
            const check = turn.rolls.find((roll) => roll.memberId === member.id && !roll.notation);
            if (check?.success && action.components.main?.status === 'success' && !record.rewardRolled) {
              const key = `exploration:${place.location.id}:${search.sourceId}`;
              const chance = this.mechanicalDie(
                id,
                turnId,
                100,
                'Exploration bonus chance (15%)',
                member.id,
                'WIS',
                0,
                10,
                `${key}:chance`,
              );
              let item: Item | null = null;
              if (chance <= 15) {
                let draw = 0;
                item = randomLoot(
                  `search-${tokenHash(`${turnId}:${key}`).slice(0, 24)}`,
                  member.state.level,
                  (sides) =>
                    this.mechanicalDie(
                      id,
                      turnId,
                      sides,
                      'Exploration bonus item',
                      member.id,
                      'WIS',
                      0,
                      10,
                      `${key}:item:${draw++}`,
                    ),
                  search.reward ?? explorationPotion(config.language),
                );
                if (
                  item.kind !== 'consumable' &&
                  !usableSlots(member.character, member.state.stats, item).length
                )
                  item = randomLoot(
                    item.id,
                    member.state.level,
                    () => {
                      throw new Error('A replacement potion must not need more dice.');
                    },
                    explorationPotion(config.language),
                    item.rarity,
                  );
                offerGroundItem(place, item);
                place.searchedLoot = {
                  ...place.searchedLoot,
                  [search.sourceId]: place.searchedLoot?.[search.sourceId] ?? item.name,
                };
                add(
                  config.language === 'Nederlands'
                    ? `${member.character.name} vindt bij ${place.location.name} ${item.name}; het voorwerp blijft daar liggen om op te pakken.`
                    : `${member.character.name} finds ${item.name} at ${place.location.name}; the item remains there to be picked up.`,
                  null,
                  [`roll:${check.id}`, `tool:${key}`],
                );
                const event = events.at(-1)! as import('../shared/turn-resolution').ResolvedEvent;
                event.locationRef = place.location.id;
                event.dependsOn = [{ eventId: `check:${check.id}`, requires: 'success' }];
              }
              record.rewardRolled = true;
              draft.receipts[key] = {
                memberId: member.id,
                locationId: place.location.id,
                sourceId: search.sourceId,
                chance,
                item,
              };
            }
            place.searches = { ...place.searches, [search.sourceId]: record };
            savePlace(draft.scene, place);
          }
        draft.scene.lethalWarning = null;
        if (draft.factions) {
          const receipts =
            adjudication.version === 2
              ? applyFactionEffects(draft.factions, draft.members, adjudication, row.number)
              : [];
          draft.receipts.factionReputation = receipts;
          for (const receipt of receipts) {
            const faction = draft.factions.factions.find((faction) => faction.id === receipt.factionId)!;
            if (faction.discoveredTurn === null) continue;
            const attitude = factionAttitude(receipt.after);
            add(
              config.language === 'Nederlands'
                ? `${faction.name} tegenover ${receipt.characterName}: ${receipt.amount >= 0 ? '+' : ''}${receipt.amount} reputatie (${receipt.before} → ${receipt.after}, ${{ Friendly: 'Vriendelijk', Neutral: 'Neutraal', Hostile: 'Vijandig' }[attitude]}). ${receipt.reason}`
                : `${faction.name} toward ${receipt.characterName}: ${receipt.amount >= 0 ? '+' : ''}${receipt.amount} reputation (${receipt.before} → ${receipt.after}, ${attitude}). ${receipt.reason}`,
              receipt.memberId,
              ['tool:factionReputation'],
            );
            if (adjudication.version === 2)
              (events.at(-1)! as import('../shared/turn-resolution').ResolvedEvent).presentation = 'log';
          }
          const other = outcome.journal.filter((entry) => entry.kind !== 'faction');
          outcome.journal = [
            ...other,
            ...publicFactions(draft.factions).map((faction) => ({
              kind: 'faction' as const,
              name: faction.name,
              detail: faction.knownDescription,
            })),
          ];
        }
        const resolution = turnResolutionSchema.parse({
          version: adjudication.version,
          ...(adjudication.version === 2 && adjudication.arrivals !== undefined
            ? {
                arrivals: adjudication.arrivals.map((arrival) => ({
                  ...arrival,
                  locationId:
                    arrival.locationId === 'current'
                      ? draft.context!.scene.location.id
                      : arrival.locationId === 'destination'
                        ? draft.scene.location.id
                        : (draft.placeRefs?.[arrival.locationId] ?? arrival.locationId),
                })),
              }
            : {}),
          turnId,
          turnNumber: row.number,
          actions: adjudication.actions.map((action) => {
            const actor = draft.startingMembers!.find((member) => member.id === action.memberId)!;
            return { ...action, characterId: actor.characterId, characterName: actor.character.name };
          }),
          events,
          rewards,
          characters: draft.members.map((member) => ({
            memberId: member.id,
            characterName: member.character.name,
            hp: member.state.hp,
            maxHp: member.state.maxHp,
            conditions: member.state.conditions,
            abilityUses: member.state.abilityUses ?? {},
            level: member.state.level,
            xp: member.state.xp,
            gold: member.state.gold,
          })),
          changes: outcome.changes,
          journal: projectJournal(
            journalWithNPCInteractions(outcome.journal, draft.scene, events, draft.context!.journal),
            draft.scene,
            draft.members,
            config.language,
          ),
          location: draft.scene.location,
          partyGoal: config.partyGoal,
          memberLocations: Object.fromEntries(
            draft.members
              .filter((member) => member.active)
              .map((member) => [member.id, draft.scene.memberLocations![member.id]]),
          ),
          knownLocations: knownLocations(draft.scene),
          worldMap: draft.scene.worldMap,
          npcStates: Object.values(knownNPCs(draft.scene)).map((npc) => ({
            id: npc.id,
            name: npc.name,
            aliases: npc.aliases,
            locationId: npc.locationId,
            status: npc.status,
            allegiance: npc.allegiance,
            hp: npc.enemy?.hp ?? null,
            maxHp: npc.enemy?.maxHp ?? null,
            conditions: npc.enemy?.conditions ?? [],
          })),
          featureStates: Object.values(draft.scene.features ?? {}),
          placeRefs: {
            ...draft.placeRefs,
            current: draft.context!.scene.location.id,
            destination: draft.scene.location.id,
          },
          placeStates: occupiedPlaces(draft.scene),
          previousSituation: {
            locationId: draft.context!.scene.location.id,
            memberLocations: draft.context!.scene.memberLocations ?? {},
            places: Object.fromEntries(
              Object.entries(occupiedPlaces(draft.context!.scene)).map(([id, place]) => [
                id,
                { name: place.location.name, hazard: place.location.hazard },
              ]),
            ),
          },
          executionContext: [
            ...draft.startingMembers!.map((member) => ({
              actorId: member.id,
              name: member.character.name,
              description: member.character.appearance,
              personality: member.character.personality,
              equipment: equippedItems(member.state).map(({ name, kind, description }) => ({
                name,
                kind,
                description,
              })),
            })),
            ...[
              ...new Map(
                // Retain equipment used this turn; include newly introduced enemies too.
                [draft.scene, draft.context!.scene]
                  .flatMap((scene) => [
                    scene,
                    ...Object.keys(scene.places ?? {}).map((locationId) => placeScene(scene, locationId)),
                  ])
                  .flatMap((place) => place.encounter?.enemies ?? [])
                  .map((enemy) => [enemy.id, enemy]),
              ).values(),
            ].map((enemy) => ({
              actorId: enemy.id,
              name: enemy.name,
              description: enemy.description,
              equipment: (enemy.equipment ?? []).map(({ name, kind, description }) => ({
                name,
                kind,
                description,
              })),
            })),
          ],
          actionDescriptions: Object.fromEntries(
            turn.actions
              .filter((action) => !action.passed)
              .map((action) => [actionId(turnId, action.memberId), action.text]),
          ),
          checkReasons: Object.fromEntries(
            turn.rolls
              .filter((roll) => !roll.notation && events.some((event) => event.id === `check:${roll.id}`))
              .map((roll) => [`check:${roll.id}`, roll.reason]),
          ),
          factualRecap: [
            ...events.map((event) => event.fact),
            `Location: ${JSON.stringify({ id: draft.scene.location.id, name: draft.scene.location.name, atmosphere: draft.scene.location.atmosphere, hazard: draft.scene.location.hazard })}.`,
            ...outcome.journal.map((entry) => `${entry.kind} ${entry.name}: ${entry.detail}`),
          ].join('\n'),
        });
        // Schema normalization also fixes field order; recovery compares the canonical recap.
        resolution.factualRecap = [
          ...resolution.events.map((event) => event.fact),
          `Location: ${JSON.stringify(resolution.location)}.`,
          ...resolution.journal.map((entry) => `${entry.kind} ${entry.name}: ${entry.detail}`),
        ].join('\n');
        draft.resolution = resolution;
        draft.resolutionRevision ??= 0;
        return resolution;
      },
      true,
    );
  }

  private publish(id: string, turnId: string) {
    this.db.transaction(() => {
      const row = this.pending(id);
      if (!row || row.id !== turnId || row.phase !== 'resolving')
        throw new GameError('This turn is no longer resolving.', 409);
      const draft: Draft = JSON.parse(row.draft!);
      if (!draft.resolution || !draft.narration)
        throw new GameError('Publication requires a saved resolution and accepted narration.');
      if ((draft.narrationRevision ?? 0) !== (draft.resolutionRevision ?? 0))
        throw new GameError('The saved narration belongs to an earlier resolution. Retry narration.');
      const resolution = draft.resolution;
      const narration = assembleResolvedNarration(resolution, draft.narration);
      const dutch = draft.context!.config.language === 'Nederlands';
      const rewards = resolution.rewards.filter((reward) => reward.xp > 0);
      const equipmentChanges = this.turn(row).equipmentChanges ?? [];
      const summary = [
        narration.summary,
        ...(rewards.length
          ? [
              `${dutch ? 'XP-beloningen' : 'XP rewards'}:\n${rewards.map((reward) => `${reward.characterName}: +${reward.xp} XP.`).join('\n')}`,
            ]
          : []),
        ...(equipmentChanges.length
          ? [
              `${dutch ? 'Uitrustingswijzigingen' : 'Equipment changes'}:\n${equipmentChanges.map((change) => `${change.characterName}: ${change.description}`).join('\n')}`,
            ]
          : []),
      ].join('\n\n');
      // Prose has already been validated. Engine appendices may exceed the model summary limit.
      const outcome: Outcome = {
        ...adjudicationOutcome(draft.adjudication!),
        journal: resolution.journal,
        narration: narrationParagraphs(resolution, narration).join('\n\n'),
        summary,
      };
      const completedDraft = json(draft);
      // Only next-turn lifecycle decisions use live replacement metadata.
      const arrivals = this.activateReplacements(id, turnId, draft);
      for (const member of draft.members)
        this.db
          .prepare('UPDATE members SET state = ?, sheet = ?, character_id = ? WHERE id = ?')
          .run(json(member.state), json(member.character), member.characterId, member.id);
      if (draft.factions)
        this.db.prepare('UPDATE campaigns SET factions = ? WHERE id = ?').run(json(draft.factions), id);
      for (const entry of journalWithNPCReactions(
        journalWithNPCInteractions(
          resolution.journal,
          draft.scene,
          resolution.events,
          draft.context?.journal ?? [],
        ),
        draft.receipts,
        draft.context?.journal ?? [],
        draft.context?.config.language,
      ))
        this.db
          .prepare(
            'INSERT INTO journal(campaign_id, kind, name, detail, item_id) VALUES(?, ?, ?, ?, ?) ON CONFLICT(campaign_id, kind, name) DO UPDATE SET detail = excluded.detail, item_id = COALESCE(excluded.item_id, journal.item_id)',
          )
          .run(id, entry.kind, entry.name, entry.detail, entry.itemId ?? null);
      this.db
        .prepare("UPDATE turns SET phase = 'complete', result = ?, draft = ?, error = NULL WHERE id = ?")
        .run(json(outcome), completedDraft, turnId);
      this.db
        .prepare('INSERT INTO events(campaign_id, turn_id, kind, payload) VALUES(?, ?, ?, ?)')
        .run(id, turnId, 'turn_committed', json({ changes: resolution.changes, mechanics: draft.receipts }));
      const members = this.members(id);
      const ended = members.length > 0 && members.every((member) => member.state.hp <= 0);
      this.db
        .prepare('UPDATE campaigns SET version = version + 1, scene = ?, status = ? WHERE id = ?')
        .run(
          json(ensureWorldMapPositions(draft.scene, JSON.parse(this.campaign(id).scene!).worldMap)),
          ended ? 'ended' : 'active',
          id,
        );
      if (!ended) {
        this.newTurn(id, row.number + 1, 'collecting');
        this.recordArrivals(id, this.pending(id)!.id, arrivals);
      }
    })();
  }

  private commit(id: string, turnId: string, input: Outcome) {
    const outcome = outcomeSchema.parse(input);
    outcome.lethalWarning = null;
    // Save lethal-impact dice before the commit so a failed update cannot reroll them.
    const criticalImpacts = new Set<number>();
    if (outcome.changes.some((change) => change.type === 'hp' && change.amount < 0))
      this.withDraft(id, turnId, (draft) => {
        const turn = this.turn(this.pending(id)!);
        this.assertResolved(turn, draft, outcome);
        const health = new Map(draft.members.map((member) => [member.id, member.state.hp]));
        outcome.changes.forEach((change, index) => {
          if (change.type !== 'hp') return;
          const hp = health.get(change.memberId) ?? 0;
          if (change.amount < 0 && hp > 0) {
            const failedCritically = turn.rolls.some(
              (roll) => roll.memberId === change.memberId && !roll.notation && roll.critical === 'failure',
            );
            if (
              failedCritically ||
              (-change.amount >= hp &&
                this.mechanicalDie(
                  id,
                  turnId,
                  20,
                  `Environmental impact (${change.amount} HP): ${change.reason}`,
                  change.memberId,
                  'DEX',
                  0,
                  10,
                  `impact:${change.memberId}`,
                ) === 20)
            )
              criticalImpacts.add(index);
          }
          health.set(change.memberId, Math.max(0, hp + change.amount));
        });
      });
    this.db.transaction(() => {
      const row = this.pending(id);
      if (!row || row.id !== turnId || row.phase !== 'resolving')
        throw new GameError('This turn is no longer resolving.', 409);
      const draft: Draft = row.draft
        ? JSON.parse(row.draft)
        : {
            members: this.members(id),
            scene: this.snapshot(id, this.campaign(id).owner_id).scene,
            receipts: {},
          };
      this.assertResolved(this.turn(row), draft, outcome);
      for (const [index, change] of outcome.changes.entries()) {
        const member = draft.members.find((m) => m.id === change.memberId)!;
        const state = member.state;
        if (isDead(state)) throw new GameError('Permadeath cannot be undone by narrative changes.');
        if (isDowned(state) && change.type === 'hp')
          throw new GameError('A downed character needs healing from an ally.');
        if (change.type === 'hp') {
          if (change.amount < 0) damage(state, -change.amount, change.reason, criticalImpacts.has(index));
          else state.hp = Math.min(state.maxHp, state.hp + change.amount);
          if (state.hp === 0) {
            const dutch = (JSON.parse(this.campaign(id).config) as CampaignConfig).language === 'Nederlands';
            outcome.narration += `\n\n${member.character.name} ${
              isDowned(state)
                ? dutch
                  ? 'is Downed met 0 HP.'
                  : 'is downed at 0 HP.'
                : dutch
                  ? `sterft: ${change.reason}`
                  : `dies: ${change.reason}`
            }`;
          }
        }
        if (change.type === 'condition') {
          if (change.remove) {
            removeCondition(state, change.name);
          } else applyCondition(state, change.name, member.character);
        }
      }
      // Combat receipts have already advanced ailments; only committed noncombat turns tick here.
      if (row.number > 0) {
        const actions = this.turn(row).actions;
        const logs = draft.members
          .filter((member) => member.active && !fought(draft, member.id))
          .flatMap((member) => {
            const action = actions.find((action) => action.memberId === member.id);
            // ponytail: common English/Dutch movement intents; no full natural-language parser.
            const moving =
              !!action &&
              !action.passed &&
              !incapacitatingCondition(member.state) &&
              !action.abilityName &&
              !action.supportAction &&
              /\b(?:move|walk|run|flee|escape|crawl|climb|jump|loop|ren|vlucht|ontsnap|kruip|klim|spring|beweeg)\b/i.test(
                action.text,
              ) &&
              !/\b(?:do not|don't|won't|will not|niet|geen)\b/i.test(action.text);
            return tickConditions(member, moving);
          });
        draft.receipts.ailments = logs;
        if (logs.length) {
          const context = {
            config: JSON.parse(this.campaign(id).config) as CampaignConfig,
            members: draft.members,
            turn: this.turn(row),
          };
          const facts = logs.map((log) => combatFact(context, log)).join('\n');
          outcome.narration += `\n\n${facts}`;
          outcome.summary += `\n\n${facts}`;
        }
      }
      for (const member of draft.members) {
        if (
          row.number > 0 &&
          !fought(draft, member.id) &&
          (!hasCombat(memberScene(draft.scene, member.id)) ||
            !!startedCombats(draft)[memberScene(draft.scene, member.id).location.id!]) &&
          (JSON.parse(row.roster) as string[]).includes(member.id)
        ) {
          grantXp(member.character, member.state, bossRewarded(draft, member.id) ? 0 : outcome.xp);
          member.state.gold += outcome.gold;
        }
      }
      const previousMembers = this.members(id);
      const xpRewards = draft.members.flatMap((member) => {
        const previous = previousMembers.find((saved) => saved.id === member.id)!;
        const gained =
          (member.state.level - previous.state.level) * 100 + member.state.xp - previous.state.xp;
        return gained > 0 ? [`${member.character.name}: +${gained} XP.`] : [];
      });
      if (xpRewards.length) {
        const dutch = (JSON.parse(this.campaign(id).config) as CampaignConfig).language === 'Nederlands';
        outcome.summary += `\n\n${dutch ? 'XP-beloningen' : 'XP rewards'}:\n${xpRewards.join('\n')}`;
      }
      // Keep the actors' identities even when a new life reuses their membership.
      const completedDraft = json(draft);
      this.finalizeScene(draft, outcome, row.number === 0, JSON.parse(this.campaign(id).scene!).worldMap);
      const arrivals = this.activateReplacements(id, turnId, draft);
      draft.scene.lethalWarning = outcome.lethalWarning;
      for (const member of draft.members)
        this.db
          .prepare('UPDATE members SET state = ?, sheet = ?, character_id = ? WHERE id = ?')
          .run(json(member.state), json(member.character), member.characterId, member.id);
      for (const entry of journalWithNPCReactions(
        outcome.journal,
        draft.receipts,
        draft.context?.journal ?? [],
        draft.context?.config.language,
      ))
        this.db
          .prepare(
            'INSERT INTO journal(campaign_id, kind, name, detail, item_id) VALUES(?, ?, ?, ?, ?) ON CONFLICT(campaign_id, kind, name) DO UPDATE SET detail = excluded.detail, item_id = COALESCE(excluded.item_id, journal.item_id)',
          )
          .run(id, entry.kind, entry.name, entry.detail, entry.itemId ?? null);
      const equipmentChanges = this.turn(row).equipmentChanges ?? [];
      if (equipmentChanges.length) {
        const dutch = (JSON.parse(this.campaign(id).config) as CampaignConfig).language === 'Nederlands';
        outcome.summary += `\n\n${dutch ? 'Uitrustingswijzigingen' : 'Equipment changes'}:\n${equipmentChanges.map((change) => `${change.characterName}: ${change.description}`).join('\n')}`;
      }
      this.db
        .prepare("UPDATE turns SET phase = 'complete', result = ?, draft = ?, error = NULL WHERE id = ?")
        .run(json(outcome), completedDraft, turnId);
      this.db
        .prepare('INSERT INTO events(campaign_id, turn_id, kind, payload) VALUES(?, ?, ?, ?)')
        .run(id, turnId, 'turn_committed', json({ changes: outcome.changes, mechanics: draft.receipts }));
      const currentMembers = this.members(id);
      const ended = currentMembers.length > 0 && currentMembers.every((m) => m.state.hp <= 0);
      this.db
        .prepare('UPDATE campaigns SET version = version + 1, scene = ?, status = ? WHERE id = ?')
        .run(json(draft.scene), ended ? 'ended' : 'active', id);
      if (!ended) {
        this.newTurn(id, row.number + 1, 'collecting');
        this.recordArrivals(id, this.pending(id)!.id, arrivals);
      }
    })();
  }
  manageCharacter(
    id: string,
    playerId: string,
    action: {
      type: string;
      itemId?: string;
      itemIds?: string[];
      slot?: Slot;
      targetId?: string;
      abilityName?: string;
      dropItemIds?: string[];
    },
  ) {
    this.db.transaction(() => {
      const c = this.campaign(id);
      const row = this.pending(id);
      if (row && row.phase !== 'collecting') throw new GameError('Wait until this round finishes.');
      const members = this.members(id);
      const member = members.find((m) => m.playerId === playerId);
      if (!member) throw new GameError('Join this campaign first.', 403);
      if (this.leveling.has(member.id)) throw new GameError('Your level-up reward is being generated.', 409);
      if (member.state.hp <= 0) throw new GameError('This character’s run has ended.');
      if (row && this.turn(row).actions.some((a) => a.memberId === member.id))
        throw new GameError('You already submitted this turn. Equipment and stats are locked.');
      const worldScene: Scene = ensureLocations(
        c.scene ? JSON.parse(c.scene) : initialScene(JSON.parse(c.config).setting),
        members.map((member) => member.id),
      );
      const scene = memberScene(worldScene, member.id);
      const state = member.state;
      if (action.dropItemIds?.length && !['take', 'take-equip'].includes(action.type))
        throw new GameError('Choose items to drop only when taking scene loot.');
      const inCombat = isInCombat(scene, state);
      if (
        scene.encounter &&
        !scene.encounter.victory &&
        !scene.encounter.escaped &&
        ['take', 'take-equip'].includes(action.type)
      )
        throw new GameError('Scene loot can only be taken outside combat, after the encounter ends.');
      if (inCombat && ['equip', 'unequip', 'take', 'take-equip', 'drop'].includes(action.type))
        throw new GameError('Equipment can only be changed outside combat.');
      if (inCombat && action.type === 'heal' && action.abilityName)
        throw new GameError('During combat, describe this as your main or minor action in chat.');
      const before = equippedItems(state);
      const source = action.itemId
        ? [...state.inventory, ...scene.loot].find((item) => item.id === action.itemId)
        : action.slot
          ? state.equipment[action.slot]
          : null;
      const dropped = (action.dropItemIds ?? []).map((id) => state.inventory.find((item) => item.id === id));
      if (action.type === 'starter') {
        chooseStartingEquipment(member.character, state, action.itemIds ?? []);
      } else if (action.type === 'equip' && action.itemId && action.slot)
        equip(member.character, state, action.itemId, action.slot);
      else if (action.type === 'unequip' && action.slot) unequip(member.character, state, action.slot);
      else if (action.type === 'help-up' || action.type === 'heal') {
        const incapacitated = incapacitatingCondition(state);
        if (incapacitated) throw new GameError('This character cannot use that action while incapacitated.');
        const target = action.targetId ? members.find((m) => m.id === action.targetId) : member;
        if (!target) throw new GameError('Choose an ally in this campaign.');
        if (memberScene(worldScene, target.id).location.id !== scene.location.id)
          throw new GameError('That ally is at another location.');
        if (!canInteract(scene, state, target.state))
          throw new GameError(
            'Escaped characters cannot interact with party members still in combat. Rejoin the fight first.',
          );
        if (action.type === 'help-up' || (action.itemId && target.id !== member.id)) {
          if (!row || c.status !== 'active' || !JSON.parse(row.roster).includes(member.id))
            throw new GameError('Helping an ally requires your action in an active turn.');
          if (target.id === member.id || !target.active || isDead(target.state))
            throw new GameError(
              isDead(target.state)
                ? 'A dead character cannot be healed.'
                : 'Choose a living ally in this campaign.',
            );
          if (action.type === 'help-up') helpUp(structuredClone(target.state));
          else {
            if (target.state.hp >= target.state.maxHp)
              throw new GameError('The target is already at full health.');
            healWithItem(member.character, structuredClone(state), action.itemId!, {
              character: target.character,
              state: structuredClone(target.state),
            });
          }
          const dutch = (JSON.parse(c.config) as CampaignConfig).language === 'Nederlands';
          const text =
            action.type === 'help-up'
              ? dutch
                ? `Ik help ${target.character.name} overeind.`
                : `I help up ${target.character.name}.`
              : dutch
                ? `Ik gebruik ${source!.name} op ${target.character.name}.`
                : `Use ${source!.name} on ${target.character.name}.`;
          this.submit(
            id,
            playerId,
            row.id,
            text,
            false,
            false,
            null,
            action.type === 'help-up'
              ? { type: 'help-up', targetId: target.id }
              : { type: 'heal-ally', targetId: target.id, itemId: action.itemId! },
          );
          this.db.prepare('UPDATE campaigns SET version = version + 1 WHERE id = ?').run(id);
          return;
        }
        if (action.abilityName) {
          if (!row || c.status !== 'active') throw new GameError('Healing abilities require an active turn.');
          const ability = availableAbility(member.character, state, action.abilityName);
          if (!['mend', 'cleanse'].includes(ability.effect))
            throw new GameError('Choose a healing or cleansing ability.');
          if (isDead(target.state)) throw new GameError('A dead character cannot be healed.');
          if (ability.effect === 'cleanse' && !matchingCures(ability, target.state).length)
            throw new GameError('The target has no matching ailment.');
          if (
            ability.effect === 'mend' &&
            target.state.hp >= target.state.maxHp &&
            !matchingCures(ability, target.state).length
          )
            throw new GameError('The target is already at full health.');
          this.submit(
            id,
            playerId,
            row.id,
            `Use ${ability.name} on ${target.character.name}.`,
            false,
            false,
            ability.name,
          );
          return;
        }
        if (!!action.itemId === !!action.abilityName)
          throw new GameError('Choose a healing item or a healing ability.');
        healWithItem(member.character, state, action.itemId!, target);
      } else if (action.type === 'drop' && action.itemId) {
        const item = removeItem(state, action.itemId);
        offerGroundItem(scene, item);
      } else if (['take', 'take-equip'].includes(action.type) && action.itemId) {
        if (action.type === 'take-equip' && !action.slot) throw new GameError('Choose an equipment slot.');
        takeItem(
          member.character,
          state,
          scene,
          action.itemId,
          action.type === 'take-equip' ? action.slot : undefined,
          action.dropItemIds,
        );
      } else throw new GameError('Unknown character action.');
      if (row && ['equip', 'unequip', 'take', 'take-equip', 'drop'].includes(action.type)) {
        const dutch = (JSON.parse(c.config) as CampaignConfig).language === 'Nederlands';
        const destinations = {
          left: 'left hand',
          right: 'right hand',
          body: 'body',
          head: 'head',
          boots: 'feet',
          relic: 'relic slot',
        };
        const dutchDestinations = {
          left: 'linkerhand',
          right: 'rechterhand',
          body: 'lichaam',
          head: 'hoofd',
          boots: 'voeten',
          relic: 'relikwieslot',
        };
        const equipped = action.type === 'equip' || action.type === 'take-equip';
        const bothHands = (action.slot === 'left' || action.slot === 'right') && source?.hands === 2;
        let description = equipped
          ? dutch
            ? `${source!.name} uitgerust (${bothHands ? 'beide handen' : dutchDestinations[action.slot!]}).`
            : `Equipped ${source!.name} (${bothHands ? 'both hands' : destinations[action.slot!]}).`
          : `${({ unequip: dutch ? 'Opgeborgen' : 'Stowed', take: dutch ? 'Opgepakt' : 'Took', drop: dutch ? 'Neergelegd' : 'Dropped' } as Record<string, string>)[action.type]} ${source!.name}.`;
        const displaced = before.filter(
          (item) => !equippedItems(state).some((equipped) => equipped.id === item.id),
        );
        if (equipped && displaced.length)
          description += ` ${dutch ? 'Opgeborgen' : 'Stowed'}: ${displaced.map((item) => item.name).join(', ')}.`;
        if (dropped.length)
          description += ` ${dutch ? 'Neergelegd' : 'Dropped'}: ${dropped.map((item) => `${item!.name} ×${item!.quantity}`).join(', ')}.`;
        this.db.prepare('INSERT INTO events(campaign_id, turn_id, kind, payload) VALUES(?, ?, ?, ?)').run(
          id,
          row.id,
          'equipment_changed',
          json({
            buildId: gameplayBuildId,
            memberId: member.id,
            characterName: member.character.name,
            description,
            locationId: scene.location.id,
            action: action.type,
            itemId: action.itemId,
            droppedItemIds: action.dropItemIds,
          }),
        );
      }
      this.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(json(state), member.id);
      savePlace(worldScene, scene);
      this.db
        .prepare('UPDATE campaigns SET scene = ?, version = version + 1 WHERE id = ?')
        .run(json(worldScene), id);
    })();
    this.emit(id);
    this.kick(id);
    return this.snapshot(id, playerId);
  }
  async levelUp(id: string, playerId: string, input: unknown) {
    const choice = levelUpChoiceSchema.parse(input);
    const campaign = this.campaign(id);
    const member = this.members(id).find((m) => m.playerId === playerId);
    if (!member) throw new GameError('Join this campaign first.', 403);
    const pending = this.pending(id);
    if (
      campaign.status !== 'active' ||
      !pending ||
      pending.phase !== 'collecting' ||
      this.turn(pending).actions.some((a) => a.memberId === member.id)
    )
      throw new GameError('Wait until this round finishes before choosing a reward.');
    if (member.state.hp <= 0 || member.state.pendingLevelUps < 1)
      throw new GameError('No level-up reward is available.');
    if (this.leveling.has(member.id)) throw new GameError('Your level-up reward is being generated.', 409);
    const config: CampaignConfig = JSON.parse(campaign.config);
    const provider = this.providers(campaign.owner_id, config);
    if (!provider.levelUp) throw new GameError('Level-up generation is not available.');
    this.leveling.add(member.id);
    try {
      if (this.diceFor) await this.diceFor(config).prepare();
      const kind = choice.endsWith('combat') ? 'combat' : 'utility';
      const candidates = member.character.abilities
        .map((a, i) => ({ ...a, index: i }))
        .filter((a) => a.kind === kind);
      if (choice.startsWith('upgrade') && !candidates.length)
        throw new GameError('There is no current ability in that category to upgrade.');
      const targetIndex = choice.startsWith('upgrade')
        ? candidates[candidates.length === 1 ? 0 : this.die(id, candidates.length) - 1].index
        : -1;
      const context: LevelUpContext = {
        config,
        character: member.character,
        state: member.state,
        choice,
        target: member.character.abilities[targetIndex] ?? null,
        attributes:
          choice === 'attributes'
            ? [stats[this.die(id, stats.length) - 1], stats[this.die(id, stats.length) - 1]]
            : [],
      };
      const reward = validateLevelUpReward(context, await provider.levelUp(structuredClone(context)));
      this.db.transaction(() => {
        const current = this.members(id).find((m) => m.id === member.id)!;
        const turn = this.pending(id);
        if (
          !turn ||
          turn.id !== pending.id ||
          turn.phase !== 'collecting' ||
          json(current.state) !== json(member.state) ||
          json(current.character) !== json(member.character)
        )
          throw new GameError('Your character changed while generating this reward. Please try again.', 409);
        if (reward.ability) {
          if (targetIndex < 0) current.character.abilities.push(reward.ability);
          else current.character.abilities[targetIndex] = reward.ability;
        } else gainAttributes(current.character, current.state, context.attributes);
        current.state.pendingLevelUps--;
        current.state.lastLevelUp = reward.ability
          ? `${reward.ability.name} · Level ${reward.ability.level}: ${abilityMechanics(reward.ability)}. ${reward.description}`
          : `${context.attributes.map((stat) => `+1 ${stat}`).join(', ')}: ${reward.description}`;
        this.db
          .prepare('UPDATE members SET sheet = ?, state = ? WHERE id = ?')
          .run(json(current.character), json(current.state), member.id);
        this.db.prepare('UPDATE campaigns SET version = version + 1 WHERE id = ?').run(id);
      })();
      this.emit(id);
      return this.snapshot(id, playerId);
    } finally {
      this.leveling.delete(member.id);
    }
  }
  private async resolutionStage<T>(
    id: string,
    turnId: string,
    stage: string,
    budget: StageBudget,
    work: () => Promise<T> | T,
  ) {
    while (true) {
      const started = Date.now();
      const progress = (next: NonNullable<Turn['progress']>['stage']) => {
        this.withDraft(
          id,
          turnId,
          (draft) => {
            const now = new Date().toISOString();
            draft.progress = {
              stage: next,
              startedAt: draft.progress?.startedAt ?? now,
              stageStartedAt: now,
            };
          },
          true,
        );
        this.emit(id);
      };
      progress(stage as NonNullable<Turn['progress']>['stage']);
      // Callbacks stay out of cloned/saved GM contexts and diagnostic payloads.
      Object.defineProperty(budget, 'progress', { value: progress, configurable: true, enumerable: false });
      budget.used = 0;
      budget.requests = [];
      budget.corrections = [];
      budget.fallback = undefined;
      budget.signal = AbortSignal.timeout(['adjudication', 'factions'].includes(stage) ? 360_000 : 180_000);
      const attempt =
        (
          this.db
            .prepare('SELECT COUNT(*) AS count FROM events WHERE turn_id = ? AND kind = ?')
            .get(turnId, `stage:${stage}`) as { count: number }
        ).count + 1;
      let failure: string | null = null;
      budget.traceContext = { campaignId: id, turnId, turnNumber: this.pending(id)?.number, stage, attempt };
      let failureCategory: string | null = null;
      try {
        return await work();
      } catch (error) {
        failure = error instanceof Error ? error.message.slice(0, 2000) : 'Unknown failure';
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        failureCategory = timedOut
          ? 'timeout'
          : error instanceof GameError
            ? 'validation-or-provider'
            : error instanceof SyntaxError
              ? 'format'
              : 'interruption';
        // Durable per-turn limit also applies across stages, manual retries and server restarts.
        if (
          timedOut &&
          ['adjudication', 'narration'].includes(stage) &&
          !this.db.prepare("SELECT 1 FROM events WHERE turn_id = ? AND kind = 'turn_auto_retry'").get(turnId)
        ) {
          this.db
            .prepare('INSERT INTO events(campaign_id, turn_id, kind, payload) VALUES(?, ?, ?, ?)')
            .run(id, turnId, 'turn_auto_retry', json({ stage, reason: failure }));
          this.emit(id);
          continue;
        }
        throw new GameError(`${stage}: ${failure} Retry resumes from the last saved checkpoint.`, 500);
      } finally {
        this.db.prepare('INSERT INTO events(campaign_id, turn_id, kind, payload) VALUES(?, ?, ?, ?)').run(
          id,
          turnId,
          `stage:${stage}`,
          json({
            buildId: gameplayBuildId,
            attempt,
            requests: budget.used,
            durationMs: Date.now() - started,
            failure,
            failureCategory,
            requestDiagnostics: budget.requests,
            corrections: budget.corrections,
            fallback: budget.fallback,
          }),
        );
      }
    }
  }

  private resolutionContext(draft: Draft, row: TurnRow): GMContext {
    return {
      ...draft.context!,
      members: draft.members,
      startingMembers: draft.startingMembers,
      scene: { ...draft.scene, npcs: knownNPCs(draft.scene) },
      factions: draft.factions,
      turn: this.turn(row),
      receipts: draft.receipts,
      resourceUses: Object.entries(draft.receipts)
        .filter(([key]) => key.startsWith('resource:'))
        .map(([, receipt]) => receipt as ResourceReceipt),
      supportResults: draft.receipts.support as SupportResult[] | undefined,
      recoveryLogs: (draft.receipts.challenge as { recovery?: string[] } | undefined)?.recovery,
      combatResult: draft.receipts.combat as CombatReceipt | undefined,
    };
  }
  private combatContext(context: GMContext, locationId = context.scene.location.id!): GMContext {
    const members = context.members.filter(
      (member) => memberScene(context.scene, member.id).location.id === locationId,
    );
    const ids = new Set(members.map((member) => member.id));
    return {
      ...context,
      scene: placeScene(context.scene, locationId),
      members,
      turn: {
        ...context.turn,
        roster: context.turn.roster.filter((id) => ids.has(id)),
        actions: context.turn.actions.filter((action) => ids.has(action.memberId)),
      },
    };
  }

  private recoverTurnCheckpoints(id: string, turnId: string): Draft {
    return this.db.transaction(() => {
      const row = this.pending(id);
      if (!row || row.id !== turnId || row.phase !== 'resolving')
        throw new GameError('This turn is no longer resolving.', 409);
      const draft: Draft = JSON.parse(row.draft!);
      const repair = repairTurnCheckpoints(draft, this.resolutionContext(draft, row));
      if (repair) {
        this.db.prepare('UPDATE turns SET draft = ? WHERE id = ?').run(json(draft), turnId);
        this.db
          .prepare('INSERT INTO events(campaign_id, turn_id, kind, payload) VALUES(?, ?, ?, ?)')
          .run(id, turnId, 'checkpoint_repaired', json(repair));
      }
      return draft;
    })();
  }

  private async initializeFactions(id: string, turnId: string, provider: GameMaster) {
    let saved: Draft = JSON.parse(this.pending(id)!.draft!);
    // Started legacy checkpoints keep their original route. Test-only providers may omit world generation.
    if (
      saved.adjudication ||
      saved.resolution ||
      (!saved.factions && (!saved.factionLifecycle || !provider.generateFactions))
    )
      return;
    if (saved.receipts.factionInitializationComplete) return;
    const needsWorld = !saved.factions;
    const eligible = saved.members.filter(
      (member) => !member.state.factionInitialized && saved.context!.turn.roster.includes(member.id),
    );
    if (!needsWorld && !eligible.length) return;
    const budget: StageBudget = { used: 0, limit: 6 };
    await this.resolutionStage(id, turnId, 'factions', budget, async () => {
      saved = JSON.parse(this.pending(id)!.draft!);
      if (!saved.factions) {
        const example = this.withDraft(id, turnId, (draft) => {
          if (!draft.receipts.factionSeed) {
            const count = Math.max(
              3,
              draft.context!.journal.filter((entry) => entry.kind === 'faction').length,
            );
            if (count > 6)
              throw new GameError(
                'This world has more than six established factions; consolidate the journal before initialization.',
              );
            draft.receipts.factionBackfill = draft.context!.turn.number > 0;
            draft.receipts.factionSeed = factionExample(
              Array.from({ length: count }, () => randomUUID()),
              draft.context!.config.setting,
              draft.context!.journal,
              draft.context!.turn.number,
            );
          }
          return draft.receipts.factionSeed as FactionWorld;
        });
        const world = validateGeneratedWorld(
          await provider.generateFactions!(structuredClone(saved.context!), example, budget),
          example,
        );
        this.withDraft(id, turnId, (draft) => {
          draft.factions = world;
          draft.context!.factions = world;
        });
      }
      saved = JSON.parse(this.pending(id)!.draft!);
      const candidates = this.withDraft(id, turnId, (draft) => {
        if (!draft.receipts.factionCandidates) {
          // Backfill retains established history without inventing starting connections.
          draft.receipts.factionCandidates = eligible.map((member) => ({
            memberId: member.id,
            characterId: member.characterId,
            generated:
              !draft.receipts.factionBackfill &&
              member.state.factionConnectionPreference !== 'unaffiliated' &&
              this.draw(100) <= 25,
          }));
        }
        return draft.receipts.factionCandidates as ConnectionCandidate[];
      });
      const context = this.resolutionContext(JSON.parse(this.pending(id)!.draft!), this.pending(id)!);
      const backfill = (JSON.parse(this.pending(id)!.draft!) as Draft).receipts.factionBackfill;
      const possibleConnections = candidates.filter((candidate) => {
        const member = context.members.find((member) => member.id === candidate.memberId)!;
        return (
          candidate.generated ||
          context.factions!.factions.some((faction) =>
            `${member.character.concept} ${member.character.background}`
              .toLowerCase()
              .includes(faction.name.toLowerCase()),
          )
        );
      });
      const connections = backfill
        ? []
        : provider.connectFactions && possibleConnections.length
          ? validateConnections(
              (await provider.connectFactions(context, possibleConnections, budget)).map((connection) =>
                factionConnectionSchema.parse(connection),
              ),
              context,
              candidates,
            )
          : [];
      this.withDraft(id, turnId, (draft) => {
        const introductions: string[] = [];
        for (const candidate of candidates) {
          const member = draft.members.find(
            (member) => member.id === candidate.memberId && member.characterId === candidate.characterId,
          )!;
          member.state.factionInitialized = true;
          member.state.factionReputation ??= {};
          const connection = connections.find((connection) => connection.memberId === member.id);
          if (connection) {
            const faction = draft.factions!.factions.find((faction) => faction.id === connection.factionId)!;
            member.state.factionAffiliation = {
              factionId: faction.id,
              kind: connection.kind,
              reason: connection.reason,
            };
            member.state.factionReputation[faction.id] = connection.score;
            faction.discoveredTurn ??= draft.context!.turn.number;
            const description = faction.knownDescription.includes(connection.knownDescription)
              ? faction.knownDescription
              : [faction.knownDescription, connection.knownDescription].filter(Boolean).join('\n\n');
            if (description.length > 6000)
              throw new GameError('Connection facts exceed the public faction description limit.');
            faction.knownDescription = description;
            introductions.push(
              draft.context!.config.language === 'Nederlands'
                ? `${member.character.name} kent ${faction.name}: ${connection.reason} ${connection.knownDescription}`
                : `${member.character.name} knows ${faction.name}: ${connection.reason} ${connection.knownDescription}`,
            );
          }
          Object.assign(draft.startingMembers!.find((previous) => previous.id === member.id)!.state, {
            factionInitialized: true,
            factionReputation: structuredClone(member.state.factionReputation),
            factionAffiliation: member.state.factionAffiliation,
          });
        }
        assertPublicFactionText(draft.factions, JSON.stringify(introductions));
        draft.receipts.factionIntroductions = introductions;
        draft.receipts.factionConnections = connections;
        draft.receipts.factionInitializationComplete = true;
        draft.context!.members = draft.members;
        draft.context!.factions = draft.factions;
      });
    });
  }

  private async runResolvedTurn(id: string, turnId: string, provider: GameMaster) {
    await this.initializeFactions(id, turnId, provider);
    let saved = this.recoverTurnCheckpoints(id, turnId);
    const config = saved.context!.config;
    const budget: StageBudget = { used: 0, limit: 8 };
    if (!saved.adjudication)
      await this.resolutionStage(id, turnId, 'adjudication', budget, async () => {
        if (this.diceFor && saved.context!.turn.number > 0) await this.diceFor(config).prepare();
        const context: GMContext = structuredClone(saved.context!);
        context.requestBudget = budget;
        const refresh = <T>(result: T): T => {
          const row = this.pending(id)!;
          saved = JSON.parse(row.draft!);
          Object.assign(context, this.resolutionContext(saved, row));
          return result;
        };
        refresh(undefined);
        let toolCalls = 0;
        for (const locationId of combatLocations(context.scene)) {
          if (combatReceipts(saved)[locationId] || startedCombats(saved)[locationId]) continue;
          const combatContext = this.combatContext(context, locationId);
          const inputs = saved.receipts.combatInputByLocation as Record<string, CombatInput> | undefined;
          const suggested =
            inputs?.[locationId] ??
            (locationId === context.scene.location.id ? saved.receipts.combatInput : undefined) ??
            (await provider.planCombat?.(combatContext));
          const plan = this.withDraft(id, turnId, (draft) => {
            const plan = normalizeCombatInput(combatContext, suggested);
            draft.receipts.combatInputByLocation = { ...inputs, [locationId]: plan };
            draft.receipts.combatInput ??= plan;
            return plan;
          });
          toolCalls++;
          refresh(this.combat(id, turnId, plan, locationId));
        }
        if (context.turn.actions.some((action) => action.supportAction && !fought(saved, action.memberId))) {
          toolCalls++;
          refresh(this.resolveSupport(id, turnId));
        }
        const execute = <T>(work: () => T, introduction = false): T => {
          if (++toolCalls > 20) throw new GameError('Adjudication reached its twenty-tool limit.');
          if (saved.receipts.encounterProposal && !introduction)
            throw new GameError(
              'Exploration outcomes are saved. Only introduce the required encounters; further actions wait for next submissions.',
            );
          const result = refresh(work());
          this.withDraft(id, turnId, (draft) => {
            draft.receipts.executionEvents = engineEvents(context);
          });
          return refresh(result);
        };
        const validate = (input: unknown) => {
          refresh(undefined);
          const value = validateAdjudication(context, input);
          this.assertResolved(context.turn, saved, adjudicationOutcome(value), value);
          return value;
        };
        const tools: GameTools = Object.assign(
          (input: Check) => execute(() => this.roll(id, turnId, input)),
          {
            startCombat: (enemies: unknown, locationId?: string) =>
              execute(() => this.startCombat(id, turnId, enemies, locationId), true),
            combat: (input: CombatInput, locationId?: string) =>
              execute(() => this.combat(id, turnId, input, locationId)),
            offerLoot: (input: Parameters<GameTools['offerLoot']>[0]) =>
              execute(() => this.offerLoot(id, turnId, input)),
            completeChallenge: (input: { memberId: string; reason: string; bossEquivalent: boolean }) =>
              execute(() => this.completeChallenge(id, turnId, input)),
            useResource: (input: ResourceUse) => execute(() => this.useResource(id, turnId, input)),
            validateAdjudication: validate,
            prepareEncounters: (value: TurnAdjudication) =>
              refresh(this.prepareEncounters(id, turnId, value)),
            validateResolution: (outcome: Outcome) => this.assertResolved(context.turn, saved, outcome),
          },
        );
        const accepted = validate(
          completedEncounterProposal(context) ?? (await provider.adjudicate!(context, tools)),
        );
        if (accepted.encounterRisks !== undefined || context.receipts?.encounterChecks) {
          const required = tools.prepareEncounters!(accepted);
          if (required.length)
            throw new GameError('Saved random encounters must be introduced before this turn can finish.');
        }
        this.withDraft(
          id,
          turnId,
          (draft) => {
            draft.adjudication = accepted;
            draft.adjudicationFallback = budget.fallback;
            draft.placeRefs ??= {};
            for (const update of accepted.placeUpdates ?? [])
              if (update.ref.startsWith('new:')) draft.placeRefs[update.ref] ??= randomUUID();
          },
          true,
        );
      });
    saved = JSON.parse(this.pending(id)!.draft!);
    if (!saved.resolution)
      await this.resolutionStage(id, turnId, 'finalization', { used: 0, limit: 0 }, async () => {
        if (this.diceFor && saved.context!.turn.number > 0) await this.diceFor(config).prepare();
        return this.finalize(id, turnId);
      });
    saved = JSON.parse(this.pending(id)!.draft!);
    const narrationBudget: StageBudget = { used: 0, limit: 4 };
    if (!saved.narration)
      await this.resolutionStage(id, turnId, 'narration', narrationBudget, async () => {
        const revision = saved.resolutionRevision ?? 0;
        if (saved.adjudicationFallback)
          narrationBudget.fallback =
            'Narration skipped because adjudication fell back to saved receipts; no extra model requests can establish the missing world outcomes.';
        let proposed: TurnNarration;
        try {
          proposed = saved.adjudicationFallback
            ? factualNarration(saved.resolution!, config.language)
            : await provider.narrate!(structuredClone(saved.resolution!), config, narrationBudget);
        } catch (error) {
          // Presentation failures cannot hold already finalized gameplay hostage.
          narrationBudget.fallback = `Narration unavailable; published saved facts. ${
            error instanceof Error ? error.message : 'Unknown provider failure.'
          }`.slice(0, 2000);
          proposed = factualNarration(saved.resolution!, config.language);
        }
        let narration: TurnNarration;
        try {
          narration = assembleResolvedNarration(saved.resolution!, proposed);
          const values = narrationParagraphs(saved.resolution!, narration).concat(narration.summary);
          assertPublicFactionText(saved.factions, JSON.stringify(narration));
          for (const action of saved.context!.turn.actions) {
            if (
              action.text.trim() &&
              values.some(
                (value) => value.trim() === action.text.trim() || /\b(?:attempts|probeert)\s*:/i.test(value),
              )
            )
              throw new GameError('Narration copied a submission instead of describing its outcome.');
          }
        } catch (error) {
          narrationBudget.fallback =
            error instanceof Error ? error.message.slice(0, 2000) : 'Invalid narration.';
          narration = factualNarration(saved.resolution!, config.language);
        }
        this.withDraft(
          id,
          turnId,
          (draft) => {
            if ((draft.resolutionRevision ?? 0) !== revision)
              throw new GameError(
                'The resolution changed while narration was being written. Retry narration.',
              );
            draft.narration = narration;
            draft.narrationRevision = revision;
          },
          true,
        );
      });
    await this.resolutionStage(id, turnId, 'publication', { used: 0, limit: 0 }, () =>
      this.publish(id, turnId),
    );
  }

  kick(id: string) {
    if (this.running.has(id)) return;
    const row = this.pending(id);
    if (row?.phase !== 'queued') return;
    const c = this.campaign(id);
    const snapshot = this.snapshot(id, c.owner_id);
    const internalMembers = this.members(id);
    const provider = this.providers(c.owner_id, snapshot.config);
    // Freeze before the first await: late joins and participation changes belong to the next turn.
    const claim = this.db.transaction(() => {
      const claimed = this.db
        .prepare("UPDATE turns SET phase = 'resolving' WHERE id = ? AND phase = 'queued'")
        .run(row.id);
      if (!claimed.changes) return false;
      const previous: Draft | null = row.draft ? JSON.parse(row.draft) : null;
      const executed =
        (!!previous && Object.keys(previous.receipts).length > 0) || snapshot.turn!.rolls.length > 0;
      const pipelineVersion =
        previous?.pipelineVersion ?? (provider.adjudicate && provider.narrate && !executed ? 1 : 0);
      const draft: Draft = previous ?? { members: internalMembers, scene: snapshot.scene, receipts: {} };
      if (!previous && c.factions) draft.factions = factionWorldSchema.parse(JSON.parse(c.factions));
      if (!previous?.context && !executed) draft.factionLifecycle = true;
      draft.pipelineVersion = pipelineVersion;
      if (!draft.resolution) {
        ensureLocations(
          draft.scene,
          draft.members.map((member) => member.id),
        );
      }
      draft.startingMembers ??= structuredClone(draft.members);
      draft.context ??= {
        buildId: gameplayBuildId,
        factions: draft.factions,
        config: snapshot.config,
        members:
          pipelineVersion === 1
            ? draft.members
            : draft.members.filter(
                (member) => snapshot.turn!.roster.includes(member.id) || isDowned(member.state),
              ),
        turn: this.turn({ ...row, phase: 'resolving' }),
        history: snapshot.history.slice(-12).map((turn) => ({
          summary: turn.resolution?.factualRecap ?? turn.result!.summary,
          source: turn.resolution ? 'resolution' : 'legacy-summary',
        })),
        journal: snapshot.journal,
        scene: draft.scene,
        pendingReplacements: snapshot.members
          .filter((member) => isDead(member.state) && member.replacement)
          .map((member) => ({ playerName: member.playerName, character: member.replacement!.character })),
        arrivingCharacters: (
          this.db
            .prepare("SELECT payload FROM events WHERE turn_id = ? AND kind = 'character_joined' ORDER BY id")
            .all(row.id) as { payload: string }[]
        ).map((event) => JSON.parse(event.payload)),
      };
      this.db.prepare('UPDATE turns SET draft = ? WHERE id = ?').run(json(draft), row.id);
      return true;
    })();
    if (!claim) return;
    const work = Promise.resolve().then(async () => {
      this.emit(id);
      try {
        const route: Draft = JSON.parse(this.pending(id)!.draft!);
        if (route.pipelineVersion === 1) {
          if (!provider.adjudicate || !provider.narrate)
            throw new GameError(
              'The saved turn requires a provider with separate adjudication and narration.',
            );
          await this.runResolvedTurn(id, row.id, provider);
          return;
        }
        if (
          this.db.prepare("SELECT id FROM rolls WHERE turn_id = ? AND check_key LIKE 'impact:%'").get(row.id)
        )
          throw new GameError(
            'Legacy environmental dice are preserved, but their accepted proposal was not saved. This turn needs a compatible legacy proposal before it can finish.',
          );

        const c = this.campaign(id);
        const s = this.snapshot(id, c.owner_id);
        const context: GMContext = {
          config: s.config,
          members: s.members.filter((m) => s.turn!.roster.includes(m.id) || isDowned(m.state)),
          pendingReplacements: s.members
            .filter((member) => isDead(member.state) && member.replacement)
            .map((member) => ({ playerName: member.playerName, character: member.replacement!.character })),
          arrivingCharacters: (
            this.db
              .prepare(
                "SELECT payload FROM events WHERE turn_id = ? AND kind = 'character_joined' ORDER BY id",
              )
              .all(row.id) as { payload: string }[]
          ).map((event) => JSON.parse(event.payload)),
          turn: s.turn!,
          history: s.history.slice(-12).map((t) => ({ summary: t.result!.summary })),
          journal: s.journal,
          scene: s.scene,
        };
        if (this.diceFor && s.turn!.number > 0) await this.diceFor(s.config).prepare();
        const saved: Draft | null = JSON.parse(this.pending(id)!.draft!);
        if (saved) {
          const participantIds = new Set(context.members.map((member) => member.id));
          context.members = saved.members.filter(
            (member) => participantIds.has(member.id) || isDowned(member.state),
          );
          context.scene = saved.scene;
          context.resourceUses = Object.entries(saved.receipts)
            .filter(([key]) => key.startsWith('resource:'))
            .map(([, receipt]) => receipt as ResourceReceipt);
          context.recoveryLogs = (saved.receipts.challenge as { recovery?: string[] } | undefined)?.recovery;
        }
        for (const locationId of combatLocations(context.scene)) {
          const current: Draft = JSON.parse(this.pending(id)!.draft!);
          if (combatReceipts(current)[locationId] || startedCombats(current)[locationId]) continue;
          const combatContext = this.combatContext(context, locationId);
          const inputs = current.receipts.combatInputByLocation as Record<string, CombatInput> | undefined;
          const suggested =
            inputs?.[locationId] ??
            (locationId === context.scene.location.id ? current.receipts.combatInput : undefined) ??
            (await provider.planCombat?.(combatContext));
          const plan = this.withDraft(id, row.id, (draft) => {
            const plan = normalizeCombatInput(
              this.combatContext({ ...context, scene: draft.scene, members: draft.members }, locationId),
              suggested,
            );
            draft.receipts.combatInputByLocation = { ...inputs, [locationId]: plan };
            draft.receipts.combatInput ??= plan;
            return plan;
          });
          this.combat(id, row.id, plan, locationId);
          const resolved = this.pending(id)!;
          const draft: Draft = JSON.parse(resolved.draft!);
          context.scene = draft.scene;
          context.members = draft.members;
          context.turn = this.turn(resolved);
          context.combatResult = draft.receipts.combat as CombatReceipt;
        }
        const resolvedDraft: Draft = JSON.parse(this.pending(id)!.draft!);
        context.combatResult = resolvedDraft.receipts.combat as CombatReceipt | undefined;
        if (
          context.turn.actions.some(
            (action) => action.supportAction && !fought(resolvedDraft, action.memberId),
          )
        ) {
          context.supportResults = this.resolveSupport(id, row.id);
          const resolved = this.pending(id)!;
          const draft: Draft = JSON.parse(resolved.draft!);
          context.members = draft.members;
          context.scene = draft.scene;
          context.turn = this.turn(resolved);
        }
        const refreshContext = <T>(result: T): T => {
          const resolved = this.pending(id)!;
          if (!resolved.draft) return result;
          const draft: Draft = JSON.parse(resolved.draft);
          const participantIds = new Set(context.members.map((member) => member.id));
          context.members = draft.members.filter(
            (member) => participantIds.has(member.id) || isDowned(member.state),
          );
          context.scene = draft.scene;
          context.turn = this.turn(resolved);
          return result;
        };
        const tools: GameTools = Object.assign(
          (input: Check) => refreshContext(this.roll(id, row.id, input)),
          {
            startCombat: (enemies: unknown, locationId?: string) =>
              refreshContext(this.startCombat(id, row.id, enemies, locationId)),
            combat: (input: CombatInput, locationId?: string) =>
              refreshContext(this.combat(id, row.id, input, locationId)),
            offerLoot: (input: Parameters<GameTools['offerLoot']>[0]) => this.offerLoot(id, row.id, input),
            completeChallenge: (input: { memberId: string; reason: string; bossEquivalent: boolean }) =>
              refreshContext(this.completeChallenge(id, row.id, input)),
            useResource: (input: ResourceUse) => refreshContext(this.useResource(id, row.id, input)),
            validateResolution: (outcome: Outcome) => this.validateResolution(id, row.id, outcome),
          },
        );
        if (!provider.resolve)
          throw new GameError('This legacy turn requires its compatible resolution provider.');
        const result = await provider.resolve(context, tools);
        this.commit(id, row.id, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The GM could not finish this turn.';
        this.db
          .prepare("UPDATE turns SET phase = 'failed', error = ? WHERE id = ? AND phase = 'resolving'")
          .run(message.slice(0, 2000), row.id);
      } finally {
        this.mechanicalIndex.delete(row.id);
        this.running.delete(id);
        this.emit(id);
        this.kick(id);
      }
    });
    this.running.set(id, work);
  }
  resumeQueued() {
    // Recover collecting turns saved before escaped players could keep acting.
    for (const row of this.db.prepare("SELECT * FROM turns WHERE phase = 'collecting'").all() as TurnRow[]) {
      const roster = JSON.parse(row.roster) as string[];
      const missing = this.members(row.campaign_id).filter(
        (member) =>
          member.active &&
          member.state.hp > 0 &&
          member.state.conditions.includes('Escaped') &&
          !roster.includes(member.id),
      );
      if (missing.length)
        this.db
          .prepare('UPDATE turns SET roster = ? WHERE id = ?')
          .run(json([...roster, ...missing.map((member) => member.id)]), row.id);
      this.queueIfReady(row.campaign_id);
    }
    for (const row of this.db.prepare("SELECT campaign_id FROM turns WHERE phase = 'queued'").all() as {
      campaign_id: string;
    }[])
      this.kick(row.campaign_id);
  }
  async idle() {
    while (this.running.size) await Promise.all(this.running.values());
  }
  subscribe(id: string, fn: () => void) {
    const set = this.listeners.get(id) ?? new Set();
    set.add(fn);
    this.listeners.set(id, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(id);
    };
  }
  private emit(id: string) {
    this.listeners.get(id)?.forEach((fn) => fn());
  }
  export(id: string, playerId: string) {
    this.requireHost(id, playerId);
    return {
      format: 'gather-campaign',
      version: 1,
      containsSpoilers: true,
      factions: this.campaign(id).factions ? JSON.parse(this.campaign(id).factions!) : null,
      exportedAt: new Date().toISOString(),
      config: JSON.parse(this.campaign(id).config),
      scene: this.snapshot(id, playerId).scene,
      members: this.members(id).map(({ playerId: _p, characterId: _c, ...m }) => m),
      turns: (
        this.db.prepare('SELECT * FROM turns WHERE campaign_id = ? ORDER BY number').all(id) as TurnRow[]
      ).map((t) => this.turn(t)),
      journal: this.snapshot(id, playerId).journal,
    };
  }
}
