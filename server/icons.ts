import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DB } from './db';
import type { Ability, CampaignConfig, Character, Scene, Outcome } from '../shared/schema';
import { findNPC, npcNameKey } from '../shared/npcs';
import { portraitSubject, type ImageSubject } from './portraits';

const kinds = new Set([
  'combat',
  'utility',
  'weapon',
  'armour',
  'helmet',
  'boots',
  'shield',
  'focus',
  'consumable',
  'relic',
  'tool',
]);
type IconRow = { id: string; subject: string; image: Buffer | null };
type IconContext = { campaign?: CampaignConfig; character?: Character };
const abilityArtProfile = 'ability-style-guide-flux2-klein-base-v14\n' + createHash('sha256')
  .update(readFileSync(new URL('../docs/ability-art-style-guide.json', import.meta.url)))
  .digest('hex') + '\n';

function campaignTheme(campaign: CampaignConfig) {
  const visual = /style|stijl|visual|art|palette|kleur|aesthetic|era|tech|magic|magie|genre/i;
  const details = [...campaign.custom].sort(
    (a, b) => Number(visual.test(b.key)) - Number(visual.test(a.key)),
  );
  return [campaign.setting, campaign.tone, ...details.map(({ key, value }) => `${key}: ${value}`)]
    .filter(Boolean)
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .join('\n')
    .slice(0, 2400);
}

function characterTheme(character: Character) {
  return [
    `Species: ${character.species}`,
    `Concept: ${(character.concept ?? '').slice(0, 500)}`,
    `Appearance: ${(character.appearance ?? '').slice(0, 700)}`,
    `Story: ${(character.background ?? '').slice(0, 900)}`,
  ]
    .filter(Boolean)
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .join('\n')
    .slice(0, 2400);
}

/** Local images are a presentation cache; they never alter game state or delay a turn. */
export class LocalIcons {
  private pending = new Map<string, Promise<Buffer>>();
  private tail: Promise<unknown> = Promise.resolve();
  private cancellation = new AbortController();
  private endpoint?: string;

