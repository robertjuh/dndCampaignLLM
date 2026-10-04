import { z } from 'zod';
import { ailments } from './ailments';

export const ailmentSchema = z.enum(ailments);

export const stats = ['STR', 'DEX', 'INT', 'CHA', 'CON', 'WIS'] as const;
export const statSchema = z.enum(stats);
export type Stat = z.infer<typeof statSchema>;
export const statArray = [5, 5, 5, 5, 5, 5];
export const abilitySchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    kind: z.enum(['combat', 'utility']),
    effect: z.enum(['strike', 'mend', 'assist', 'guard', 'cleanse']),
    level: z.number().int().min(1).default(1),
    stat: statSchema.default('INT'),
    healing: z.enum(['normal', 'repair', 'necrotic']).default('normal'),
    dice: z.enum(['1d4', '1d6', '1d8', '1d12', '2d4', '2d6', '2d8']).optional(),
    bonus: z.number().int().min(0).max(6).optional(),
    inflicts: ailmentSchema.nullable().optional(),
    cures: z.array(ailmentSchema).max(2).optional(),
  })
  .strict()
  .superRefine((ability, ctx) => {
    if (ability.inflicts && (ability.kind !== 'combat' || ability.effect !== 'strike'))
      ctx.addIssue({ code: 'custom', message: 'Only combat strikes inflict ailments.', path: ['inflicts'] });
    if (ability.cures?.length && (ability.kind !== 'combat' || ability.effect === 'strike'))
      ctx.addIssue({
        code: 'custom',
        message: 'Only support combat abilities cure ailments.',
        path: ['cures'],
      });
    if (ability.effect === 'cleanse' && !ability.cures?.length)
      ctx.addIssue({ code: 'custom', message: 'Cleanse must cure at least one ailment.', path: ['cures'] });
    if (new Set(ability.cures).size !== (ability.cures?.length ?? 0))
      ctx.addIssue({ code: 'custom', message: 'Cures must be distinct.', path: ['cures'] });
    if (ability.dice && !['strike', 'mend'].includes(ability.effect))
      ctx.addIssue({
        code: 'custom',
        message: 'Only strike and mend abilities roll effect dice.',
        path: ['dice'],
      });
    if (ability.kind === 'utility' && ability.effect !== 'assist')
      ctx.addIssue({
        code: 'custom',
        message: 'Out-of-combat abilities assist a relevant check.',
        path: ['effect'],
      });
  });
export const slots = ['left', 'right', 'body', 'head', 'boots'] as const;
export type Slot = (typeof slots)[number];
export const itemSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    kind: z.enum(['weapon', 'armour', 'helmet', 'boots', 'shield', 'focus', 'consumable', 'relic']),
    rarity: z.enum(['Common', 'Uncommon', 'Rare', 'Legendary', 'Cursed']),
    scaling: z.array(statSchema).max(2),
    requirements: z.object({
      STR: z.number().int().min(0).max(50),
      DEX: z.number().int().min(0).max(50),
      INT: z.number().int().min(0).max(50),
      CHA: z.number().int().min(0).max(50).default(0),
      CON: z.number().int().min(0).max(50).default(0),
      WIS: z.number().int().min(0).max(50).default(0),
    }),
    hands: z.union([z.literal(1), z.literal(2)]),
    light: z.boolean(),
    damage: z.string().regex(/^[1-4]d(?:4|6|8|10|12|20)$/),
    defense: z.number().int().min(0).max(3),
    initiativePenalty: z.number().int().min(-3).max(0),
    healing: z.number().int().min(0).max(12),
    attackBonus: z.number().int().min(0).max(3).default(0),
    checkBonus: z.number().int().min(0).max(3).default(0),
    description: z.string().max(700),
  })
  .strict();
export type Item = z.infer<typeof itemSchema>;
export const traitSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(700),
    stats: z
      .object({
        STR: z.number().int().min(-5).max(8),
        DEX: z.number().int().min(-5).max(8),
        INT: z.number().int().min(-5).max(8),
        CHA: z.number().int().min(-5).max(8).default(0),
        CON: z.number().int().min(-5).max(8).default(0),
        WIS: z.number().int().min(-5).max(8).default(0),
      })
      .strict(),
    blocked: z.array(z.enum(slots)).max(5),
    hp: z.number().int().min(-4).max(4),
    defense: z.number().int().min(0).max(1),
    immunities: z.array(ailmentSchema).max(2),
    healing: z.enum(['normal', 'repair', 'necrotic']),
    regeneration: z.number().int().min(0).max(1),
    natural: z.boolean(),
    heavyRestricted: z.boolean(),
    lifesteal: z.boolean(),
  })
  .strict();
