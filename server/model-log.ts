import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type ModelTrace = {
  type: 'request' | 'response' | 'correction' | 'fallback';
  callId: string;
  timestamp: string;
  campaignId?: string;
  turnId?: string;
  stage?: string;
  turnNumber?: number;
  attempt?: number;
  request?: number;
  model?: string;
  task?: string;
  body?: unknown;
  output?: unknown;
  diagnostic?: Record<string, unknown>;
  feedback?: string;
};
export type ModelTraceSink = (event: ModelTrace) => void;

export function emitModelTrace(sink: ModelTraceSink | undefined, event: ModelTrace) {
  try {
    sink?.(event);
  } catch {
    console.warn('[ChatGPT] Could not write request diagnostics; gameplay continues.');
  }
}

/** Local files only. Headers, cookies and authorization credentials never enter this sink. */
export function createModelLog(directory: string): ModelTraceSink {
  const calls = join(directory, 'chatgpt-calls');
  const log = join(directory, 'chatgpt.jsonl');
  return (event) => {
    mkdirSync(calls, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    chmodSync(calls, 0o700);
    if (!/^[a-f0-9-]{36}$/.test(event.callId)) throw new Error('Invalid model trace ID.');
    const file = join(calls, `${event.callId}.json`);
    const { body, output, ...summary } = event;
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    if (event.type === 'request') saved.request = body;
    if (event.type === 'response') saved.response = output;
    if (event.feedback) (saved.feedback ??= []).push({ type: event.type, text: event.feedback });
    saved.metadata = { ...saved.metadata, ...summary };
    writeFileSync(file, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
    chmodSync(file, 0o600);
    if (existsSync(log) && statSync(log).size > 2_000_000) renameSync(log, `${log}.1`);
    appendFileSync(log, JSON.stringify({ ...summary, file }) + '\n', { mode: 0o600 });
    chmodSync(log, 0o600);
    console.log(
      `[ChatGPT] ${event.type} ${event.stage ?? event.task ?? 'generation'}${event.turnNumber !== undefined ? ` turn ${event.turnNumber}` : ''} #${event.request ?? 1} ${event.model ?? ''} ${event.callId}${event.diagnostic ? ` ${event.diagnostic.durationMs}ms` : ''}${event.feedback ? `: ${event.feedback.slice(0, 500)}` : ''}`,
    );
    const files = readdirSync(calls)
      .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .map((name) => ({ name, modified: statSync(join(calls, name)).mtimeMs }));
    files.sort((a, b) => b.modified - a.modified);
    for (const { name } of files.slice(200)) unlinkSync(join(calls, name));
  };
}
