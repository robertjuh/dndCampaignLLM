import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DiceSource } from './random';
import type { DB } from './db';
import { normalizeCombatInput } from './combat';
import { requestedAbility, requestedConsumable, requestsAbility } from './action-resources';
import {
  campaignSchema,
  campaignLanguageSchema,
  characterSchema,
  checkSchema,
  outcomeSchema,
  type Action,
  type CampaignConfig,
  type Character,
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
  abilityStrength,
  equipmentBonus,
  availableAbility,
  spendAbility,
  resetAbilities,
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
  damage,
  runCombat,
  randomLoot,
} from '../shared/rules';

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
export type GMContext = {
  config: CampaignConfig;
  members: Member[];
  turn: Turn;
  history: Pick<Outcome, 'summary'>[];
  journal: Outcome['journal'];
  scene: Scene;
  combatResult?: CombatReceipt;
  resourceUses?: ResourceReceipt[];
  pendingReplacements?: { playerName: string; character: Character }[];
};
export type CombatReceipt = {
  logs: string[];
  encounter: Encounter;
  characters: { id: string; name: string; state: CharacterState }[];
  loot: Scene['loot'];
};
export type ResourceReceipt = ResourceUse & {
  sourceName: string;
  restored: number;
  state: CharacterState;
  targetState: CharacterState;
};
export type GameTools = ((check: Check) => Roll) & {
  startCombat: (enemies: unknown) => unknown;
  combat: (input: CombatInput) => unknown;
  offerLoot: (input: { item: LootBlueprint; reason: string }) => unknown;
  completeChallenge: (input: { memberId: string; reason: string; bossEquivalent: boolean }) => unknown;
  useResource?: (input: ResourceUse) => ResourceReceipt;
  validateResolution?: (outcome: Outcome) => void;
};
type Draft = { members: Member[]; scene: Scene; receipts: Record<string, unknown> };
export interface GameMaster {
  resolve(context: GMContext, roll: GameTools): Promise<Outcome>;
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
        reward.ability.healing !== context.target.healing)
    )
      throw new GameError('An upgrade must preserve the ability’s effect, attribute, and healing type.');
  }
  return reward;
}
export type ProviderFactory = (ownerId: string, config: CampaignConfig) => GameMaster;
const json = JSON.stringify;
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const secretEqual = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(tokenHash(a)), Buffer.from(tokenHash(b)));
const requiresUtilityCheck = (character: Character, action: Action) =>
  !!requestedAbility(character, action, 'utility') ||
  (!action.abilityName &&
    requestsAbility(action.text) &&
    !/\b(?:or|of)\b/i.test(action.text) &&
    character.abilities.some((ability) => ability.kind === 'utility') &&
    !character.abilities.some(
      (ability) =>
        ability.kind === 'combat' && action.text.toLowerCase().includes(ability.name.toLowerCase()),
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
  saveCharacter(ownerId: string, input: unknown) {
    const sheet = normalizeCharacter(characterSchema.parse(input));
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO characters(id, owner_id, sheet) VALUES(?, ?, ?)')
      .run(id, ownerId, json(sheet));
    return { id, ...sheet };
  }
  updateCharacter(ownerId: string, id: string, input: unknown) {
    const sheet = normalizeCharacter(characterSchema.parse(input));
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
        .prepare('SELECT id, character_id FROM members WHERE campaign_id = ? AND player_id = ?')
        .get(id, playerId) as { id: string; character_id: string } | undefined;
      if (!member) throw new GameError('Join this campaign first.', 403);
      const updated = this.updateCharacter(playerId, member.character_id, input);
      const { id: _id, ...sheet } = updated;
      this.db
        .prepare('UPDATE members SET sheet = ?, state = ? WHERE id = ?')
        .run(json(sheet), json(initialState(sheet, randomUUID())), member.id);
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
        randomBytes(6).toString('hex').toUpperCase(),
        randomBytes(32).toString('base64url'),
        json(config),
        json(initialScene(config.setting)),
      );
    return this.snapshot(id, ownerId);
  }
  invite(code: string) {
    const c = this.db
      .prepare('SELECT * FROM campaigns WHERE code = ? AND status != ?')
      .get(code.toUpperCase(), 'archived') as CampaignRow | undefined;
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
      this.db.prepare('UPDATE campaigns SET version = version + 1 WHERE id = ?').run(id);
    })();
    this.emit(id);
    return this.snapshot(id, playerId);
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
    const actors: Member[] = row.draft ? JSON.parse(row.draft).members : [];
    return {
      id: row.id,
      number: row.number,
      phase: row.phase,
      roster: JSON.parse(row.roster),
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error,
      equipmentChanges: (
        this.db
          .prepare("SELECT payload FROM events WHERE turn_id = ? AND kind = 'equipment_changed' ORDER BY id")
          .all(row.id) as { payload: string }[]
      ).map((event) => JSON.parse(event.payload)),
      actions: (
        this.db.prepare('SELECT * FROM actions WHERE turn_id = ? ORDER BY rowid').all(row.id) as {
          member_id: string;
          text: string;
          passed: number;
          accepts_lethal_risk: number;
          ability_name: string | null;
        }[]
      ).map((a) => ({
        memberId: a.member_id,
        text: a.text,
        passed: !!a.passed,
        acceptsLethalRisk: !!a.accepts_lethal_risk,
        ...(a.ability_name ? { abilityName: a.ability_name } : {}),
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
    return {
      id,
      config: JSON.parse(c.config),
      scene: c.scene ? JSON.parse(c.scene) : initialScene(JSON.parse(c.config).setting),
      status: c.status,
      paused: !!c.paused,
      version: c.version,
      isHost: c.owner_id === playerId,
      myMemberId: members.find((m) => m.playerId === playerId)?.id ?? null,
      members,
      turn: pending ? this.turn(pending) : null,
      history: (
        this.db
          .prepare(
            "SELECT * FROM (SELECT * FROM turns WHERE campaign_id = ? AND phase = 'complete' ORDER BY number DESC LIMIT 30) ORDER BY number",
          )
          .all(id) as TurnRow[]
      ).map((t) => this.turn(t)),
      journal: this.db
        .prepare('SELECT kind, name, detail FROM journal WHERE campaign_id = ?')
        .all(id) as Outcome['journal'],
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
  submit(
    id: string,
    playerId: string,
    turnId: string,
    text: string,
    passed: boolean,
    acceptsLethalRisk = false,
    abilityName: string | null = null,
  ) {
    this.db.transaction(() => {
      const row = this.pending(id);
      if (!row || row.id !== turnId || row.phase !== 'collecting')
        throw new GameError('That turn is already processing. Refresh to see the current turn.', 409);
      const member = this.members(id).find((m) => m.playerId === playerId);
      if (!member || !(JSON.parse(row.roster) as string[]).includes(member.id))
        throw new GameError('You join the action from the next turn.', 403);
      if (member.state.hp <= 0) throw new GameError('This character’s run has ended.');
      if (member.state.pendingLevelUps > 0)
        throw new GameError('Choose your level-up reward before taking another action.');
      if (!member.state.equipmentChosen) throw new GameError('Choose two starting equipment pieces first.');
      if (passed && abilityName) throw new GameError('Passing cannot use an ability.');
      if (abilityName) {
        const scene: Scene = JSON.parse(this.campaign(id).scene!);
        const inCombat = scene.encounter && !scene.encounter.victory && !scene.encounter.escaped;
        availableAbility(member.character, member.state, abilityName, inCombat ? 'combat' : 'utility');
      }
      this.db
        .prepare(
          'INSERT INTO actions(turn_id, member_id, text, passed, accepts_lethal_risk, ability_name) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(turn_id, member_id) DO UPDATE SET text = excluded.text, passed = excluded.passed, accepts_lethal_risk = excluded.accepts_lethal_risk, ability_name = excluded.ability_name',
        )
        .run(turnId, member.id, passed ? '' : text, +passed, +acceptsLethalRisk, abilityName);
      this.queueIfReady(id);
    })();
    this.emit(id);
    this.kick(id);
  }
  private queueIfReady(id: string) {
    const row = this.pending(id);
    if (!row || row.phase !== 'collecting' || this.campaign(id).paused) return;
    const roster = JSON.parse(row.roster) as string[];
    const actions = this.turn(row).actions;
    if (roster.length && roster.every((memberId) => actions.some((a) => a.memberId === memberId)))
      this.db.prepare("UPDATE turns SET phase = 'queued' WHERE id = ? AND phase = 'collecting'").run(row.id);
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
    const turn = this.turn(row);
    const action = turn.actions.find((action) => action.memberId === check.memberId && !action.passed);
    if (!action || turn.number === 0 || !turn.roster.includes(check.memberId))
      throw new GameError('Only a character acting this turn can make a check.');
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
        original.lethal !== check.lethal ||
        (original.abilityName ?? null) !== (check.abilityName ?? null)
      )
        throw new GameError('A check is already locked for this character. Use its saved result.');
      return JSON.parse(prior.result);
    }
    const result = this.withDraft(id, turnId, (draft) => {
      const scene = draft.scene;
      if (scene.encounter && !scene.encounter.victory && !scene.encounter.escaped)
        throw new GameError('Use resolve_combat to adjudicate a combat round.');
      const member = draft.members.find((member) => member.id === check.memberId)!;
      if (draft.receipts[`resource:ability:${member.id}`])
        throw new GameError('This character has already spent their main action on a healing ability.');
      const requested = requestedAbility(member.character, action, 'utility', check.abilityName);
      if (check.abilityName && requested?.name !== check.abilityName)
        throw new GameError('Use a saved utility ability requested in the player’s action.');
      if (!check.abilityName && requiresUtilityCheck(member.character, action))
        throw new GameError('Resolve the requested utility ability with its saved name and stat.');
      const ability = check.abilityName
        ? availableAbility(member.character, member.state, check.abilityName, 'utility')
        : null;
      if (ability && ability.stat !== check.stat)
        throw new GameError('This ability must use its saved attribute for the relevant check.');
      const mode = ability ? (check.mode === 'disadvantage' ? 'normal' : 'advantage') : check.mode;
      const dice = Array.from({ length: mode === 'normal' ? 1 : 2 }, () => this.die(id, 20));
      if (dice.some((die) => !Number.isInteger(die) || die < 1 || die > 20))
        throw new Error('Random source returned an invalid die.');
      const selected = mode === 'disadvantage' ? Math.min(...dice) : Math.max(...dice);
      const bonus =
        modifier(member.state.stats[check.stat]) +
        equipmentBonus(member.state, check.stat, 'checkBonus') +
        (ability ? abilityStrength(ability) : 0);
      const total = selected + bonus;
      const result: Roll = {
        ...check,
        mode,
        id: randomUUID(),
        dice,
        modifier: bonus,
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
      if (check.lethal && selected === 1)
        damage(member.state, member.state.hp, `Catastrophic failure: ${check.reason}`, true);
      return result;
    });
    this.emit(id);
    return result;
  }
  private withDraft<T>(id: string, turnId: string, callback: (draft: Draft) => T): T {
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
  startCombat(id: string, turnId: string, input: unknown) {
    const enemies = enemySchema.array().min(1).max(10).parse(input);
    this.mechanicalIndex.set(turnId, 0);
    return this.withDraft(id, turnId, (draft) => {
      if (draft.receipts.startCombat) return draft.receipts.startCombat;
      const turn = this.turn(this.pending(id)!);
      if (
        turn.actions.some(
          (action) =>
            !action.passed &&
            !draft.receipts[`resource:ability:${action.memberId}`] &&
            requiresUtilityCheck(
              draft.members.find((member) => member.id === action.memberId)!.character,
              action,
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
            !draft.receipts[`resource:item:${action.memberId}`] &&
            requestedConsumable(
              draft.members.find((member) => member.id === action.memberId)!,
              action,
            ),
        )
      )
        throw new GameError('Execute requested consumables through use_resource before starting combat.');
      if (draft.scene.encounter && !draft.scene.encounter.victory && !draft.scene.encounter.escaped)
        throw new GameError('Combat is already active.');
      if (
        new Set(enemies.map((e) => e.id)).size !== enemies.length ||
        enemies.some((e) => draft.members.some((m) => m.id === e.id))
      )
        throw new GameError('Enemy IDs must be unique.');
      const roster = this.turn(this.pending(id)!).roster;
      const initiative = draft.members
        .filter((m) => roster.includes(m.id) && m.state.hp > 0)
        .map((m) => ({
          id: m.id,
          total:
            this.mechanicalDie(
              id,
              turnId,
              20,
              `${m.character.name}: initiative`,
              m.id,
              'DEX',
              modifier(m.state.stats.DEX),
            ) +
            modifier(m.state.stats.DEX) +
            Object.values(m.state.equipment)
              .filter((x, i, all) => x && all.findIndex((y) => y?.id === x.id) === i)
              .reduce((n, x) => n + (x?.initiativePenalty ?? 0), 0),
        }));
      const generated = enemies.map((e) => {
        const total = this.mechanicalDie(id, turnId, 20, `${e.name}: initiative`, e.id, 'DEX');
        initiative.push({ id: e.id, total });
        return { ...e, maxHp: e.hp, initiative: total };
      });
      draft.scene.encounter = {
        enemies: generated,
        round: 1,
        initiative: initiative.sort((a, b) => b.total - a.total),
        victory: false,
        escaped: false,
      };
      for (const member of draft.members) resetAbilities(member.character, member.state, 'combat');
      draft.scene.safeRest = false;
      draft.receipts.startCombat = structuredClone(draft.scene.encounter);
      return draft.receipts.startCombat;
    });
  }
  combat(id: string, turnId: string, input: CombatInput): CombatReceipt {
    const parsed = combatSchema.parse(input);
    this.mechanicalIndex.set(turnId, 100);
    return this.withDraft(id, turnId, (draft) => {
      if (draft.receipts.combat) return draft.receipts.combat as CombatReceipt;
      if (!draft.scene.encounter) throw new GameError('There is no active combat.');
      if (draft.receipts.startCombat)
        throw new GameError('The encounter has just begun. Let players choose their first combat actions.');
      const turn = this.turn(this.pending(id)!);
      const required = turn.actions.filter((a) => !a.passed).map((a) => a.memberId);
      if (
        parsed.actions.length !== required.length ||
        parsed.actions.some((a) => !required.includes(a.memberId))
      )
        throw new GameError(
          'Interpret exactly the submitted non-pass actions; never invent player decisions.',
        );
      for (const action of parsed.actions) {
        const submitted = turn.actions.find((submitted) => submitted.memberId === action.memberId)!;
        const member = draft.members.find((member) => member.id === action.memberId)!;
        const ability = requestedAbility(member.character, submitted, 'combat', action.abilityName);
        if (
          (action.abilityName ?? null) !== (ability?.name ?? null) ||
          (action.main === 'ability') !== !!ability
        )
          throw new GameError('Resolve exactly the combat ability selected by the player.');
      }
      const active = draft.members.filter(
        (m) => turn.roster.includes(m.id) || isDowned(m.state) || m.state.conditions.includes('Escaped'),
      );
      for (const member of active)
        if (member.state.hp > 0 && !draft.scene.encounter.initiative.some((i) => i.id === member.id)) {
          const mod = modifier(member.state.stats.DEX);
          const total =
            this.mechanicalDie(
              id,
              turnId,
              20,
              `${member.character.name}: joins initiative`,
              member.id,
              'DEX',
              mod,
            ) + mod;
          draft.scene.encounter.initiative.push({ id: member.id, total });
        }
      draft.scene.encounter.initiative.sort((a, b) => b.total - a.total);
      const logs = runCombat(active, draft.scene.encounter, parsed, (sides, label, actor, stat, bonus, dc) =>
        this.mechanicalDie(id, turnId, sides, label, actor, stat, bonus, dc),
      );
      if (draft.scene.encounter.victory) {
        const loot = randomLoot(
          randomUUID(),
          draft.scene.floor,
          (sides) => this.mechanicalDie(id, turnId, sides, 'Loot generation', 'world', 'INT'),
          parsed.loot,
        );
        offerGroundItem(draft.scene, loot);
        draft.scene.floor.encounters++;
        if (draft.scene.encounter.enemies.some((e) => e.tier === 'boss')) draft.scene.floor.cleared = true;
      }
      const receipt: CombatReceipt = {
        logs,
        encounter: structuredClone(draft.scene.encounter),
        characters: active.map((m) => ({ id: m.id, name: m.character.name, state: m.state })),
        loot: draft.scene.loot,
      };
      draft.receipts.combat = receipt;
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
      if (
        draft.receipts.startCombat ||
        draft.receipts.combat ||
        (draft.scene.encounter && !draft.scene.encounter.victory && !draft.scene.encounter.escaped)
      )
        throw new GameError('Use resolve_combat for item and ability usage during combat.');
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
      const member = draft.members.find((member) => member.id === use.memberId)!;
      const target = draft.members.find((member) => member.id === targetId);
      if (!target) throw new GameError('Choose an ally in this campaign.');
      if (member.state.hp <= 0) throw new GameError('Only a conscious character can use a resource.');
      if (isDead(target.state)) throw new GameError('A dead character cannot be healed.');
      let restored = 0;
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
        if (requestedAbility(member.character, action, 'combat', use.abilityName)?.name !== use.abilityName)
          throw new GameError('Use a saved healing ability requested in the player’s action.');
        if (turn.rolls.some((roll) => roll.memberId === member.id && !roll.notation))
          throw new GameError('This character has already spent their main action on a check.');
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
        sourceName,
        restored,
        state: structuredClone(member.state),
        targetState: structuredClone(target.state),
      };
      draft.receipts[key] = receipt;
      return receipt;
    });
  }
  offerLoot(id: string, turnId: string, input: { item: LootBlueprint; reason: string }) {
    const blueprint = lootSchema.parse(input.item);
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
      if (draft.scene.encounter && !draft.scene.encounter.victory && !draft.scene.encounter.escaped)
        throw new GameError('Combat loot is awarded by resolve_combat.');
      if (draft.receipts.combat) throw new GameError('Combat rewards have already been offered.');
      const item = randomLoot(
        randomUUID(),
        draft.scene.floor,
        (sides) => this.mechanicalDie(id, turnId, sides, 'Exploration loot rarity', 'world', 'INT'),
        blueprint,
      );
      offerGroundItem(draft.scene, item);
      draft.receipts.loot = { item, reason: input.reason };
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
      if (draft.scene.encounter && !draft.scene.encounter.victory && !draft.scene.encounter.escaped)
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
      draft.scene.floor.encounters++;
      if (input.bossEquivalent) {
        draft.scene.floor.cleared = true;
        draft.receipts.bossReward = 100;
        for (const member of draft.members)
          if (member.state.hp > 0 && turn.roster.includes(member.id)) {
            grantXp(member.character, member.state, 100);
            member.state.bosses++;
          }
      }
      draft.receipts.challenge = {
        reason: input.reason,
        floorCleared: draft.scene.floor.cleared,
        xp: input.bossEquivalent ? 100 : 0,
        members: draft.members.filter((m) => turn.roster.includes(m.id)),
      };
      return draft.receipts.challenge;
    });
  }
  private assertResolved(turn: Turn, draft: Draft, outcome: Outcome) {
    const encounter = draft.scene.encounter;
    const combatActive = encounter && !encounter.victory && !encounter.escaped;
    const describeAction = (action: Action) => {
      const member = draft.members.find((member) => member.id === action.memberId);
      const ability = member && requestedAbility(member.character, action, 'utility');
      const text = action.text.length > 100 ? `${action.text.slice(0, 100)}…` : action.text;
      return `${action.characterName ?? member?.character.name ?? action.memberId}${ability ? ` · ${ability.name} (${ability.stat})` : ''}: ${action.passed ? 'passed' : JSON.stringify(text)}`;
    };
    if (turn.number === 0 && outcome.changes.length)
      throw new GameError('The opening scene cannot change characters.');
    if (combatActive && !draft.receipts.startCombat && !draft.receipts.combat)
      throw new GameError(
        `The GM skipped combat resolution for round ${encounter.round} against ${encounter.enemies
          .filter((enemy) => enemy.hp > 0)
          .map((enemy) => enemy.name)
          .join(
            ', ',
          )}. Submitted actions: ${turn.actions.map(describeAction).join('; ')}. Retry this saved turn.`,
      );
    if ((draft.receipts.combat || combatActive) && outcome.changes.length)
      throw new GameError('Combat state comes from the rules engine; do not apply narrative changes again.');
    const budgets = new Map<string, number>();
    for (const change of outcome.changes) {
      const member = draft.members.find((member) => member.id === change.memberId);
      if (!member || !turn.roster.includes(member.id))
        throw new GameError('The GM referenced a character outside this turn.');
      if (isDead(member.state)) throw new GameError('Permadeath cannot be undone by narrative changes.');
      if (isDowned(member.state)) throw new GameError('A downed character needs healing from an ally.');
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
    }
    const unresolved = turn.actions.filter((action) => {
      if (
        action.passed ||
        draft.receipts.combat ||
        (combatActive && !draft.receipts.startCombat) ||
        draft.receipts[`resource:ability:${action.memberId}`]
      )
        return false;
      const member = draft.members.find((member) => member.id === action.memberId)!;
      const ability = requestedAbility(member.character, action, 'utility');
      return (
        requiresUtilityCheck(member.character, action) &&
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
    if (!combatActive && !draft.receipts.combat)
      for (const action of turn.actions) {
        const member = draft.members.find((member) => member.id === action.memberId)!;
        if (action.passed || member.state.hp <= 0) continue;
        const item = requestedConsumable(member, action);
        if (item && !draft.receipts[`resource:item:${member.id}`])
          throw new GameError(
            `Execute ${member.character.name}'s requested ${item.name} through use_resource.`,
          );
        const ability = requestedAbility(member.character, action, 'combat');
        if (
          ability?.effect !== 'mend' ||
          draft.receipts[`resource:ability:${member.id}`] ||
          (member.state.abilityUses?.[ability.name] ?? 0) >= 1 ||
          turn.rolls.some((roll) => roll.memberId === member.id && !!roll.abilityName)
        )
          continue;
        const target =
          draft.members.find(
            (ally) =>
              ally.id !== member.id && action.text.toLowerCase().includes(ally.character.name.toLowerCase()),
          ) ?? member;
        const healing =
          target.character.traits.find((trait) => trait.healing !== 'normal')?.healing ?? 'normal';
        if (!isDead(target.state) && target.state.hp < target.state.maxHp && healing === ability.healing)
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
      const combatActive =
        draft.scene.encounter && !draft.scene.encounter.victory && !draft.scene.encounter.escaped;
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
            state.conditions = state.conditions.filter((c) => c !== change.name);
            delete state.conditionTurns[change.name];
          } else if (
            !member.character.traits.some((t) => t.immunities.some((condition) => condition === change.name))
          ) {
            if (!state.conditions.includes(change.name)) state.conditions.push(change.name);
            state.conditionTurns[change.name] = 2;
          }
        }
      }
      for (const member of draft.members) {
        if (
          row.number > 0 &&
          !draft.receipts.combat &&
          !combatActive &&
          (JSON.parse(row.roster) as string[]).includes(member.id)
        ) {
          grantXp(member.character, member.state, draft.receipts.bossReward ? 0 : outcome.xp);
          member.state.gold += outcome.gold;
        }
      }
      // Keep the actors' identities even when a new life reuses their membership.
      const completedDraft = json(draft);
      if (outcome.nextFloor) {
        if (draft.members.some((m) => m.active && m.state.hp > 0 && m.state.pendingLevelUps > 0))
          throw new GameError('Choose all level-up rewards before changing floors.');
        if (combatActive)
          throw new GameError('The party cannot leave an active combat through a narrative update.');
        if (row.number > 0 && !draft.scene.floor.cleared)
          throw new GameError('Resolve the floor boss or equivalent challenge before changing floors.');
        const departedFloor = draft.scene.floor.number;
        draft.scene.floor = {
          number: row.number === 0 ? 1 : draft.scene.floor.number + 1,
          ...outcome.nextFloor,
          encounters: 0,
          cleared: false,
        };
        draft.scene.encounter = null;
        draft.scene.usedRest = false;
        draft.scene.safeRest = false;
        draft.scene.loot = [];
        if (row.number > 0 && draft.members.some((member) => member.state.hp > 0)) {
          for (const member of draft.members.filter((member) => isDead(member.state))) {
            // Read the latest queue at the boundary; a turn draft may predate the player's choice.
            const queued = this.db.prepare('SELECT replacement FROM members WHERE id = ?').get(member.id) as {
              replacement: string | null;
            };
            if (!queued.replacement) continue;
            const replacement = JSON.parse(queued.replacement) as NonNullable<Member['replacement']>;
            // Older completed turns may lack a draft; preserve their actor names before changing a sheet.
            this.db
              .prepare(
                "UPDATE turns SET draft = ? WHERE campaign_id = ? AND phase = 'complete' AND draft IS NULL",
              )
              .run(json({ members: this.members(id), scene: draft.scene, receipts: {} }), id);
            this.db
              .prepare('INSERT INTO events(campaign_id, turn_id, kind, payload) VALUES(?, ?, ?, ?)')
              .run(
                id,
                turnId,
                'character_replaced',
                json({ member, floor: departedFloor, replacementCharacterId: replacement.characterId }),
              );
            member.characterId = replacement.characterId;
            member.character = replacement.character;
            member.state = initialState(member.character, randomUUID());
            member.replacement = null;
            this.db.prepare('UPDATE members SET replacement = NULL WHERE id = ?').run(member.id);
            const language = (JSON.parse(this.campaign(id).config) as CampaignConfig).language;
            outcome.narration +=
              language === 'Nederlands'
                ? `\n\n${member.character.name} sluit zich op floor ${draft.scene.floor.number} aan bij de groep als nieuw personage van level 1, met een nieuwe startuitrusting.`
                : `\n\n${member.character.name} joins the party on floor ${draft.scene.floor.number} as a new level-1 character with fresh starting equipment.`;
          }
        }
        for (const member of draft.members) resetAbilities(member.character, member.state, 'utility');
      }
      if (outcome.safeRest && !combatActive) {
        draft.scene.safeRest = true;
      }
      draft.scene.lethalWarning = outcome.lethalWarning;
      for (const member of draft.members)
        this.db
          .prepare('UPDATE members SET state = ?, sheet = ?, character_id = ? WHERE id = ?')
          .run(json(member.state), json(member.character), member.characterId, member.id);
      for (const entry of outcome.journal)
        this.db
          .prepare(
            'INSERT INTO journal VALUES(?, ?, ?, ?) ON CONFLICT(campaign_id, kind, name) DO UPDATE SET detail = excluded.detail',
          )
          .run(id, entry.kind, entry.name, entry.detail);
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
      if (!ended) this.newTurn(id, row.number + 1, 'collecting');
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
      const scene: Scene = c.scene ? JSON.parse(c.scene) : initialScene(JSON.parse(c.config).setting);
      const state = member.state;
      if (action.dropItemIds?.length && !['take', 'take-equip'].includes(action.type))
        throw new GameError('Choose items to drop only when taking scene loot.');
      const inCombat = scene.encounter && !scene.encounter.victory && !scene.encounter.escaped;
      if (inCombat && ['equip', 'unequip', 'take', 'take-equip', 'drop'].includes(action.type))
        throw new GameError('Equipment can only be changed outside combat.');
      if (inCombat && ['heal', 'rest'].includes(action.type))
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
      else if (action.type === 'heal') {
        const target = action.targetId ? members.find((m) => m.id === action.targetId) : member;
        if (!target) throw new GameError('Choose an ally in this campaign.');
        if (!!action.itemId === !!action.abilityName)
          throw new GameError('Choose a healing item or a healing ability.');
        const wasDowned = isDowned(target.state);
        if (action.itemId) healWithItem(member.character, state, action.itemId, target);
        else {
          if (!row || c.status !== 'active') throw new GameError('Healing abilities require an active run.');
          const receiptKey = `healing:${randomUUID()}`;
          mendWithAbility(
            member.character,
            state,
            action.abilityName!,
            target,
            (sides, label, _actor, stat, bonus, dc) =>
              this.mechanicalDie(id, row.id, sides, label, member.id, stat, bonus, dc, receiptKey),
          );
        }
        this.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(json(target.state), target.id);
        if (wasDowned && target.active && row) {
          const roster = JSON.parse(row.roster) as string[];
          if (!roster.includes(target.id))
            this.db
              .prepare('UPDATE turns SET roster = ? WHERE id = ?')
              .run(json([...roster, target.id]), row.id);
        }
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
      } else if (action.type === 'rest') {
        if (!scene.safeRest || state.restedFloor === scene.floor.number)
          throw new GameError('A safe rest is not available.');
        state.hp = Math.min(state.maxHp, state.hp + Math.ceil(state.maxHp / 4));
        state.restedFloor = scene.floor.number;
        resetAbilities(member.character, state, 'utility');
      } else throw new GameError('Unknown character action.');
      if (row && ['equip', 'unequip', 'take', 'take-equip', 'drop'].includes(action.type)) {
        const dutch = (JSON.parse(c.config) as CampaignConfig).language === 'Nederlands';
        const destinations = {
          left: 'left hand',
          right: 'right hand',
          body: 'body',
          head: 'head',
          boots: 'feet',
        };
        const dutchDestinations = {
          left: 'linkerhand',
          right: 'rechterhand',
          body: 'lichaam',
          head: 'hoofd',
          boots: 'voeten',
        };
        const equipped = action.type === 'equip' || action.type === 'take-equip';
        let description = equipped
          ? dutch
            ? `${source!.name} uitgerust (${source!.hands === 2 ? 'beide handen' : dutchDestinations[action.slot!]}).`
            : `Equipped ${source!.name} (${source!.hands === 2 ? 'both hands' : destinations[action.slot!]}).`
          : `${({ unequip: dutch ? 'Opgeborgen' : 'Stowed', take: dutch ? 'Opgepakt' : 'Took', drop: dutch ? 'Neergelegd' : 'Dropped' } as Record<string, string>)[action.type]} ${source!.name}.`;
        const displaced = before.filter(
          (item) => !equippedItems(state).some((equipped) => equipped.id === item.id),
        );
        if (equipped && displaced.length)
          description += ` ${dutch ? 'Opgeborgen' : 'Stowed'}: ${displaced.map((item) => item.name).join(', ')}.`;
        if (dropped.length)
          description += ` ${dutch ? 'Neergelegd' : 'Dropped'}: ${dropped.map((item) => `${item!.name} ×${item!.quantity}`).join(', ')}.`;
        this.db
          .prepare('INSERT INTO events(campaign_id, turn_id, kind, payload) VALUES(?, ?, ?, ?)')
          .run(
            id,
            row.id,
            'equipment_changed',
            json({ memberId: member.id, characterName: member.character.name, description }),
          );
      }
      this.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(json(state), member.id);
      this.db
        .prepare('UPDATE campaigns SET scene = ?, version = version + 1 WHERE id = ?')
        .run(json(scene), id);
    })();
    this.emit(id);
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
        attributes: choice === 'attributes' ? [stats[this.die(id, 3) - 1], stats[this.die(id, 3) - 1]] : [],
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
  kick(id: string) {
    if (this.running.has(id)) return;
    const row = this.pending(id);
    if (row?.phase !== 'queued') return;
    // Claim synchronously before awaiting the provider; only one worker can own the turn.
    const claim = this.db
      .prepare("UPDATE turns SET phase = 'resolving' WHERE id = ? AND phase = 'queued'")
      .run(row.id);
    if (!claim.changes) return;
    const work = Promise.resolve().then(async () => {
      this.emit(id);
      try {
        const c = this.campaign(id);
        const s = this.snapshot(id, c.owner_id);
        const context: GMContext = {
          config: s.config,
          members: s.members.filter((m) => s.turn!.roster.includes(m.id) || isDowned(m.state)),
          pendingReplacements: s.members
            .filter((member) => isDead(member.state) && member.replacement)
            .map((member) => ({ playerName: member.playerName, character: member.replacement!.character })),
          turn: s.turn!,
          history: s.history.slice(-12).map((t) => ({ summary: t.result!.summary })),
          journal: s.journal,
          scene: s.scene,
        };
        const provider = this.providers(c.owner_id, s.config);
        if (this.diceFor && s.turn!.number > 0) await this.diceFor(s.config).prepare();
        const saved: Draft | null = row.draft ? JSON.parse(row.draft) : null;
        if (saved) {
          const participantIds = new Set(context.members.map((member) => member.id));
          context.members = saved.members.filter(
            (member) => participantIds.has(member.id) || isDowned(member.state),
          );
          context.scene = saved.scene;
          context.resourceUses = Object.entries(saved.receipts)
            .filter(([key]) => key.startsWith('resource:'))
            .map(([, receipt]) => receipt as ResourceReceipt);
        }
        if (
          saved?.receipts.combat ||
          (s.scene.encounter && !s.scene.encounter.victory && !s.scene.encounter.escaped)
        ) {
          let receipt = saved?.receipts.combat as CombatReceipt | undefined;
          if (!receipt) {
            let plan = saved?.receipts.combatInput as CombatInput | undefined;
            if (!plan) {
              const suggested = await provider.planCombat?.(context);
              plan = this.withDraft(id, row.id, (draft) => {
                const input = normalizeCombatInput(
                  { ...context, scene: draft.scene, members: draft.members },
                  suggested,
                );
                draft.receipts.combatInput = input;
                return input;
              });
            }
            receipt = this.combat(id, row.id, plan);
          }
          const resolved = this.pending(id)!;
          const draft: Draft = JSON.parse(resolved.draft!);
          context.combatResult = receipt;
          context.scene = draft.scene;
          context.members = draft.members.filter(
            (member) =>
              context.turn.roster.includes(member.id) ||
              isDowned(member.state) ||
              receipt.characters.some((character) => character.id === member.id),
          );
          context.turn = this.turn(resolved);
        }
        const tools: GameTools = Object.assign((input: Check) => this.roll(id, row.id, input), {
          startCombat: (enemies: unknown) => this.startCombat(id, row.id, enemies),
          combat: (input: CombatInput) => this.combat(id, row.id, input),
          offerLoot: (input: { item: LootBlueprint; reason: string }) => this.offerLoot(id, row.id, input),
          completeChallenge: (input: { memberId: string; reason: string; bossEquivalent: boolean }) =>
            this.completeChallenge(id, row.id, input),
          useResource: (input: ResourceUse) => this.useResource(id, row.id, input),
          validateResolution: (outcome: Outcome) => this.validateResolution(id, row.id, outcome),
        });
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
    }
    for (const row of this.db.prepare("SELECT campaign_id FROM turns WHERE phase = 'queued'").all() as {
      campaign_id: string;
    }[])
      this.kick(row.campaign_id);
  }
  async idle() {
    await Promise.all(this.running.values());
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