export type Trait = z.infer<typeof traitSchema>;
export type Ability = z.infer<typeof abilitySchema>;
export const levelUpChoices = {
  'new-combat': 'Gain a new in-combat ability',
  'new-utility': 'Gain a new out-of-combat ability',
  'upgrade-combat': 'Level up a random in-combat ability',
  'upgrade-utility': 'Level up a random out-of-combat ability',
  attributes: 'Gain 2 random attribute points',
} as const;
export const levelUpChoiceSchema = z.enum([
  'new-combat',
  'new-utility',
  'upgrade-combat',
  'upgrade-utility',
  'attributes',
]);
export type LevelUpChoice = z.infer<typeof levelUpChoiceSchema>;
export const levelUpRewardSchema = z
  .object({
    ability: abilitySchema.nullable(),
    description: z.string().min(1).max(700),
  })
  .strict();
export type LevelUpReward = z.infer<typeof levelUpRewardSchema>;
export const lootSchema = z
  .object({
    name: z.string().min(1).max(100),
    kind: z.enum(['weapon', 'armour', 'helmet', 'boots', 'shield', 'focus', 'consumable', 'relic']),
    scaling: z.array(statSchema).max(2),
    hands: z.union([z.literal(1), z.literal(2)]),
    light: z.boolean(),
    description: z.string().max(500),
  })
  .strict();
export type LootBlueprint = z.infer<typeof lootSchema>;
export const characterSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    role: z.string().trim().min(1).max(80),
    species: z.string().min(1).max(80),
    appearance: z.string().max(1000).default(''),
    traits: z.array(traitSchema).max(3),
    equipmentOptions: z.array(itemSchema).length(5),
    selectedEquipmentIds: z.array(z.string()).max(2).default([]),
    healingItemName: z.string().min(1).max(100),
    concept: z.string().max(1000),
    background: z.string().max(1500),
    personality: z.string().max(500),
    motivation: z.string().max(500),
    weakness: z.string().max(500),
    stats: z
      .object({
        STR: z.number().int().min(0).max(15),
        DEX: z.number().int().min(0).max(15),
        INT: z.number().int().min(0).max(15),
        CHA: z.number().int().min(0).max(15).default(5),
        CON: z.number().int().min(0).max(15).default(5),
        WIS: z.number().int().min(0).max(15).default(5),
      })
      .strict(),
    abilities: z.array(abilitySchema),
    abilityOptions: z.array(abilitySchema).length(4).optional(),
    creationBonuses: z
      .object({
        attributes: z.array(statSchema).max(8),
        abilityPower: z.number().int().min(0).max(4),
        version: z.literal(2).optional(),
      })
      .strict()
      .optional(),
    equipment: z.array(z.string().trim().min(1).max(80)).max(4),
  })
  .strict();
export type Character = z.infer<typeof characterSchema>;
export type AbilityChoiceStats = {
  characters: number;
  offers: number;
  selections: number;
  rows: {
    kind: Ability['kind'];
    effect: Ability['effect'];
    stat: Stat;
    dice: string | null;
    bonus: number;
    offered: number;
    selected: number;
  }[];
};
export const campaignLanguageSchema = z.enum(['English', 'Nederlands']);
export const campaignSchema = z
  .object({
    ruleset: z.literal('roguelike-v1').default('roguelike-v1'),
    name: z.string().trim().min(1).max(100),
    setting: z.string().trim().min(1).max(500),
    premise: z.string().max(2500),
    tone: z.string().max(300),
    language: campaignLanguageSchema,
    instructions: z.string().max(3000),
    custom: z
      .array(z.object({ key: z.string().trim().min(1).max(60), value: z.string().max(500) }).strict())
      .max(20),
    provider: z.enum(['chatgpt', 'practice']),
    model: z.string().max(100).default(''),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (new Set(c.custom.map((x) => x.key)).size !== c.custom.length)
      ctx.addIssue({ code: 'custom', message: 'Custom field names must be unique.', path: ['custom'] });
  });
export type CampaignConfig = z.infer<typeof campaignSchema>;
export const checkSchema = z
  .object({
    memberId: z.string().uuid(),
    stat: statSchema,
    dc: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]),
    reason: z.string().min(1).max(500),
    mode: z.enum(['normal', 'advantage', 'disadvantage']),
    lethal: z.boolean().default(false),
    abilityName: z.string().min(1).max(80).nullable().optional(),
  })
  .strict();
