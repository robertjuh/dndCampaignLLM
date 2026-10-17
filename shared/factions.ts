import { z } from 'zod';

const text = z.string().trim().min(1).max(1500);
const id = z.string().min(1).max(100);
export const affiliationKinds = ['member', 'former-member', 'contact', 'patron', 'debtor'] as const;
export const factionSchema = z
  .object({
    id,
    name: z.string().trim().min(3).max(100),
    identity: text,
    goal: text,
    methods: text,
    resources: text,
    privateAgenda: text,
    hook: text,
    activity: text,
    activityTurn: z.number().int().nonnegative(),
    discoveredTurn: z.number().int().nonnegative().nullable(),
    knownDescription: z.string().max(6000),
  })
  .strict();
export const factionWorldSchema = z
  .object({
    version: z.literal(1),
    factions: z.array(factionSchema).min(3).max(6),
    relations: z
      .array(
        z
          .object({
            from: id,
            to: id,
            kind: z.enum(['conflict', 'overlap']),
            reason: text,
          })
          .strict(),
      )
      .min(2)
      .max(15),
  })
  .strict()
  .superRefine((world, ctx) => {
    const ids = new Set(world.factions.map((faction) => faction.id));
    for (const key of ['id', 'name', 'identity', 'goal'] as const)
      if (new Set(world.factions.map((faction) => faction[key].toLowerCase())).size !== world.factions.length)
        ctx.addIssue({ code: 'custom', message: `Factions must have distinct ${key}s.` });
    if (world.relations.some((link) => !ids.has(link.from) || !ids.has(link.to) || link.from === link.to))
      ctx.addIssue({ code: 'custom', message: 'Faction relationships require distinct existing factions.' });
    if (!['conflict', 'overlap'].every((kind) => world.relations.some((link) => link.kind === kind)))
      ctx.addIssue({ code: 'custom', message: 'Include conflict and overlapping interests.' });
    for (const faction of world.factions)
      if ((faction.discoveredTurn === null) !== !faction.knownDescription.trim())
        ctx.addIssue({ code: 'custom', message: 'Known faction facts require discovery.' });
  });
export type FactionWorld = z.infer<typeof factionWorldSchema>;
export type Faction = z.infer<typeof factionSchema>;
export type PublicFaction = Pick<Faction, 'id' | 'name' | 'knownDescription' | 'discoveredTurn'>;
export type FactionAffiliation = {
  factionId: string;
  kind: (typeof affiliationKinds)[number];
  reason: string;
};
export const factionConnectionSchema = z
  .object({
    memberId: z.string().uuid(),
    characterId: z.string().uuid(),
    factionId: id,
    kind: z.enum(affiliationKinds),
    reason: text,
    source: z.enum(['explicit', 'generated']),
    score: z.union([z.literal(-2), z.literal(0), z.literal(2)]),
    knownDescription: text,
  })
  .strict();
export type FactionConnection = z.infer<typeof factionConnectionSchema>;
export type ConnectionCandidate = { memberId: string; characterId: string; generated: boolean };
const cause = { factionId: id, eventId: z.string().min(1).max(200) };
const character = { memberId: z.string().uuid(), characterId: z.string().uuid() };
export const factionEffectSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('discover'), ...cause, knownDescription: z.string().trim().min(1).max(6000) })
    .strict(),
  z.object({ type: z.literal('activity'), ...cause, activity: text }).strict(),
  z
    .object({
      type: z.literal('reputation'),
      ...cause,
      ...character,
      amount: z.union([z.literal(-2), z.literal(-1), z.literal(1), z.literal(2)]),
      reason: text,
      awareness: text,
      achievementKey: id,
    })
    .strict(),
  z
    .object({
      type: z.literal('affiliation'),
      ...cause,
      ...character,
      kind: z.enum(affiliationKinds).nullable(),
      reason: text,
    })
    .strict(),
]);
export const factionEffectsSchema = z.array(factionEffectSchema).max(40);
export type FactionEffect = z.infer<typeof factionEffectSchema>;
export type ReputationReceipt = {
  factionId: string;
  memberId: string;
  characterId: string;
  characterName: string;
  before: number;
  after: number;
  amount: number;
  reason: string;
};
export const factionAttitude = (score = 0) => (score <= -2 ? 'Hostile' : score >= 2 ? 'Friendly' : 'Neutral');
export const clampReputation = (score: number) => Math.max(-5, Math.min(5, score));
export function publicFactions(world?: FactionWorld): PublicFaction[] {
  return (world?.factions ?? [])
    .filter((faction) => faction.discoveredTurn !== null)
    .map(({ id, name, knownDescription, discoveredTurn }) => ({
      id,
      name,
      knownDescription,
      discoveredTurn,
    }));
}