  constructor(
    private db: DB,
    endpoint = process.env.GATHER_ICON_URL?.trim(),
  ) {
    if (endpoint) {
      const url = new URL(endpoint);
      if (
        url.protocol !== 'http:' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error('GATHER_ICON_URL must be an HTTP address on this computer.');
      this.endpoint = new URL('/generate', url).href;
    }
  }

  private register(subject: ImageSubject, profile: string, identity = JSON.stringify(subject)) {
    const key = createHash('sha256').update(profile + identity).digest('hex');
    this.db
      .prepare('INSERT OR IGNORE INTO generated_icons(id, key, subject) VALUES(?, ?, ?)')
      .run(randomUUID(), key, JSON.stringify(subject));
    return (this.db.prepare('SELECT id FROM generated_icons WHERE key = ?').get(key) as { id: string }).id;
  }

  attach<T>(input: T, context: IconContext = {}): T {
    if (!this.endpoint || !input || typeof input !== 'object') return input;
    if (Array.isArray(input)) {
      input.forEach((entry) => this.attach(entry, context));
      return input;
    }
    const value = input as Record<string, unknown>;
    // Carry each member's character into their equipment powers as well as their own abilities.
    if (value.config && typeof value.config === 'object' && 'setting' in value.config)
      context = { ...context, campaign: value.config as CampaignConfig };
    if (value.character && typeof value.character === 'object' && 'species' in value.character)
      context = { ...context, character: value.character as Character };
    if (typeof value.species === 'string' && Array.isArray(value.abilities)) {
      context = { ...context, character: value as Character };
      if (!value.portraitId) {
        const subject = portraitSubject(value as Character, context.campaign ? campaignTheme(context.campaign) : '');
        // Capture the first campaign style once; the same person keeps their portrait across worlds.
        value.portraitId = this.register(subject, 'character-portrait-flux2-klein-v1\n', JSON.stringify({
          name: subject.name, description: subject.description,
        }));
        delete value.portraitError;
      }
    }
    if (typeof value.id === 'string' && value.scene && Array.isArray(value.journal) && context.campaign) {
      for (const entry of value.journal as Outcome['journal']) {
        if (entry.kind !== 'npc') continue;
        const npc = findNPC(value.scene as Scene, entry.npcId ?? entry.name);
        const subject = portraitSubject({
          name: entry.name,
          appearance: entry.detail,
        }, campaignTheme(context.campaign));
        // Identity stays fixed when dialogue, location or public status changes.
        entry.portraitId = this.register(subject, 'npc-portrait-flux2-klein-v1\n',
          `${value.id}\n${npc?.id ?? npcNameKey(entry.name)}`);
      }
    }
    if (
      typeof value.name === 'string' &&
      typeof value.description === 'string' &&
      typeof value.kind === 'string' &&
      kinds.has(value.kind) &&
      (typeof value.effect === 'string' || (typeof value.id === 'string' && typeof value.rarity === 'string'))
    ) {
      const ability = value.kind === 'combat' || value.kind === 'utility';
      let theme =
        ability && context.character
          ? characterTheme(context.character)
          : context.campaign
            ? campaignTheme(context.campaign)
            : undefined;
      // Library sheets keep the campaign style captured when their equipment was generated.
      if (theme === undefined && typeof value.iconId === 'string') {
        const saved = this.db
          .prepare('SELECT subject FROM generated_icons WHERE id = ?')
          .get(value.iconId) as { subject: string } | undefined;
        if (saved) theme = (JSON.parse(saved.subject) as { theme?: string }).theme;
      }
      const details = value as Ability;
      const subject: ImageSubject = {
        name: value.name.slice(0, 100),
        kind: value.kind,
        description: value.description.slice(0, 700),
        theme: theme ?? '',
        ...(ability ? { ability: {
          effect: details.effect,
          targeting: details.targeting ?? 'single',
          inflicts: details.inflicts ?? null,
          cures: details.cures ?? [],
        } } : {}),
      };
      const profile = ability
        ? abilityArtProfile
        : 'item-planned-object-flux2-klein-base-v12\n';
      value.iconId = this.register(subject, profile);
    }
    Object.values(value).forEach((entry) => this.attach(entry, context));
    return input;
  }

  async image(id: string, kind?: 'portrait'): Promise<Buffer | undefined> {
    const row = this.db.prepare('SELECT id, subject, image FROM generated_icons WHERE id = ?').get(id) as
      IconRow | undefined;
    if (!row) return undefined;
    const subject = JSON.parse(row.subject) as ImageSubject;
    if (kind && subject.kind !== kind) return undefined;
    if (row.image) return row.image;
    if (!this.endpoint || this.cancellation.signal.aborted) return undefined;
    const existing = this.pending.get(id);
    if (existing) return existing;
    // ponytail: one local GPU; increase concurrency only if a future service has multiple GPUs.
    const task = this.tail
      .then(async () => {
        const signal = AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(900_000)]);
        signal.throwIfAborted();
        const response = await fetch(this.endpoint!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Gather-Icons': '1' },
          body: JSON.stringify({
            ...subject,
            seed: parseInt(createHash('sha256').update(row.subject).digest('hex').slice(0, 8), 16),
          }),
          signal,
          redirect: 'error',
        });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png'))
          throw new Error('Local icon generation is unavailable.');
        const bytes = Buffer.from(await response.arrayBuffer());
        const size = subject.kind === 'portrait' ? 512 : 128;
        if (
          bytes.length > (subject.kind === 'portrait' ? 1_000_000 : 100_000) ||
          bytes.length < 24 ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          bytes.readUInt32BE(16) !== size ||
          bytes.readUInt32BE(20) !== size
        )
          throw new Error('The local service returned an invalid icon.');
        signal.throwIfAborted();
        this.db.prepare('UPDATE generated_icons SET image = ? WHERE id = ?').run(bytes, id);
        return bytes;
      })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    this.tail = task.catch(() => {});
    return task;
  }

  async close() {
    this.cancellation.abort();
    await this.tail;
  }
}