export type Check = z.infer<typeof checkSchema>;
export const resourceUseSchema = z
  .object({
    memberId: z.string().uuid(),
    itemId: z.string().min(1).max(100).nullable(),
    abilityName: z.string().min(1).max(80).nullable(),
    targetId: z.string().uuid().nullable(),
  })
  .strict();
export type ResourceUse = z.infer<typeof resourceUseSchema>;
export const changeSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('hp'),
      memberId: z.string().uuid(),
      amount: z.number().int().min(-6).max(6),
      reason: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      type: z.literal('item'),
      memberId: z.string().uuid(),
      name: z.string().trim().min(1).max(80),
      amount: z
        .number()
        .int()
        .min(-3)
        .max(3)
        .refine((n) => n !== 0),
      reason: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      type: z.literal('condition'),
      memberId: z.string().uuid(),
      name: z.string().trim().min(1).max(80),
      remove: z.boolean(),
      reason: z.string().min(1).max(300),
    })
    .strict(),
]);
export const maxNarrationLength = 24000;
export const outcomeSchema = z
  .object({
    narration: z.string().min(1).max(maxNarrationLength),
    summary: z.string().min(1).max(2000),
    choices: z.array(z.string().min(1).max(500)).max(5),
    changes: z.array(changeSchema).max(30),
    xp: z.number().int().min(0).max(40).default(0),
    gold: z.number().int().min(0).max(100).default(0),
    lethalWarning: z.string().max(1000).nullable().default(null),
    safeRest: z.boolean().default(false),
    location: z
      .object({
        name: z.string().min(1).max(100),
        atmosphere: z.string().min(1).max(1500),
        hazard: z.string().max(1000),
      })
      .nullable()
      .default(null),
    journal: z
      .array(
        z
          .object({
            kind: z.enum(['npc', 'location', 'quest', 'faction', 'fact']),
            name: z.string().min(1).max(100),
            detail: z.string().min(1).max(1500),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type Outcome = z.infer<typeof outcomeSchema>;
export type CharacterState = {
  hp: number;
  maxHp: number;
  stats: Record<Stat, number>;
  level: number;
  xp: number;
  pendingLevelUps: number;
  lastLevelUp?: string;
  gold: number;
  inventory: (Item & { quantity: number })[];
  conditions: string[];
  conditionTurns: Record<string, number>;
  equipment: Record<Slot, Item | null>;
  starterEquipment: Item[];
  equipmentChosen: boolean;
  kills: number;
  bosses: number;
  deathReason: string | null;
  downedThisEncounter?: boolean;
  respawnReady?: boolean;
  restedEncounter: number | null;
  guarding?: boolean;
  abilityUses?: Record<string, number>;
  abilityGuard?: number;
  abilityAssist?: number;
};
export const enemySchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    tier: z.enum(['minor', 'normal', 'elite', 'boss']),
    hp: z.number().int().min(1).max(300),
    defense: z.number().int().min(5).max(30),
    attack: z.number().int().min(-5).max(15),
    damage: z.string().regex(/^[1-4]d(?:4|6|8|10|12)$/),
    description: z.string().max(1000),
    tactic: z.string().max(500),
    equipmentBlueprints: z.array(lootSchema).min(1).max(5).optional(),
    onHit: ailmentSchema.nullable().default(null),
  })
  .strict();
export type Enemy = z.infer<typeof enemySchema> & {
  equipment?: Item[];
  maxHp: number;
  initiative: number;
  withdrawn?: boolean;
  stunned?: boolean;
  conditions?: string[];
  conditionTurns?: Record<string, number>;
};
export type Encounter = {
  enemies: Enemy[];
  round: number;
  initiative: { id: string; total: number }[];
  victory: boolean;
  escaped: boolean;
};
export type Scene = {
  location: {
    name: string;
    atmosphere: string;
    hazard: string;
  };
  encounters: number;
  encounter: Encounter | null;
  loot: (Item & { quantity: number })[];
  lethalWarning: string | null;
  safeRest: boolean;
  usedRest: boolean;
};
export const combatSchema = z
  .object({
    actions: z
      .array(
        z
          .object({
            memberId: z.string().uuid(),
            main: z.enum([
              'attack',
              'defend',
              'flee',
              'creative',
              'ability',
              'move',
              'interact',
              'help-up',
              'heal',
            ]),
            reengage: z.boolean().optional(),
            abilityName: z.string().min(1).max(80).nullable().optional(),
            targetId: z.string().nullable(),
            allowRetarget: z.boolean().optional(),
            backupTargetId: z.string().nullable().optional(),
            mainItemId: z.string().nullable().default(null),
            stat: statSchema,
            description: z.string().max(500),
            minor: z.enum(['none', 'heal', 'offhand', 'equip']),
            minorItemId: z.string().nullable(),
            minorTargetId: z.string().uuid().nullable().optional(),
            minorSlot: z.enum(slots).nullable().default(null),
            dc: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]).optional(),
            effect: z.enum(['damage', 'stun', 'influence']).optional(),
            cureCondition: ailmentSchema.nullable().optional(),
            weaponSlot: z.enum(['left', 'right', 'natural']).nullable().optional(),
          })
          .strict(),
      )
      .max(12),
    loot: lootSchema,
    enemyTargets: z.array(z.object({ enemyId: z.string(), memberId: z.string().uuid() }).strict()).max(10),
  })
  .strict();
export type CombatInput = z.infer<typeof combatSchema>;
export const supportActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('help-up'), targetId: z.string().uuid() }).strict(),
  z
    .object({ type: z.literal('heal-ally'), targetId: z.string().uuid(), itemId: z.string().min(1).max(100) })
    .strict(),
]);
export type SupportAction = z.infer<typeof supportActionSchema>;
export type Member = {
  id: string;
  playerId: string;
  playerName: string;
  characterId: string;
  character: Character;
  state: CharacterState;
  active: boolean;
  replacement?: { characterId: string; character: Character } | null;
};
export type Action = {
  memberId: string;
  text: string;
  passed: boolean;
  acceptsLethalRisk?: boolean;
  abilityName?: string | null;
  supportAction?: SupportAction;
  characterName?: string;
};
export type Roll = Check & {
  id: string;
  dice: number[];
  modifier: number;
  total: number;
  success: boolean;
  source: string;
  critical?: 'success' | 'failure';
  label?: string;
  notation?: string;
};
export type Turn = {
  id: string;
  number: number;
  phase: 'collecting' | 'queued' | 'resolving' | 'failed' | 'complete';
  roster: string[];
  actions: Action[];
  rolls: Roll[];
  result: Outcome | null;
  error: string | null;
  equipmentChanges?: { memberId: string; characterName: string; description: string }[];
};
export type Snapshot = {
  id: string;
  config: CampaignConfig;
  status: 'lobby' | 'active' | 'archived' | 'ended';
  scene: Scene;
  paused: boolean;
  version: number;
  isHost: boolean;
  myMemberId: string | null;
  members: Member[];
  turn: Turn | null;
  history: Turn[];
  journal: Outcome['journal'];
  inviteCode?: string;
  displayToken?: string;
  partyOrigins?: string[];
};

