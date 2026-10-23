import { z } from 'zod';

export const journeySchema = z
  .object({
    memberId: z.string().min(1).max(100),
    destination: z.string().trim().min(1).max(100),
    completion: z.string().trim().min(1).max(500),
    remainingStages: z.number().int().min(0).max(100),
    // These receipts are maintained by the engine, never by a model patch.
    delays: z.array(z.string().min(1).max(1500)).max(20).optional(),
    cancelled: z.boolean().optional(),
  })
  .strict();

/** Private preparation, never part of a player snapshot or public scene. */
export const gmNoteSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    locationId: z.string().min(1).max(100),
    cause: z.string().trim().min(1).max(1000),
    discoveries: z.array(z.string().trim().min(1).max(500)).min(1).max(6),
    actors: z.string().max(700),
    nextChange: z.string().max(700),
    dueTurn: z.number().int().nonnegative().nullable(),
    status: z.enum(['open', 'resolved']),
    revealed: z.array(z.number().int().min(0).max(5)).max(6).optional(),
    journey: journeySchema.optional(),
  })
  .strict();
export const gmMemorySchema = z
  .array(gmNoteSchema)
  .max(40)
  .refine(
    (notes) => new Set(notes.map((note) => note.id)).size === notes.length,
    'Private notes must have distinct IDs.',
  );
export type GMMemory = z.infer<typeof gmMemorySchema>;
export const gmNotePatchSchema = gmNoteSchema.omit({ revealed: true }).partial().required({ id: true });

/** Existing preparation is updated by ID; the model need not repeat immutable prose. */
export function prepareGMNotes(previous: GMMemory, patches: z.infer<typeof gmNotePatchSchema>[]): GMMemory {
  for (const patch of patches) {
    const saved = previous.find((note) => note.id === patch.id);
    if (
      saved?.journey &&
      ((patch.status !== undefined && patch.status !== saved.status) ||
        (patch.journey &&
          (patch.journey.remainingStages !== saved.journey.remainingStages ||
            JSON.stringify(patch.journey.delays ?? []) !== JSON.stringify(saved.journey.delays ?? []) ||
            !!patch.journey.cancelled !== !!saved.journey.cancelled)))
    )
      throw new Error(
        'Journey counters, delay receipts and completion are engine-owned; omit them from note patches.',
      );
  }
  const notes = patches.map((patch) =>
    gmNoteSchema.parse({
      ...previous.find((note) => note.id === patch.id),
      ...patch,
    }),
  );
  updateGMMemory(previous, notes);
  return gmMemorySchema.parse(notes);
}

export function updateGMMemory(previous: GMMemory, updates: GMMemory): GMMemory {
  const notes = new Map(previous.map((note) => [note.id, note]));
  for (const note of updates) {
    const saved = notes.get(note.id);
    if (saved && saved.cause !== note.cause)
      throw new Error('An established hook cause cannot be rewritten; develop its existing situation.');
    if (saved?.discoveries.some((answer, index) => note.discoveries[index] !== answer))
      throw new Error('Prepared answers cannot be rewritten; append genuinely new discoveries.');
    if (
      saved?.journey &&
      (!note.journey ||
        saved.journey.memberId !== note.journey.memberId ||
        saved.journey.destination !== note.journey.destination ||
        saved.journey.completion !== note.journey.completion)
    )
      throw new Error('Keep the accepted journey actor, destination and completion condition.');
    const revealed = [...new Set([...(saved?.revealed ?? []), ...(note.revealed ?? [])])];
    if (revealed.some((index) => index >= note.discoveries.length))
      throw new Error('Revealed answers must refer to existing prepared discoveries.');
    notes.set(note.id, { ...note, ...(revealed.length ? { revealed } : {}) });
  }
  return gmMemorySchema.parse([...notes.values()]);
}
