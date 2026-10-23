import { z } from 'zod';
import { checkSchema } from './schema';
import { gmNotePatchSchema } from './gm-memory';

const ref = z.string().trim().min(1).max(100);
const prose = z.string().trim().min(1).max(500);
const lead = z
  .object({
    fact: prose,
    locationId: ref,
    source: z
      .object({ kind: z.enum(['place', 'feature', 'item', 'npc']), id: ref })
      .strict()
      .optional(),
  })
  .strict();
export const investigationSourceSchema = z
  .object({
    kind: z.enum(['place', 'feature', 'item', 'npc']),
    id: ref,
    locationId: ref,
    name: ref.optional(),
    aliases: z.array(ref).max(12).optional(),
    description: prose.optional(),
  })
  .strict();
export type InvestigationSource = z.infer<typeof investigationSourceSchema>;
export const investigationSchema = z
  .object({
    memberId: z.string().uuid(),
    source: investigationSourceSchema,
    question: prose,
    thread: ref.optional(),
    preparation: gmNotePatchSchema,
    answer: z.number().int().min(0).max(5),
    success: z.object({ text: z.string().trim().min(1).max(2000), lead }).strict(),
    failure: z.object({ fact: prose, text: z.string().trim().min(1).max(2000), lead }).strict(),
    check: checkSchema.omit({ memberId: true }).nullable(),
  })
  .strict();
export type Investigation = z.infer<typeof investigationSchema>;
export type InvestigationResult = {
  memberId: string;
  source: InvestigationSource & { name: string };
  question: string;
  thread: string;
  hookId: string;
  answer: number;
  signature: string;
  success: boolean;
  reused: boolean;
  rollId?: string;
  actionFact: string;
  finding: {
    fact: string;
    text: string;
    lead: string;
    leadLocationId: string;
    /** Version 1 text already narrates the finding and its usable lead. */
    narrativeVersion?: 1;
  };
};
