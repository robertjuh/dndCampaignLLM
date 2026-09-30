import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { blankTrait, slots, stats, templateCharacter, type Character, type Trait } from '../shared/schema';
import { startingStats } from '../shared/rules';
import { api } from './api';

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="field">
    <span>{label}</span>
    {children}
  </label>
);

export function CharacterEditor({
  initial,
  code,
  onSave,
  onCancel,
}: {
  initial?: Character;
  code?: string;
  onSave: (saved: Character & { id: string }) => void;
  onCancel: () => void;
}) {
  const [sheet, setSheet] = useState<Character>(initial ?? templateCharacter('', ''));
  const [concept, setConcept] = useState(initial?.concept ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [generationError, setGenerationError] = useState('');
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
  const update = <K extends keyof Character>(key: K, value: Character[K]) =>
    setSheet((s) => ({ ...s, [key]: value, ...(key === 'species' ? { role: value as string } : {}) }));
  const trait = (index: number, patch: Partial<Trait>) =>
    update(
      'traits',
      sheet.traits.map((t, i) => (i === index ? { ...t, ...patch } : t)),
    );
  let calculated = sheet.stats;
  let balanceError = '';
  try {
    calculated = startingStats(sheet);
  } catch (e) {
    balanceError = (e as Error).message;
  }

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
    setError('');
    try {
      const result = await api<Character>(
        '/api/characters/generate',
        { concept, ...(code ? { code } : {}) },
        controller.signal,
      );
      if (!controller.signal.aborted) setSheet(result);
    } catch (e) {
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
    setBusy(true);
    setError('');
    try {
      onSave(
        await api<Character & { id: string }>('/api/characters', { ...sheet, stats: calculated, concept }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-panel character-editor" onSubmit={save}>
      <div className="editor-heading">
        <h2>Your character template</h2>
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
          </div>
        )}
        <p className="muted small">
          Review and edit the result before saving. In a session, generation uses the leader's connected
          ChatGPT plan.
        </p>
      </div>
      <div className="two-columns">
        <Field label="Character name">
          <input
            required
            maxLength={60}
            value={sheet.name}
            onChange={(e) => update('name', e.target.value)}
          />
        </Field>
        <Field label="Species or form">
          <input
            required
            maxLength={80}
            value={sheet.species}
            onChange={(e) => update('species', e.target.value)}
            placeholder="Invent any species or combination"
          />
        </Field>
      </div>
      <Field label="Appearance">
        <textarea
          value={sheet.appearance}
          maxLength={1000}
          onChange={(e) => update('appearance', e.target.value)}
          rows={2}
        />
      </Field>
      <Field label="Backstory">
        <textarea
          value={sheet.background}
          maxLength={1500}
          onChange={(e) => update('background', e.target.value)}
          rows={3}
        />
      </Field>
      <div className="two-columns">
        <Field label="Motivation">
          <input
            value={sheet.motivation}
            maxLength={500}
            onChange={(e) => update('motivation', e.target.value)}
          />
        </Field>
        <Field label="Weakness">
          <input
            value={sheet.weakness}
            maxLength={500}
            onChange={(e) => update('weakness', e.target.value)}
          />
        </Field>
      </div>
      <h3>Traits & balanced stats</h3>
      <p className="muted small">
        Each stat starts at 5. Custom traits add strengths and drawbacks within a shared balance budget.
      </p>
      <div className="small-stats">
        {stats.map((s) => (
          <div key={s}>
            <span>{s}</span>
            <b>{calculated[s]}</b>
          </div>
        ))}
      </div>
      {sheet.traits.map((t, i) => (
        <section className="trait-editor" key={i}>
          <Field label={`Trait ${i + 1} name`}>
            <input
              required
              maxLength={80}
              value={t.name}
              onChange={(e) => trait(i, { name: e.target.value })}
            />
          </Field>
          <Field label="Benefit and drawback">
            <textarea
              required
              maxLength={700}
              value={t.description}
              onChange={(e) => trait(i, { description: e.target.value })}
            />
          </Field>
          <div className="stat-inputs">
            {stats.map((s) => (
              <Field key={s} label={`${s} adjustment`}>
                <input
                  type="number"
                  min={-3}
                  max={4}
                  value={t.stats[s]}
                  onChange={(e) => trait(i, { stats: { ...t.stats, [s]: Number(e.target.value) } })}
                />
              </Field>
            ))}
          </div>
          <details>
            <summary>Physical traits & equipment restrictions</summary>
            <div className="two-columns">
              <Field label="HP adjustment">
                <input
                  type="number"
                  min={-4}
                  max={4}
                  value={t.hp}
                  onChange={(e) => trait(i, { hp: Number(e.target.value) })}
                />
              </Field>
              <Field label="Defense bonus">
                <input
                  type="number"
                  min={0}
                  max={1}
                  value={t.defense}
                  onChange={(e) => trait(i, { defense: Number(e.target.value) })}
                />
              </Field>
              <Field label="Healing type">
                <select
                  value={t.healing}
                  onChange={(e) => trait(i, { healing: e.target.value as Trait['healing'] })}
                >
                  <option value="normal">Normal healing</option>
                  <option value="repair">Repair only</option>
                  <option value="necrotic">Necrotic only</option>
                </select>
              </Field>
              <Field label="HP recovered after combat">
                <input
                  type="number"
                  min={0}
                  max={1}
                  value={t.regeneration}
                  onChange={(e) => trait(i, { regeneration: Number(e.target.value) })}
                />
              </Field>
            </div>
            <div className="trait-toggles">
              {(['natural', 'heavyRestricted', 'lifesteal'] as const).map((key) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={t[key]}
                    onChange={(e) => trait(i, { [key]: e.target.checked })}
                  />
                  {
                    {
                      natural: 'd6 natural attack',
                      heavyRestricted: 'Cannot use heavy STR equipment',
                      lifesteal: 'Natural attacks heal 1 HP',
                    }[key]
                  }
                </label>
              ))}
            </div>
            <p className="small">Unusable equipment slots</p>
            <div className="trait-toggles">
              {slots.map((slot) => (
                <label key={slot}>
                  <input
                    type="checkbox"
                    checked={t.blocked.includes(slot)}
                    onChange={(e) =>
                      trait(i, {
                        blocked: e.target.checked
                          ? [...t.blocked, slot]
                          : t.blocked.filter((s) => s !== slot),
                      })
                    }
                  />
                  {slot}
                </label>
              ))}
            </div>
            <p className="small">Immunities</p>
            <div className="trait-toggles">
              {(['Bleeding', 'Burning', 'Poisoned', 'Stunned', 'Weakened'] as const).map((condition) => (
                <label key={condition}>
                  <input
                    type="checkbox"
                    checked={t.immunities.includes(condition)}
                    onChange={(e) =>
                      trait(i, {
                        immunities: e.target.checked
                          ? [...t.immunities, condition]
                          : t.immunities.filter((c) => c !== condition),
                      })
                    }
                  />
                  {condition}
                </label>
              ))}
            </div>
          </details>
          <button
            type="button"
            className="text-link"
            onClick={() =>
              update(
                'traits',
                sheet.traits.filter((_, n) => n !== i),
              )
            }
          >
            Remove trait
          </button>
        </section>
      ))}
      <button
        type="button"
        className="text-link"
        disabled={sheet.traits.length >= 3}
        onClick={() =>
          update('traits', [
            ...sheet.traits,
            { ...blankTrait(), id: `trait-${Date.now()}-${sheet.traits.length}` },
          ])
        }
      >
        + Add custom trait
      </button>
      <h3>Starting equipment choices</h3>
      <p className="muted small">
        Name three weapons for your character. Each starts at d6 damage; you choose one when joining a
        campaign.
      </p>
      {sheet.weaponOptions.map((w, i) => (
        <div className="two-columns" key={w.stat}>
          <Field label={`${w.stat} weapon name`}>
            <input
              required
              maxLength={100}
              value={w.name}
              onChange={(e) =>
                update(
                  'weaponOptions',
                  sheet.weaponOptions.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)),
                )
              }
            />
          </Field>
          <Field label={`${w.stat} weapon description`}>
            <input
              maxLength={500}
              value={w.description}
              onChange={(e) =>
                update(
                  'weaponOptions',
                  sheet.weaponOptions.map((x, n) => (n === i ? { ...x, description: e.target.value } : x)),
                )
              }
            />
          </Field>
        </div>
      ))}
      <Field label="Starting healing item name">
        <input
          required
          maxLength={100}
          value={sheet.healingItemName}
          onChange={(e) => update('healingItemName', e.target.value)}
        />
      </Field>
      {(error || balanceError) && (
        <div className="error" role="alert">
          {error || balanceError}
        </div>
      )}
      <div className="form-actions">
        <span className="muted small">
          Saved templates can be reused. Every campaign gets independent HP, equipment, and progress.
        </span>
        <button className="button" disabled={busy || !!balanceError}>
          Save character
        </button>
      </div>
    </form>
  );
}
