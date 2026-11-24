import { useState, useEffect, useRef } from 'react';
import { MessageCircle } from 'lucide-react';
import { memberScene } from '../shared/locations';
import { presentNPCs, type ChatCommand } from '../shared/npc-chat';
import { incapacitatingCondition } from '../shared/rules';
import type { Snapshot } from '../shared/schema';
import { api } from './api';

export function NPCChat({ s, update }: { s: Snapshot; update: (next: Snapshot) => void }) {
  const chat = s.npcConversation;
  const [listening, setListening] = useState('');
  const [hidden, setHidden] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const me = s.members.find((member) => member.id === s.myMemberId);
  const speaker = s.members.find((member) => member.id === chat?.memberId);
  const mine = !!me && chat?.memberId === me.id;
  const open = !!chat && (mine ? hidden !== chat.id : listening === chat.id);
  const nearby =
    me?.active && me.state.hp > 0 && !incapacitatingCondition(me.state)
      ? presentNPCs(memberScene(s.scene, me.id))
      : [];
  useEffect(() => {
    setDraft('');
    setError('');
  }, [chat?.id]);
  useEffect(() => {
    if (open && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [open, chat?.messages.length]);
  async function send(command: ChatCommand) {
    setBusy(true);
    setError('');
    try {
      update(await api<Snapshot>(`/api/campaigns/${s.id}/npc-chat`, command));
      if (command.type === 'message') setDraft('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cannot reach the table.');
    } finally {
      setBusy(false);
    }
  }
  if ((!chat && !nearby.length) || (!me && !s.isHost)) return null;
  const last = chat?.messages.at(-1);
  const canSpeak = nearby.some((npc) => npc.id === chat?.npcId);
  return (
    <section className="form-panel npc-chat" aria-label="NPC conversation">
      {!chat ? (
        <div className="button-row">
          {nearby.map((npc) => (
            <button
              key={npc.id}
              className="button secondary"
              disabled={busy}
              onClick={() => send({ type: 'start', npcId: npc.id })}
            >
              <MessageCircle size={16} /> Talk to {npc.name}
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="button-row">
            <strong>
              {speaker?.character.name} is talking to {chat.npcName}
            </strong>
            <button
              className="button secondary"
              aria-expanded={open}
              onClick={() => (mine ? setHidden(open ? chat.id : '') : setListening(open ? '' : chat.id))}
            >
              {open ? 'Back to play' : mine ? 'Open conversation' : 'Listen in'}
            </button>
            {(mine || s.isHost) && (
              <button
                className="button secondary"
                onClick={() => send({ type: 'end', conversationId: chat.id })}
              >
                End conversation
              </button>
            )}
          </div>
          {open && (
            <>
              <div ref={log} className="npc-chat-log" role="log" aria-label="Conversation messages">
                {chat.messages.map((m) => (
                  <p key={m.id}>
                    <b>
                      {m.role === 'speaker'
                        ? speaker?.character.name
                        : m.role === 'npc'
                          ? chat.npcName
                          : 'Table'}
                    </b>
                    {m.text}
                  </p>
                ))}
              </div>
              {chat.replying && <small role="status">{chat.npcName} is replying…</small>}
              {mine && canSpeak && (
                <>
                  {chat.offer && (
                    <button
                      className="button"
                      disabled={
                        busy ||
                        !!s.turn?.actions.some((a) => a.memberId === me?.id) ||
                        me!.state.currency < chat.offer.cost
                      }
                      onClick={() =>
                        send({ type: 'accept', conversationId: chat.id, offerId: chat.offer!.id })
                      }
                    >
                      {chat.offer.action}
                      {chat.offer.cost > 0 && ` · ${chat.offer.cost} ${s.scene.currencyName ?? 'currency'}`}
                    </button>
                  )}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!draft.trim() || busy || chat.replying) return;
                      const messageId =
                        last?.role === 'speaker' && last.text === draft.trim()
                          ? last.id
                          : Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
                              n.toString(16).padStart(2, '0'),
                            ).join('');
                      void send({ type: 'message', conversationId: chat.id, messageId, text: draft.trim() });
                    }}
                  >
                    <label>
                      Message to {chat.npcName}
                      <input
                        maxLength={2000}
                        value={draft}
                        disabled={busy || chat.replying}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                    </label>
                    <button className="button" disabled={!draft.trim() || busy || chat.replying}>
                      Send message
                    </button>
                  </form>
                  {last?.role === 'speaker' && !chat.replying && !busy && (
                    <button
                      className="button secondary"
                      onClick={() =>
                        send({
                          type: 'message',
                          conversationId: chat.id,
                          messageId: last.id,
                          text: last.text,
                        })
                      }
                    >
                      Retry reply
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
