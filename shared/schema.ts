import type { FactionAffiliation, PublicFaction, ReputationReceipt } from './factions';
import type { SceneFeature } from './scene-state';
import { z } from 'zod';
import type { WorldProgressionState } from './world-progression';
import { ailments } from './ailments';
import { armourPerks, perkKinds, protectiveKinds } from './equipment-perks';
import type { TurnResolution } from './turn-resolution';
import type { Quest } from './quests';

export const ailmentSchema = z.enum(ailments);

export const stats = ['STR', 'DEX', 'INT', 'CHA', 'CON', 'WIS'] as const;
export const statSchema = z.enum(stats);
export type Stat = z.infer<typeof statSchema>;
export const statArray = [5, 5, 5, 5, 5, 5];
// Accept old character exports while discarding their healing-type mechanic.
const discardHealingType = (input: unknown) => {
  if (
    input &&
    typeof input === 'object' &&
    'healing' in input &&
    typeof input.healing === 'string' &&
    ['normal', 'repair', 'necrotic'].includes(input.healing)
  ) {
    const { healing: _legacy, ...value } = input;
    return value;
  }
  return input;
};
export const abilitySchema = z.preprocess(
  (input) => {
    const value = discardHealingType(input);
    // Saved combat Assist becomes Rally; utility Assist keeps its scoped check effect.
    return value &&
      typeof value === 'object' &&
      'kind' in value &&
      'effect' in value &&
      value.kind === 'combat' &&
      value.effect === 'assist'
      ? { ...value, effect: 'rally' }
      : value;
  },
  z
    .object({
      name: z.string().min(1).max(80),
      description: z.string().min(1).max(500),
      iconId: z.string().uuid().optional(),
      kind: z.enum(['combat', 'utility']),
      effect: z.enum(['strike', 'mend', 'restoration', 'barrier', 'rally', 'assist', 'guard', 'cleanse']),
      targeting: z.enum(['single', 'multiple', 'area', 'party']).optional(),
      level: z.number().int().min(1).default(1),
      stat: statSchema.default('INT'),
      dice: z.enum(['1d4', '1d6', '1d8', '1d12', '2d4', '2d6', '2d8']).optional(),
      bonus: z.number().int().min(0).max(6).optional(),
      inflicts: ailmentSchema.nullable().optional(),
      cures: z.array(ailmentSchema).max(2).optional(),
    })
    .strict()
    .superRefine((ability, ctx) => {
      if (
        (['multiple', 'area'].includes(ability.targeting ?? '') && ability.effect !== 'strike') ||
        (ability.targeting === 'party' && !['mend', 'restoration'].includes(ability.effect))
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Multiple and area targeting require a strike; party targeting requires Mend or Restoration.',
          path: ['targeting'],
        });
      if (ability.effect === 'strike' && ability.kind !== 'combat')
        ctx.addIssue({ code: 'custom', message: 'Strikes must be combat abilities.', path: ['effect'] });
      if (ability.inflicts && (ability.kind !== 'combat' || ability.effect !== 'strike'))
        ctx.addIssue({
          code: 'custom',
          message: 'Only combat strikes inflict ailments.',
          path: ['inflicts'],
        });
      if (
        ability.cures?.length &&
        (ability.effect === 'strike' || (ability.kind === 'utility' && ability.effect === 'assist'))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Only support combat abilities and Mend or Cleanse utility abilities cure ailments.',
          path: ['cures'],
        });
      if (ability.effect === 'cleanse' && !ability.cures?.length)
        ctx.addIssue({ code: 'custom', message: 'Cleanse must cure at least one ailment.', path: ['cures'] });
      if (new Set(ability.cures).size !== (ability.cures?.length ?? 0))
        ctx.addIssue({ code: 'custom', message: 'Cures must be distinct.', path: ['cures'] });
      if (ability.dice && !['strike', 'mend', 'restoration', 'barrier'].includes(ability.effect))
        ctx.addIssue({
          code: 'custom',
          message: 'Only strike, mend, restoration and barrier abilities roll effect dice.',
          path: ['dice'],
        });
      if (
        ability.kind === 'utility' &&
        !['assist', 'mend', 'restoration', 'cleanse'].includes(ability.effect)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Utility abilities assist a relevant check, Mend, Restore, or Cleanse.',
          path: ['effect'],
        });
    }),
);
export const slots = ['left', 'right', 'body', 'head', 'boots', 'relic'] as const;
export type Slot = (typeof slots)[number];
export const itemSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    iconId: z.string().uuid().optional(),
    kind: z.enum(['weapon', 'armour', 'helmet', 'boots', 'shield', 'focus', 'consumable', 'relic', 'tool']),
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
    currencyValue: z.number().int().positive().max(10000).optional(),
    sourceId: z.string().min(1).max(200).optional(),
    attackBonus: z.number().int().min(0).max(3).default(0),
    checkBonus: z.number().int().min(0).max(3).default(0),
    attributeBonus: z
      .object({ stat: statSchema, amount: z.number().int().min(1).max(3) })
      .strict()
      .optional(),
    attributePenalty: statSchema.optional(),
    perk: z.enum(armourPerks).optional(),
    storyHook: z.string().trim().min(1).max(500).optional(),
    immunities: z.array(ailmentSchema).max(2).optional(),
    onHit: z
      .object({ ailment: ailmentSchema, chance: z.number().int().min(1).max(100) })
      .strict()
      .optional(),
    grantedAbility: abilitySchema.optional(),
    description: z.string().max(700),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.perk && (item.rarity === 'Common' || !perkKinds[item.perk].includes(item.kind)))
      ctx.addIssue({ code: 'custom', message: 'Armour perks require Uncommon or higher protective equipment.' });
    if (item.attributePenalty && (!item.attributeBonus || item.rarity !== 'Common' || !protectiveKinds.some((kind) => kind === item.kind)))
      ctx.addIssue({ code: 'custom', message: 'Only Common protective items have an attribute penalty.' });
    if (
      item.attributeBonus &&
      (!['armour', 'helmet', 'boots', 'shield'].includes(item.kind) ||
        item.attributeBonus.amount !==
          { Common: 1, Uncommon: 1, Rare: 2, Cursed: 2, Legendary: 3 }[item.rarity])
    )
      ctx.addIssue({ code: 'custom', message: 'Armour attribute bonuses must match the item rarity.' });
    if (item.currencyValue && item.kind !== 'tool')
      ctx.addIssue({ code: 'custom', message: 'Collectible currency must be a currency pouch.' });
    if (
      item.kind === 'tool' &&
      (item.scaling.length ||
        item.defense ||
        item.healing ||
        item.attackBonus ||
        item.checkBonus ||
        item.initiativePenalty ||
        stats.some((stat) => item.requirements[stat]) ||
        item.immunities?.length ||
        item.onHit ||
        item.grantedAbility)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Story tools carry a fictional purpose, not equipment powers.',
      });
    if (
      (item.immunities?.length || item.onHit || item.grantedAbility) &&
      (item.kind === 'consumable' || !['Rare', 'Legendary', 'Cursed'].includes(item.rarity))
    )
      ctx.addIssue({ code: 'custom', message: 'Equipment powers require Rare or higher equippable gear.' });
    if (item.onHit && !['weapon', 'focus'].includes(item.kind))
      ctx.addIssue({ code: 'custom', message: 'Only weapons and focuses grant on-hit ailments.' });
    if (item.onHit && item.onHit.chance !== (item.kind === 'focus' ? 100 : 25))
      ctx.addIssue({
        code: 'custom',
        message: 'Weapon ailments use a 25% hit chance; focus ailments use 100%.',
      });
    if (
      item.grantedAbility &&
      (item.rarity !== 'Legendary' ||
        item.grantedAbility.kind !==
          (['weapon', 'shield', 'focus'].includes(item.kind) ? 'combat' : 'utility'))
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Legendary weapons, shields and focuses grant combat abilities; other Legendary gear grants utility abilities.',
      });
    if (new Set(item.immunities).size !== (item.immunities?.length ?? 0))
      ctx.addIssue({ code: 'custom', message: 'Equipment immunities must be distinct.' });
  });
