import { useEffect, useState } from 'react';
import type { Turn } from '../shared/schema';

export function TurnProgress({ turn }: { turn: Turn }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const labels = {
    factions: 'Preparing the world',
    adjudication: 'Resolving actions',
    finalization: 'Saving outcomes',
    narration: 'Writing the story',
    review: 'Checking the story',
    publication: 'Finishing turn',
  };
  const elapsed = turn.progress
    ? Math.max(0, Math.floor((now - Date.parse(turn.progress.startedAt)) / 1000))
    : 0;
  return (
    <span role="status">
      {turn.progress
        ? `${labels[turn.progress.stage]} · ${elapsed}s elapsed`
        : turn.automaticRetry
          ? 'Resuming your saved turn from checkpoints…'
          : 'The game master is resolving your actions…'}
    </span>
  );
}
