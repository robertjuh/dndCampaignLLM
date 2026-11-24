import { randomUUID } from 'node:crypto';
import { memberScene } from '../shared/locations';
import { npcReply, presentNPCs, type ChatCommand, type NPCConversation } from '../shared/npc-chat';
import { incapacitatingCondition } from '../shared/rules';
import type { CampaignConfig, Member, Scene, Turn } from '../shared/schema';
import { GameError, type Game, type ProviderFactory } from './game';

export class NPCChats {
  private requests = new Map<string, AbortController>();
  constructor(
    private game: Game,
    private providers: ProviderFactory,
    private notify: (id: string) => void,
  ) {}

  private read(id: string): NPCConversation | undefined {
    const row = this.game.db.prepare('SELECT data FROM npc_conversations WHERE campaign_id = ?').get(id) as
      { data: string } | undefined;
    return row && JSON.parse(row.data);
  }
  private save(id: string, chat: NPCConversation) {
    this.game.db
      .prepare(
        'INSERT INTO npc_conversations VALUES (?, ?) ON CONFLICT(campaign_id) DO UPDATE SET data = excluded.data',
      )
      .run(id, JSON.stringify(chat));
    this.game.db.prepare('UPDATE campaigns SET version = version + 1 WHERE id = ?').run(id);
  }
  view(id: string, participant: boolean, turn: Turn | null) {
    const chat = this.read(id);
    if (!chat) return;
    if (!participant) return { ...chat, messages: [], offer: undefined };
    if (chat.offer?.turnId !== turn?.id || turn?.phase !== 'collecting') delete chat.offer;
    return { ...chat, replying: this.requests.has(chat.id) };
  }

  private context(id: string, member: Member | undefined, npcId: string) {
    const c = this.game.campaign(id);
    if (!member?.active || member.state.hp <= 0 || incapacitatingCondition(member.state))
      throw new GameError('Only a participating character can speak.', 403);
    if (c.status !== 'active' || !c.scene) throw new GameError('The scene is unavailable.', 409);
    const scene = memberScene(JSON.parse(c.scene) as Scene, member.id);
    const npc = presentNPCs(scene).find((npc) => npc.id === npcId);
    if (!npc) throw new GameError('You and this NPC must be at the same location.', 409);
    return { npc, scene, c, member };
  }
  async command(id: string, playerId: string, input: ChatCommand) {
    const member = this.game.members(id).find((m) => m.playerId === playerId);
    const chat = this.read(id);
    if (input.type === 'start') {
      const { npc, scene, member: speaker } = this.context(id, member, input.npcId);
      if (chat) throw new GameError('Another conversation is already open.', 409);
      this.save(id, {
        id: randomUUID(),
        npcId: npc.id,
        npcName: npc.name,
        memberId: speaker.id,
        locationId: scene.location.id!,
        messages: [],
      });
      this.notify(id);
      return;
    }
    if (!chat || input.conversationId !== chat.id) throw new GameError('That conversation has ended.', 409);
    if (input.type === 'end') {
      if (chat.memberId !== member?.id) this.game.requireHost(id, playerId);
      this.requests.get(chat.id)?.abort();
      this.game.db.prepare('DELETE FROM npc_conversations WHERE campaign_id = ?').run(id);
      this.game.db.prepare('UPDATE campaigns SET version = version + 1 WHERE id = ?').run(id);
      this.notify(id);
      return;
    }
    if (!member || member.id !== chat.memberId) throw new GameError('Only the speaker can reply.', 403);
    const { npc, scene, c } = this.context(id, member, chat.npcId);
    if (scene.location.id !== chat.locationId)
      throw new GameError('The conversation has moved out of reach.', 409);
    const turn = this.game.pending(id);
    if (input.type === 'accept') {
      const offer = chat.offer;
      if (!offer || offer.id !== input.offerId || turn?.phase !== 'collecting' || turn.id !== offer.turnId)
        throw new GameError('That offer has expired. Ask the NPC again.', 409);
      if (member.state.currency < offer.cost) throw new GameError('You cannot afford this offer.');
      if (this.game.turn(turn).actions.some((a) => a.memberId === member.id))
        throw new GameError('Cancel your submitted action before accepting an offer.', 409);
      const text = `${chat.npcName} — ${offer.action}${offer.cost ? ` (${offer.cost} ${scene.currencyName ?? 'currency'})` : ''}`;
      this.game.submit(
        id,
        playerId,
        turn.id,
        text,
        false,
        false,
        null,
        null,
        null,
        undefined,
        { conversationId: chat.id, cost: offer.cost },
        () => {
          delete chat.offer;
          chat.messages.push({
            id: offer.id,
            role: 'turn',
            text: `Submitted for turn ${turn.number}: ${text}`,
          });
          this.save(id, chat);
        },
      );
      return;
    }
    if (this.requests.has(chat.id)) throw new GameError('The NPC is still replying.', 409);
    const existing = chat.messages.find((m) => m.id === input.messageId);
    if (existing && (existing.text !== input.text || existing.role !== 'speaker'))
      throw new GameError('That message ID is already used.', 409);
    if (existing && chat.messages.at(-1)?.id !== existing.id) return;
    const config: CampaignConfig = JSON.parse(c.config);
    const provider = this.providers(c.owner_id, config);
    if (!provider.npcReply) throw new GameError('This GM does not support NPC conversations.', 503);
    const request = new AbortController();
    if (!existing) chat.messages.push({ id: input.messageId, role: 'speaker', text: input.text });
    delete chat.offer;
    this.save(id, chat);
    this.requests.set(chat.id, request);
    this.notify(id);
    try {
      const latest = this.game.db
        .prepare(
          "SELECT result FROM turns WHERE campaign_id = ? AND phase = 'complete' ORDER BY number DESC LIMIT 1",
        )
        .get(id) as { result: string } | undefined;
      const reply = npcReply.parse(
        await provider.npcReply(
          {
            language: config.language,
            setting: config.setting,
            tone: config.tone,
            speaker: member.character.name,
            npc: { name: npc.name, fact: npc.fact, status: npc.status, allegiance: npc.allegiance },
            surroundings: Object.values(scene.features ?? {})
              .filter((feature) => feature.locationId === scene.location.id)
              .map(({ name, fact }) => ({ name, fact })),
            location: scene.location,
            currencyName: scene.currencyName ?? 'currency',
            messages: chat.messages.slice(-40),
            recentStory: latest ? JSON.parse(latest.result).summary : '',
          },
          request.signal,
        ),
      );
      const current = this.read(id);
      if (current?.id !== chat.id) return;
      const now = this.context(
        id,
        this.game.members(id).find((m) => m.id === chat.memberId),
        npc.id,
      );
      if (now.scene.location.id !== chat.locationId || JSON.stringify(now.npc) !== JSON.stringify(npc))
        throw new GameError('The scene changed while the NPC was replying.', 409);
      current.messages.push({ id: randomUUID(), role: 'npc', text: reply.text });
      const pending = this.game.pending(id);
      if (reply.offer && pending?.phase === 'collecting' && pending.id === turn?.id)
        current.offer = { ...reply.offer, id: randomUUID(), turnId: pending.id };
      this.save(id, current);
    } finally {
      this.requests.delete(chat.id);
      this.notify(id);
    }
  }

  recordResult(id: string, turn: Turn, fact: (memberId: string) => string) {
    const chat = this.read(id);
    const action = turn.actions.find((a) => a.npcDeal && a.npcDeal.conversationId === chat?.id);
    if (!chat || !action) return;
    chat.messages.push({ id: turn.id, role: 'turn', text: fact(action.memberId) });
    this.save(id, chat);
  }
}