export function blankTrait(name = 'Custom trait'): Trait {
  return {
    id: name,
    name,
    description: 'Describe a benefit and a drawback.',
    stats: { STR: 0, DEX: 0, INT: 0, CHA: 0, CON: 0, WIS: 0 },
    blocked: [],
    hp: 0,
    defense: 0,
    immunities: [],
    healing: 'normal',
    regeneration: 0,
    natural: false,
    heavyRestricted: false,
    lifesteal: false,
  };
}
export function templateCharacter(name = 'New character', species = 'Custom species'): Character {
  return {
    name,
    role: species,
    species,
    appearance: '',
    traits: [blankTrait('Instinct'), blankTrait('Resolve')],
    concept: '',
    background: '',
    personality: '',
    motivation: '',
    weakness: '',
    stats: { STR: 5, DEX: 5, INT: 5, CHA: 5, CON: 5, WIS: 5 },
    equipment: [],
    abilities: [
      {
        name: 'Focused strike',
        description: 'Channel your training into an attack.',
        kind: 'combat',
        effect: 'strike',
        level: 1,
        stat: 'STR',
        healing: 'normal',
      },
      {
        name: 'Keen observation',
        description: 'Examine your surroundings for useful clues.',
        kind: 'utility',
        effect: 'assist',
        level: 1,
        stat: 'INT',
        healing: 'normal',
      },
    ],
    selectedEquipmentIds: [],
    equipmentOptions: Array.from({ length: 5 }, (_, i) => ({
      id: `starter-${i}`,
      name: `Starting weapon ${i + 1}`,
      kind: 'weapon' as const,
      rarity: 'Common' as const,
      scaling: [stats[i % stats.length]],
      requirements: { STR: 0, DEX: 0, INT: 0, CHA: 0, CON: 0, WIS: 0 },
      hands: 1 as const,
      light: stats[i % stats.length] === 'DEX',
      damage: '1d6',
      defense: 0,
      initiativePenalty: 0,
      healing: 0,
      attackBonus: 0,
      checkBonus: 0,
      description: 'A simple starting weapon.',
    })),
    healingItemName: 'Healing consumable',
  };
}