export type Item = z.infer<typeof itemSchema>;
export const traitSchema = z.preprocess(
  discardHealingType,
  z
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
      blocked: z.array(z.enum(slots)).max(slots.length),
      hp: z.number().int().min(-4).max(4),
      defense: z.number().int().min(0).max(1),
      immunities: z.array(ailmentSchema).max(2),
      regeneration: z.number().int().min(0).max(1),
      natural: z.boolean(),
      heavyRestricted: z.boolean(),
      lifesteal: z.boolean(),
    })
    .strict(),
);
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
export const placeholderEquipmentName =
  /\b(?:weapon|armou?r|helmet|boots?|shield|focus|relic|equipment|item|piece|wapen|harnas|helm|schild|voorwerp)\s*#?\s*\d+\s*$/i;
export const lootSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(
        (name) => !placeholderEquipmentName.test(name),
        'Use a descriptive, world-fitting item name instead of a numbered placeholder.',
      ),
    kind: z.enum(['weapon', 'armour', 'helmet', 'boots', 'shield', 'focus', 'consumable', 'relic', 'tool']),
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
    portraitId: z.string().uuid().optional(),
    portraitError: z.string().max(300).optional(),
    traits: z.array(traitSchema).max(3),
    // Five-item pools are retained only for existing saves and queued replacements.
    equipmentOptions: z
      .array(itemSchema)
      .refine(
        (items) => items.length === 5 || items.length === 7,
        'Expected seven starting equipment offers.',
      ),
    selectedEquipmentIds: z.array(z.string()).max(3).default([]),
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
export const currencyNameSchema = z.string().trim().min(1).max(80);
export const campaignSchema = z
  .object({
    ruleset: z.literal('roguelike-v1').default('roguelike-v1'),
    name: z.string().trim().min(1).max(100),
    setting: z.string().trim().min(1).max(1700),
    premise: z.string().max(2000),
    partyGoal: z.string().trim().max(1000).optional(),
    tone: z.string().max(1000),
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
export const campaignDraftSchema = campaignSchema.innerType().extend({
  name: z.string().trim().max(100),
  setting: z.string().trim().max(1700),
});
export const improvedPremiseSchema = z
  .object({
    setting: z.string().trim().min(1).max(1700),
    premise: z.string().trim().min(1).max(2000),
    tone: z.string().trim().min(1).max(1000),
    partyGoal: z.string().trim().max(1000),
    instructions: z.string().trim().min(1).max(3000),
  })
  .strict();
export type CampaignImprovement = z.infer<typeof improvedPremiseSchema>;
export const campaignImprovementRequestSchema = campaignDraftSchema.extend({
  previousDraft: improvedPremiseSchema.optional(),
});
export const startingStorySchema = z
  .object({
    memberId: z.string(),
    itemId: z.string(),
    hook: z.string().trim().min(1).max(500),
    rumour: z.string().trim().min(1).max(700),
  })
  .strict();
export type StartingStory = z.infer<typeof startingStorySchema>;
export const checkSchema = z
  .object({
    memberId: z.string().uuid(),
    stat: statSchema,
    dc: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]),
    reason: z.string().min(1).max(500),
    goal: z.object({
      intent: z.string().trim().min(1).max(300),
      success: z.string().trim().min(1).max(500),
    }).strict().nullable().optional(),
    mode: z.enum(['normal', 'advantage', 'disadvantage']),
    // Absent/null preserves legacy checks; new checks keep both sides until the engine combines them.
    circumstances: z.object({ favorable: z.boolean(), adverse: z.boolean() }).strict().nullable().optional(),
    lethal: z.boolean().default(false),
    abilityName: z.string().min(1).max(80).nullable().optional(),
    assistsMemberId: z.string().uuid().nullable().optional(),
    assistedBy: z.array(z.string().uuid()).max(10).optional(),
  })
  .strict();
