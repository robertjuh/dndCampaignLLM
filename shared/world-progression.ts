import { z } from 'zod';

export const worldProgressEvidenceSchema = z
  .object({
    locationId: z.string().min(1).max(100),
    eventId: z.string().min(1).max(200),
    kind: z.enum(['discovery', 'npc', 'threat', 'resolution']),
    thread: z.string().min(1).max(300),
    journal: z
      .object({
        kind: z.enum(['npc', 'location', 'quest', 'faction', 'fact']),
        name: z.string().min(1).max(100),
      })
      .strict(),
  })
  .strict();
export type WorldProgressEvidence = z.infer<typeof worldProgressEvidenceSchema>;

export const worldProgressionStateSchema = z
  .object({
    version: z.literal(1),
    places: z.record(
      z
        .object({
          stalledTurns: z.number().int().nonnegative(),
          lastTurnId: z.string().min(1).optional(),
          recentFacts: z.array(z.string().max(6000)).max(24),
        })
        .strict(),
    ),
    threads: z.record(z.object({
      stalledTurns: z.number().int().nonnegative(),
      lastTurnId: z.string().min(1),
      recentFacts: z.array(z.string().max(6000)).max(24),
    }).strict()).optional(),
  })
  .strict();
export type WorldProgressionState = z.infer<typeof worldProgressionStateSchema>;
