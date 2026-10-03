import { useCallback, useEffect, useRef, useState } from 'react';

function speechChunks(text: string) {
  const chunks: string[] = [];
  let remaining = text.trim();
  // Short utterances avoid browser limits on long passages; prefer sentence boundaries.
  while (remaining.length > 240) {
    const sentenceEnd = Math.max(
      remaining.lastIndexOf('. ', 239),
      remaining.lastIndexOf('? ', 239),
      remaining.lastIndexOf('! ', 239),
      remaining.lastIndexOf('\n', 239),
    );
    const wordEnd = remaining.lastIndexOf(' ', 240);
    const end = sentenceEnd > 0 ? sentenceEnd + 1 : wordEnd > 0 ? wordEnd : 240;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Keep playback here so a future audio service can replace browser speech without changing the turn UI.
export function useNarration(language: string, enabled: boolean) {
  const synth = typeof window.SpeechSynthesisUtterance === 'function' ? window.speechSynthesis : null;
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceId, setVoiceId] = useState('');
  const [readingTurnId, setReadingTurnId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const lang = language === 'Nederlands' ? 'nl-NL' : 'en-GB';

  const stop = useCallback(() => {
    generation.current++;
    utterance.current = null;
    synth?.cancel();
    setReadingTurnId(null);
  }, [synth]);

  useEffect(() => {
    if (!enabled || !synth) return;
    const refreshVoices = () => setVoices(synth.getVoices());
    refreshVoices();
    synth.addEventListener('voiceschanged', refreshVoices);
    return () => {
      synth.removeEventListener('voiceschanged', refreshVoices);
      stop();
    };
  }, [enabled, synth, stop]);

  function read(turnId: string, text: string) {
    if (!enabled || !synth || !text.trim()) return;
    stop();
    setError('');
    const token = generation.current;
    const available = synth.getVoices();
    const matching = available.filter((voice) => voice.lang.split('-')[0] === lang.split('-')[0]);
    const voice =
      available.find((candidate) => candidate.voiceURI === voiceId) ??
      matching.find((candidate) => candidate.lang === lang) ??
      matching.find((candidate) => candidate.default) ??
      matching[0];
    const chunks = speechChunks(text);
    let index = 0;
    setReadingTurnId(turnId);

    function fail() {
      if (generation.current !== token) return;
      stop();
      setError('Could not read this turn aloud. Try another voice or read it again.');
    }

    function speakNext() {
      if (generation.current !== token) return;
      if (index === chunks.length) {
        generation.current++;
        utterance.current = null;
        setReadingTurnId(null);
        return;
      }
      try {
        const next = new SpeechSynthesisUtterance(chunks[index++]);
        next.lang = voice?.lang ?? lang;
        if (voice) next.voice = voice;
        next.onend = speakNext;
        next.onerror = fail;
        utterance.current = next;
        synth!.speak(next);
      } catch {
        fail();
      }
    }

    try {
      synth.resume();
      speakNext();
    } catch {
      fail();
    }
  }

  return {
    supported: !!synth,
    voices: voices.map((voice) => ({
      id: voice.voiceURI,
      name: voice.name,
      language: voice.lang,
    })),
    voiceId,
    setVoiceId,
    readingTurnId,
    error,
    read,
    stop,
  };
}
