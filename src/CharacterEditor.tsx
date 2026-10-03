import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { type CampaignConfig, type Character } from '../shared/schema';
import { CharacterSheet, EquipmentChoices } from './CharacterSheet';
import { api, ApiError } from './api';
import { ModelSelect } from './ModelSelect';

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="field">
    <span>{label}</span>
    {children}
  </label>
);

export function CharacterEditor({
  initial,
  code,
  campaignId,
  campaigns = [],
  saveUrl = '/api/characters',
  onSave,
  onCancel,
}: {
  initial?: Character;
  code?: string;
  campaignId?: string;
  campaigns?: { id: string; config: CampaignConfig }[];
  saveUrl?: string;
  onSave: (saved: Character & { id: string }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [sheet, setSheet] = useState<Character | null>(initial?.name ? initial : null);
  const [name, setName] = useState(initial?.name ?? '');
  const [concept, setConcept] = useState(initial?.concept ?? '');
  const [model, setModel] = useState('');
  const [contextCampaignId, setContextCampaignId] = useState('');
  const attachedCampaignId = campaignId || contextCampaignId;
  const contextCampaign = campaigns.find((campaign) => campaign.id === attachedCampaignId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [generationError, setGenerationError] = useState('');
  const [usageLimited, setUsageLimited] = useState(false);
  const [generationStarted, setGenerationStarted] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const generation = useRef<AbortController | null>(null);
  const savedDraft = useRef<{ sheet: Character; character: Character & { id: string } } | null>(null);
  useEffect(() => () => generation.current?.abort(), []);
  useEffect(() => {
    if (generationStarted === null) return;
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - generationStarted) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [generationStarted]);
  async function generate() {
    const controller = new AbortController();
    generation.current = controller;
    const timeout = window.setTimeout(
      () => controller.abort(new DOMException('Generation timed out', 'TimeoutError')),
      125_000,
    );
    setBusy(true);
    setElapsed(0);
    setGenerationStarted(Date.now());
    setGenerationError('');
    setUsageLimited(false);
    setError('');
    try {
      const result = await api<Character>(
        '/api/characters/generate',
        {
          concept,
          ...(name.trim() ? { name: name.trim() } : {}),
          model,
          ...(code ? { code } : {}),
          ...(attachedCampaignId ? { campaignId: attachedCampaignId } : {}),
        },
        controller.signal,
      );
      if (!controller.signal.aborted)
        setSheet({ ...result, name: name.trim() || result.name, concept, selectedEquipmentIds: [] });
    } catch (e) {
      setUsageLimited(
        e instanceof ApiError && e.providerCode === 'subscription_sharing_usage_limit_exceeded',
      );
      setGenerationError(
        controller.signal.aborted
          ? controller.signal.reason?.name === 'TimeoutError'
            ? 'ChatGPT took too long to generate your character. Your draft is unchanged. Please try again.'
            : 'Generation cancelled. Your draft is unchanged.'
          : (e as Error).message,
      );
    } finally {
      window.clearTimeout(timeout);
      generation.current = null;
      setGenerationStarted(null);
      setBusy(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!sheet || sheet.selectedEquipmentIds.length !== 2) return;
    setBusy(true);
    setError('');
    try {
      const character =
        savedDraft.current?.sheet === sheet
          ? savedDraft.current.character
          : await api<Character & { id: string }>(saveUrl, sheet);
      savedDraft.current = { sheet, character };
      await onSave(character);
    } catch (e) {
      const message =
        e instanceof Error && e.message.trim()
          ? e.message
          : 'Could not save your character. Please try again.';
      setError(
        savedDraft.current?.sheet === sheet
          ? `Your character was saved, but the next step could not finish. ${message}`
          : message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-panel character-editor" onSubmit={save}>
      <div className="editor-heading">
        <h2>Create your character</h2>
        <button className="text-link" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="generate-box">
        <Field label="Character name (optional)">
          <input
            value={name}
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value);
              if (sheet && e.target.value.trim()) setSheet({ ...sheet, name: e.target.value.trim() });
            }}
            maxLength={60}
            placeholder="Leave blank for ChatGPT to choose"
          />
        </Field>
        <Field label="Character concept">
          <textarea
            value={concept}
            disabled={busy}
            onChange={(e) => setConcept(e.target.value)}
            maxLength={1000}
            placeholder="Concept/thema voor je karakter, schrijf wat je wilt en chatgpt doet de rest"
            rows={2}
          />
        </Field>
        {!code && !campaignId && (
          <>
            <Field label="Campaign context (optional)">
              <select
                value={contextCampaignId}
                onChange={(e) => setContextCampaignId(e.target.value)}
                disabled={busy}
              >
                <option value="">No campaign context</option>
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.config.name}
                  </option>
                ))}
              </select>
            </Field>
            <p className="muted small">
              {contextCampaign
                ? `${contextCampaign.config.setting} · ${contextCampaign.config.tone}.${contextCampaign.config.provider === 'practice' ? '' : ' Your character and equipment will fit this campaign’s theme.'}`
                : 'Choose an existing campaign to guide your character’s background, abilities, and equipment.'}
            </p>
          </>
        )}
        {(code || attachedCampaignId) && (
          <p className="muted small">
            {contextCampaign?.config.provider === 'practice'
              ? 'This practice campaign creates a scripted character without AI.'
              : 'Campaign context is attached. Generation uses the campaign’s selected model.'}
          </p>
        )}
        {!code && !attachedCampaignId && <ModelSelect value={model} onChange={setModel} disabled={busy} />}
        <button type="button" className="button secondary" disabled={busy} onClick={generate}>
          {generationStarted !== null
            ? 'Generating…'
            : concept.trim()
              ? 'Generate from my concept'
              : 'Surprise me with ChatGPT'}
        </button>
        {generationStarted !== null && (
          <>
            <p className="muted small" role="status">
              ChatGPT is creating your character · {elapsed}s elapsed. This can take up to two minutes.
            </p>
            <button type="button" className="text-link" onClick={() => generation.current?.abort()}>
              Cancel generation
            </button>
          </>
        )}
        {generationError && (
          <div className="error" role="alert">
            {generationError}
            {usageLimited && (
              <>
                <p>
                  <a
                    className="text-link"
                    href="https://chatgpt.com/settings/usage"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Manage ChatGPT usage
                  </a>
                </p>
                <p>
                  The host can review Gather’s app limit there before retrying. Your generated character is
                  preserved. Retry when generation is available.
                </p>
              </>
            )}
          </div>
        )}
        <p className="muted small">
          Enter a name to keep it exactly, describe your concept, and choose two starting pieces. Players use
          the host’s connected ChatGPT plan; no separate sign-in is needed.
        </p>
      </div>
      {sheet && (
        <>
          <CharacterSheet character={sheet} />
          <EquipmentChoices
            character={sheet}
            items={sheet.equipmentOptions}
            selected={sheet.selectedEquipmentIds}
            disabled={busy}
            onChange={(selectedEquipmentIds) => setSheet({ ...sheet, selectedEquipmentIds })}
          />
        </>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions">
        <span className="muted small">
          Saved templates can be reused. Every campaign gets independent HP, equipment, and progress.
        </span>
        <button className="button" disabled={busy || !sheet || sheet.selectedEquipmentIds.length !== 2}>
          Save character
        </button>
      </div>
    </form>
  );
}
