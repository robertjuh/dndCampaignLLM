import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { type Character } from '../shared/schema';
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
  saveUrl = '/api/characters',
  onSave,
  onCancel,
}: {
  initial?: Character;
  code?: string;
  campaignId?: string;
  saveUrl?: string;
  onSave: (saved: Character & { id: string }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [sheet, setSheet] = useState<Character | null>(initial?.name ? initial : null);
  const [concept, setConcept] = useState(initial?.concept ?? '');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [generationError, setGenerationError] = useState('');
  const [usageLimited, setUsageLimited] = useState(false);
  const [generationStarted, setGenerationStarted] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const generation = useRef<AbortController | null>(null);
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
        { concept, model, ...(code ? { code } : {}), ...(campaignId ? { campaignId } : {}) },
        controller.signal,
      );
      if (!controller.signal.aborted) setSheet({ ...result, concept, selectedEquipmentIds: [] });
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
      await onSave(await api<Character & { id: string }>(saveUrl, sheet));
    } catch (e) {
      setError((e as Error).message);
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
        <Field label="Character concept">
          <textarea
            value={concept}
            disabled={busy}
            onChange={(e) => setConcept(e.target.value)}
            maxLength={1000}
            placeholder="A chaotic warlord elf-spider who casts unpredictable spells…"
            rows={2}
          />
        </Field>
        {!code && !campaignId && <ModelSelect value={model} onChange={setModel} disabled={busy} />}
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
          Describe your concept, discover your character, and choose two starting pieces. Players use the
          host’s connected ChatGPT plan; no separate sign-in is needed.
        </p>
      </div>
      {sheet && (
        <>
          <CharacterSheet character={sheet} />
          <EquipmentChoices
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
