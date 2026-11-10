import { useState } from 'react';
import { Copy } from 'lucide-react';
import type { CampaignConfig, Turn } from '../shared/schema';

export function TurnImagePrompt({ config, turn }: { config: CampaignConfig; turn: Turn }) {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'manual'>('idle');
  const { name, setting, premise, tone, custom } = config;
  const json = JSON.stringify(
    {
      task: 'Create an image',
      instructions:
        'Create one cinematic illustration of this RPG scene, matching the campaign setting and tone. ' +
        'Use the supplied character descriptions as the visual references for each named character. ' +
        "Preserve each character's species, anatomy, appearance, distinctive traits, and equipped items; " +
        'do not replace non-human characters with humans or invent different equipment. ' +
        'Use the saved narration as the source of truth for the location, characters, actions, and outcomes; ' +
        'player actions are intentions and may have failed. Depict only characters present in that scene, ' +
        'in one coherent moment. Include no text, captions, or interface elements. Keep the art style simple and minimalistic, without unnecessary detail.',
      campaign: { name, setting, premise, tone, custom },
      characters: turn.characterDescriptions ?? [],
      turn: {
        number: turn.number,
        narration: turn.result?.narration ?? '',
        summary: turn.result?.summary ?? '',
        actions: turn.actions.map((action) => ({
          character: action.characterName ?? 'Unnamed character',
          text: action.text,
          passed: action.passed,
          ability: action.abilityName ?? null,
        })),
      },
    },
    null,
    2,
  );

  async function copy() {
    setCopyState('copying');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(json);
      setCopyState('copied');
    } catch {
      setCopyState('manual');
    }
  }

  return (
    <div className="turn-image-prompt">
      <button
        className="button secondary"
        disabled={copyState === 'copying' || !turn.result?.narration.trim()}
        onClick={copy}
      >
        <Copy size={16} />
        Copy image prompt
      </button>
      {copyState === 'copied' && (
        <p className="small muted" role="status">
          Image prompt copied. Paste it into ChatGPT to create an image.
        </p>
      )}
      {copyState === 'manual' && (
        <>
          <p className="small muted" role="status">
            Clipboard access is unavailable. Copy this JSON and paste it into ChatGPT to create an image.
          </p>
          <label className="field">
            <span>Image prompt JSON</span>
            <textarea readOnly value={json} rows={8} autoFocus onFocus={(event) => event.target.select()} />
          </label>
        </>
      )}
    </div>
  );
}