export type Check = z.infer<typeof checkSchema>;
export const resourceUseSchema = z
  .object({
    memberId: z.string().uuid(),
    itemId: z.string().min(1).max(100).nullable(),
    abilityName: z.string().min(1).max(80).nullable(),
    targetId: z.string().trim().min(1).max(100).nullable(),
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
export const mapConnectionSchema = z
  .object({
    from: z.string().min(1).max(100),
    to: z.string().min(1).max(100),
    label: z.string().trim().min(1).max(200),
    blocked: z.boolean(),
    bidirectional: z.boolean(),
    transportOnly: z.boolean().optional(),
  })
  .strict();
export const worldMapSchema = z
  .object({
    nodes: z.record(
      z.object({ id: z.string().uuid(), name: z.string().min(1).max(500), visited: z.boolean() }).strict(),
    ),
    connections: z.array(mapConnectionSchema),
    positions: z.record(z.object({ x: z.number().finite(), y: z.number().finite() }).strict()).optional(),
  })
  .strict();
export type WorldMap = z.infer<typeof worldMapSchema>;
export const mapUpdatesSchema = z
  .object({
    locations: z
      .array(z.object({ ref: z.string().min(1).max(100), name: z.string().trim().min(1).max(100) }).strict())
      .max(30),
    connections: z.array(mapConnectionSchema.extend({ eventId: z.string().min(1).max(200) })).max(60),
  })
  .strict();
export const placeUpdateSchema = z
  .object({
    ref: z.string().min(1).max(100),
    location: z
      .object({
        name: z.string().min(1).max(100),
        atmosphere: z.string().min(1).max(1500),
        hazard: z.string().max(1000),
      })
      .strict(),
  })
  .strict();
export const outcomeSchema = z
  .object({
    currencyName: currencyNameSchema.optional(),
    narration: z.string().min(1).max(maxNarrationLength),
    summary: z.string().min(1).max(2000),
    choices: z.array(z.string().min(1).max(500)).max(5),
    changes: z.array(changeSchema).max(30),
    xp: z.number().int().min(0).max(40).default(0),
    currency: z.number().int().min(0).max(100).default(0),
    lethalWarning: z.string().max(1000).nullable().default(null),
    location: z
      .object({
        id: z.string().uuid().nullable().optional(),
        name: z.string().min(1).max(100),
        atmosphere: z.string().min(1).max(1500),
        hazard: z.string().max(1000),
      })
      .nullable()
      .default(null),
    memberLocations: z
      .array(
        z
          .object({
            memberId: z.string().uuid(),
            locationId: z.string().min(1).max(100),
            movementEventId: z.string().min(1).optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    placeUpdates: z.array(placeUpdateSchema).max(100).optional(),
    mapUpdates: mapUpdatesSchema.optional(),
    sceneFocus: z.string().min(1).max(100).optional(),
    separations: z
      .array(
        z
          .object({ memberIds: z.tuple([z.string().uuid(), z.string().uuid()]), eventId: z.string().min(1) })
          .strict(),
      )
      .max(100)
      .optional(),
    journal: z
      .array(
        z
          .object({
            kind: z.enum(['npc', 'location', 'quest', 'faction', 'fact']),
            name: z.string().min(1).max(100),
            detail: z.string().min(1).max(6000),
            itemId: z.string().min(1).max(200).optional(),
            itemStatus: z.string().max(500).optional(),
            npcId: z.string().max(100).optional(),
            npcStatus: z.string().max(1000).optional(),
            portraitId: z.string().uuid().optional(),
            featureId: z.string().max(100).optional(),
            featureStatus: z.string().optional(),
          })
          .strict()
          .superRefine((entry, ctx) => {
            if (entry.kind !== 'faction' && entry.detail.length > 1500)
              ctx.addIssue({
                code: 'custom',
                message: 'Non-faction journal facts are limited to 1500 characters.',
                path: ['detail'],
              });
          }),
      )
      .max(16)
      .superRefine((entries, ctx) => {
        if (entries.filter((entry) => entry.kind !== 'faction').length > 10)
          ctx.addIssue({ code: 'custom', message: 'At most ten non-faction journal entries per turn.' });
      }),
  })
  .strict();
export type Outcome = z.infer<typeof outcomeSchema>;
export type CharacterState = {
  startingRumour?: string;
  factionConnectionPreference?: 'allow' | 'unaffiliated';
  factionInitialized?: boolean;
  factionAffiliation?: FactionAffiliation | null;
  factionReputation?: Record<string, number>;
  factionAchievements?: Record<string, string[]>;
  hp: number;
  maxHp: number;
  stats: Record<Stat, number>;
  level: number;
  xp: number;
  pendingLevelUps: number;
  lastLevelUp?: string;
  currency: number;
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
  guarding?: boolean;
  abilityUses?: Record<string, number>;
  abilityGuard?: number;
  abilityAssist?: number;
  abilityBarrier?: { amount: number; sourceId: string; expiresRound?: number };
  combatCover?: { sourceId: string; evidence: string };
  combatPerks?: {
    round: number;
    openingStrikeUsed?: boolean;
    retaliation?: boolean;
    temporaryDefense?: number;
    restorativeRound?: number;
    reinforcedRound?: number;
    thornsRound?: number;
    opportunistRound?: number;
  };
};
export const enemySchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    tags: z.array(z.string().trim().min(1).max(100)).max(12).optional(),
    tier: z.enum(['minor', 'normal', 'elite', 'boss']),
    hp: z.number().int().min(1).max(300),
    defense: z.number().int().min(5).max(30),
    attack: z.number().int().min(-5).max(15),
    damage: z.string().regex(/^[1-4]d(?:4|6|8|10|12)$/),
    description: z.string().max(1000),
    tactic: z.string().max(500),
    equipmentBlueprints: z.array(lootSchema).max(5).optional(),
    onHit: ailmentSchema.nullable().default(null),
  })
  .strict();
export type Enemy = z.infer<typeof enemySchema> & {
  // Server-owned limits for freshly generated routine encounters; older profiles retain their mechanics.
  onHitChance?: number;
  maxAilmentsPerHit?: number;
  equipment?: Item[];
  maxHp: number;
  initiative: number;
  readyRound?: number;
  withdrawn?: boolean;
  stunned?: boolean;
  intent?: { targetId: string; round: number };
  opening?: { sourceId: string; beneficiaryId: string | null; expiresRound: number };
  hindered?: boolean;
  hinderedReason?: string;
  rallyOpenings?: Record<string, string>;
  position?: string;
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
export type NPCState = {
  id: string;
  name: string;
  aliases: string[];
  locationId: string | null;
  status: 'alive' | 'withdrawn' | 'surrendered' | 'dead';
  allegiance: string | null;
  factionId?: string | null;
  followingMemberId?: string | null;
  fact: string;
  conditions?: string[];
  conditionTurns?: Record<string, number>;
  treatment?: { sourceName: string; healing: number; cured: string[] };
  enemy?: Enemy;
};
export type InvestigationRecord = {
  hookId: string;
  answer: number;
  signature: string;
  success: boolean;
  question: string;
  text: string;
  narrativeVersion?: 1;
  lead: string;
  leadLocationId: string;
};
export type Scene = {
  structures?: Record<string, import('./structures').Structure>;
  currencyName?: string;
  quests?: Record<string, Quest>;
  features?: Record<string, SceneFeature>;
  npcs?: Record<string, NPCState>;
  gathering?: { id: string; memberId: string; locationId: string };
  location: {
    id?: string;
    name: string;
    atmosphere: string;
    hazard: string;
  };
  encounters: number;
  encounter: Encounter | null;
  loot: (Item & { quantity: number })[];
  lethalWarning: string | null;
  // Stable, location-qualified discovery sources prevent replenishing the same searched cache.
  searchedLoot?: Record<string, string>;
  searches?: Record<
    string,
    {
      information: string;
      rewardRolled: boolean;
      setbackRewardRolled?: boolean;
      investigation?: InvestigationRecord;
      attempts?: Record<string, { information: string; investigation: InvestigationRecord }>;
    }
  >;
  environment?: EnvironmentalState;
  encounterRisk?: { danger: 'safe' | 'dangerous'; reason: string };
  worldProgression?: WorldProgressionState;
  places?: Record<string, PlaceState>;
  memberLocations?: Record<string, string>;
  worldMap?: WorldMap;
  legacyLoot?: Scene['loot'];
};
export type PlaceState = Pick<
  Scene,
  'location' | 'encounter' | 'loot' | 'searchedLoot' | 'searches' | 'environment' | 'encounterRisk'
>;
export const environmentalActionSchema = z
  .object({
    sourceId: z.string().min(1).max(700),
    name: z.string().trim().min(1).max(100),
    evidence: z.string().trim().min(8).max(1500),
    operation: z.enum(['attack', 'reload']),
    roll: z.enum(['defense', 'check']),
    damage: z
      .string()
      .regex(/^[1-4]d(?:4|6|8|10|12)$/)
      .refine((dice) => {
        const [count, sides] = dice.split('d').map(Number);
        return count * sides <= 24;
      }, 'Environmental damage dice must total at most 24 before criticals.'),
    damageBonus: z.number().int().min(0).max(3),
    consumption: z.enum(['none', 'reload', 'once']),
    reloadSourceId: z.string().min(1).max(700).nullable(),
    reloadEvidence: z.string().trim().min(8).max(1500).nullable(),
    reloadResourceKey: z.string().max(800).optional(),
  })
  .strict();
export type EnvironmentalAction = z.infer<typeof environmentalActionSchema>;
export type EnvironmentalState = {
  sources: Record<string, { profile: EnvironmentalAction; ready: boolean }>;
  spentResources: string[];
};
export const npcReactionSchema = z
  .object({
    npcId: z.string().min(1).max(100),
    npcName: z.string().min(1).max(100),
    originLocationId: z.string().min(1).max(100),
    sourceId: z.string().min(1).max(300),
    evidence: z.string().min(10).max(1500),
    reason: z.string().min(1).max(1000),
    fact: z.string().min(1).max(1000),
    enemy: enemySchema.nullable(),
  })
  .strict();
export type NPCReaction = z.infer<typeof npcReactionSchema>;

export const combatManeuverSchema = z
  .object({
    effect: z.enum(['opening', 'hinder', 'interrupt', 'push', 'cover']),
    intent: z.string().trim().min(3).max(500),
    beneficiaryId: z.string().uuid().nullable().default(null),
    sourceId: z.string().min(1).max(200).nullable().default(null),
    evidence: z.string().trim().min(1).max(1000).nullable().default(null),
    destination: z.string().trim().min(1).max(160).nullable().default(null),
  })
  .strict();
export type CombatManeuver = z.infer<typeof combatManeuverSchema>;
export const combatRollEffectSchema = z.object({
  effect: z.enum(['advantage', 'disadvantage', 'hinder', 'ally-advantage']),
  targetId: z.string().min(1).max(100),
  beneficiaryId: z.string().uuid().optional(),
  intent: z.string().trim().min(3).max(500),
  reason: z.string().trim().min(3).max(240),
  sourceId: z.string().min(1).max(200).optional(),
  evidence: z.string().trim().min(1).max(1000).optional(),
}).strict();

export const combatSchema = z
  .object({
    voiceLines: z.array(z.object({
      actorId: z.string().min(1).max(100),
      line: z.string().trim().min(1).max(240).regex(/^[^\r\n]+$/, 'Keep a voice line on one line.'),
    }).strict()).max(110).optional(),
    npcReactions: z.array(npcReactionSchema).max(6).optional(),
    actions: z
      .array(
        z
          .object({
            memberId: z.string().uuid(),
            intent: z.enum(['action', 'orientation', 'instinct']).optional(),
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
            targetIds: z
              .array(z.string())
              .max(3)
              .refine((ids) => new Set(ids).size === ids.length, 'Targets must be distinct.')
              .optional(),
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
            maneuver: combatManeuverSchema.nullable().optional(),
            rollEffect: combatRollEffectSchema.optional(),
            cureCondition: ailmentSchema.nullable().optional(),
            weaponSlot: z.enum(['left', 'right', 'natural']).nullable().optional(),
            environment: environmentalActionSchema.nullable().optional(),
            blockedReason: z.string().trim().min(1).max(500).nullable().optional(),
          })
          .strict(),
      )
      .max(12),
    loot: lootSchema,
    enemyTargets: z.array(z.object({ enemyId: z.string(), memberId: z.string().uuid() }).strict()).max(10),
  })
  .strict();
export type CombatInput = z.infer<typeof combatSchema>;
const combatTargetIds = z.array(z.string().min(1).max(100)).max(3)
  .refine((ids) => new Set(ids).size === ids.length, 'Targets must be distinct.');
export const combatSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('attack'), targetIds: z.tuple([z.string().min(1).max(100)]) }).strict(),
  z.object({ kind: z.literal('ability'), targetIds: combatTargetIds }).strict(),
]);
export type CombatSelection = z.infer<typeof combatSelectionSchema>;
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
  npcDeal?: { conversationId: string; cost: number };
  combatSelection?: CombatSelection;
  gathering?: { id: string; locationId: string; route: string[] };
  submittedAt?: string;
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
  keptDie?: number;
  modifier: number;
  // Freeze passive check contributions with the dice; legacy rolls omit this evidence.
  equipmentBonuses?: { itemId: string; name: string; bonus: number }[];
  assistanceBonus?: number;
  total: number;
  success: boolean;
  source: string;
  critical?: 'success' | 'failure';
  label?: string;
  notation?: string;
};
export type Turn = {
  combatRules?: 2;
  id: string;
  number: number;
  phase: 'collecting' | 'queued' | 'resolving' | 'failed' | 'complete';
  roster: string[];
  actions: Action[];
  rolls: Roll[];
  result: Outcome | null;
  error: string | null;
  automaticRetry?: boolean;
  progress?: {
    stage: 'factions' | 'adjudication' | 'finalization' | 'narration' | 'review' | 'publication';
    startedAt: string;
    stageStartedAt: string;
  };
  diagnostics?: string[];
  resolution?: TurnResolution;
  characterDescriptions?: (Pick<Character, 'name' | 'role' | 'species' | 'appearance' | 'concept'> & {
    traits: Pick<Trait, 'name' | 'description'>[];
    equipment: Pick<Item, 'name' | 'kind' | 'description'>[];
  })[];
  factionChanges?: ReputationReceipt[];
  equipmentChanges?: { memberId: string; characterName: string; description: string }[];
};
export type Snapshot = {
  npcConversation?: import('./npc-chat').NPCConversation;
  combatPreviews?: { memberId: string; targetIds: string[] }[];
  factions?: PublicFaction[];
  id: string;
  config: CampaignConfig;
  status: 'lobby' | 'active' | 'archived' | 'ended';
  scene: Scene;
  paused: boolean;
  version: number;
  isHost: boolean;
  leaderName?: string;
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
      },
      {
        name: 'Keen observation',
        description: 'Examine your surroundings for useful clues.',
        kind: 'utility',
        effect: 'assist',
        level: 1,
        stat: 'INT',
      },
    ],
    selectedEquipmentIds: [],
    equipmentOptions: (['weapon', 'armour', 'boots', 'weapon', 'helmet', 'shield', 'relic'] as const).map(
      (kind, i) => ({
        id: `starter-${i}`,
        name: [
          'Short sword',
          'Chainmail',
          'Travel boots',
          'Hunting knife',
          'Iron cap',
          'Round shield',
          'Carved keepsake',
        ][i],
        kind,
        rarity: 'Common' as const,
        scaling:
          kind === 'weapon'
            ? [i === 0 ? ('STR' as const) : ('DEX' as const)]
            : kind === 'armour'
              ? ['DEX' as const]
              : kind === 'relic'
                ? ['WIS' as const]
                : [],
        requirements: { STR: 0, DEX: 0, INT: 0, CHA: 0, CON: 0, WIS: 0 },
        hands: 1 as const,
        light: kind === 'weapon' && i === 3,
        damage: kind === 'weapon' ? '1d6' : '1d4',
        defense: ['armour', 'boots', 'helmet', 'shield'].includes(kind) ? 1 : 0,
        initiativePenalty: 0,
        healing: 0,
        attackBonus: 0,
        checkBonus: kind === 'relic' ? 1 : 0,
        description: 'Reliable equipment for a new adventurer.',
      }),
    ),
    healingItemName: 'Healing consumable',
  };
}
