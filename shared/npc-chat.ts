import { z } from 'zod';
import type { CampaignConfig, NPCState, Scene } from './schema';

const conversationId = z.string().uuid();
export const chatCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), npcId: z.string().min(1).max(150) }).strict(),
  z
    .object({
      type: z.literal('message'),
      conversationId,
      messageId: z.string().regex(/^[a-f0-9-]{32,36}$/i),
      text: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z.object({ type: z.literal('accept'), conversationId, offerId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('end'), conversationId }).strict(),
]);
export const npcReply = z
  .object({
    text: z.string().trim().min(1).max(2000),
    offer: z
      .object({
        action: z.string().trim().min(1).max(800),
        cost: z.number().int().min(0).max(1000000),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ChatCommand = z.infer<typeof chatCommand>;
export type NPCReply = z.infer<typeof npcReply>;
export type ChatMessage = { id: string; role: 'speaker' | 'npc' | 'turn'; text: string };
export type NPCConversation = {
  id: string;
  memberId: string;
  npcId: string;
  npcName: string;
  locationId: string;
  messages: ChatMessage[];
  offer?: NonNullable<NPCReply['offer']> & { id: string; turnId: string };
  replying?: boolean;
};
export type NPCChatContext = {
  language: CampaignConfig['language'];
  setting: string;
  tone: string;
  speaker: string;
  npc: Pick<NPCState, 'name' | 'fact' | 'status' | 'allegiance'>;
  surroundings: { name: string; fact: string }[];
  location: Scene['location'];
  currencyName: string;
  messages: ChatMessage[];
  recentStory: string;
};
export function presentNPCs(scene: Scene) {
  return Object.values(scene.npcs ?? {}).filter(
    (npc) => npc.locationId === scene.location.id && (npc.status === 'alive' || npc.status === 'surrendered'),
  );
}
