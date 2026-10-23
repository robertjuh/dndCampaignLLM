import { z } from 'zod';
import { lootSchema } from './schema';

const id = z.string().trim().min(1).max(100);
const text = z.string().trim().min(1).max(700);
export const questConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('kill'), npcId: id }).strict(),
  z
    .object({ kind: z.literal('hunt'), tag: id, locationId: id, count: z.number().int().min(1).max(100) })
    .strict(),
  z
    .object({
      kind: z.literal('deliver'),
      itemId: id.optional(),
      sourceId: id.optional(),
      quantity: z.number().int().min(1).max(100),
      preparation: z.object({ hookId: id, answer: z.number().int().min(0).max(5) }).strict().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('visit'), locationId: id }).strict(),
  z.object({ kind: z.literal('escort'), npcId: id, locationId: id }).strict(),
  z.object({ kind: z.literal('discover'), hookId: id, answer: z.number().int().min(0).max(5) }).strict(),
  z
    .object({
      kind: z.literal('state'),
      featureId: id,
      property: id,
      value: z.union([z.string().max(500), z.boolean(), z.number().finite()]),
    })
    .strict(),
]);
export const questDefinitionSchema = z
  .object({
    id,
    name: id,
    description: text,
    giverId: id,
    recipientId: id,
    objectives: z
      .array(z.object({ id, description: text, condition: questConditionSchema }).strict())
      .min(1)
      .max(8),
    reward: z
      .object({
        description: text,
        currency: z.number().int().min(0).max(10000).default(0),
        items: z.array(lootSchema).max(8).default([]),
        access: z
          .array(z.object({ from: id, to: id }).strict())
          .max(4)
          .default([]),
        faction: z
          .object({ factionId: id, reputation: z.union([z.literal(1), z.literal(2)]) })
          .strict()
          .optional(),
      })
      .strict(),
    deadlineTurn: z.number().int().positive().optional(),
    deadlineDescription: text.optional(),
  })
  .strict()
  .superRefine((quest, ctx) => {
    if (new Set(quest.objectives.map((o) => o.id)).size !== quest.objectives.length)
      ctx.addIssue({ code: 'custom', message: 'Quest objectives need distinct IDs.' });
    // The required description can be a lasting social consequence. Completing a request
    // must not require inventing money, equipment, map access or numeric reputation.
    if (quest.deadlineTurn && !quest.deadlineDescription)
      ctx.addIssue({ code: 'custom', message: 'A deadline must be explained to the players.' });
    if (quest.objectives.some(({ condition: c }) => c.kind === 'deliver' && !!c.itemId === !!c.sourceId))
      ctx.addIssue({
        code: 'custom',
        message: 'Delivery needs exactly one saved item ID or object source ID.',
      });
    if (quest.objectives.some(({ condition: c }) =>
      c.kind === 'deliver' && c.preparation && (!c.sourceId || c.quantity !== 1),
    ))
      ctx.addIssue({
        code: 'custom',
        message: 'A prepared future collectible needs one stable source ID and quantity 1.',
      });
  });
export type QuestDefinition = z.infer<typeof questDefinitionSchema>;
export const questOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('offer'), quest: questDefinitionSchema }).strict(),
  z.object({ type: z.enum(['accept', 'decline', 'abandon', 'turnIn']), questId: id }).strict(),
]);
export type QuestOperation = z.infer<typeof questOperationSchema>;
export type Quest = QuestDefinition & {
  status: 'offered' | 'active' | 'ready' | 'completed' | 'failed' | 'declined' | 'abandoned';
  offeredTurn: number;
  acceptedTurn?: number;
  completedTurn?: number;
  failureReason?: string;
  progress: Record<string, { current: number; complete: boolean; evidence: string[] }>;
  // Deaths predating acceptance never count toward a new hunt.
  priorDeaths: string[];
};

export const questStatusLabel = (status: Quest['status'], dutch = false) =>
  (dutch
    ? {
        offered: 'Aangeboden',
        active: 'Actief',
        ready: 'Klaar om in te leveren',
        completed: 'Voltooid',
        failed: 'Mislukt',
        declined: 'Afgewezen',
        abandoned: 'Opgegeven',
      }
    : {
        offered: 'Offered',
        active: 'Active',
        ready: 'Ready to turn in',
        completed: 'Completed',
        failed: 'Failed',
        declined: 'Declined',
        abandoned: 'Abandoned',
      })[status];
