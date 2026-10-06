import React, { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  Compass,
  Copy,
  Dices,
  Download,
  Feather,
  Heart,
  LoaderCircle,
  Monitor,
  Moon,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Send,
  Settings2,
  Shield,
  Sparkles,
  Square,
  Swords,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import {
  stats,
  slots,
  templateCharacter,
  type CampaignConfig,
  type Character,
  type AbilityChoiceStats,
  type Item,
  type Member,
  type Action,
  type Roll,
  type Turn,
  type Snapshot,
  type CharacterState,
  levelUpChoices,
  type LevelUpChoice,
} from '../shared/schema';
import {
  modifier,
  defense,
  capacity,
  occupiedSlots,
  isDowned,
  isDead,
  isInCombat,
  canInteract,
} from '../shared/rules';
import { ailments, conditionDescription, conditionDuration } from '../shared/ailments';
import {
  Abilities,
  CharacterSheet,
  EquipmentChoices,
  ItemDetails,
  ItemIcon,
  slotLabels,
} from './CharacterSheet';
import { CharacterEditor } from './CharacterEditor';
import { ModelSelect } from './ModelSelect';
import { useNarration } from './useNarration';
import { TurnImagePrompt } from './TurnImagePrompt';
import { EquipmentPanel } from './EquipmentPanel';
import { ThemeSelect } from './ThemeSelect';
import { api } from './api';
import './style.css';

type SavedCharacter = Character & { id: string };
type Me = {
  id: string;
  name: string;
  characters: SavedCharacter[];
  campaigns: { id: string; config: CampaignConfig; status: string; isHost: boolean }[];
};
type Auth = { connected: boolean; shared: boolean; email: string | null; usageUrl: string };
const defaultCampaign: CampaignConfig = {
  ruleset: 'roguelike-v1',
  name: '',
  setting: '',
  premise: '',
  tone: 'Atmospheric, adventurous, with a little danger',
  language: 'English',
  instructions: '',
  custom: [],
  provider: 'chatgpt',
  model: '',
};
const path = location.pathname;
const icon = { size: 18, strokeWidth: 1.6 };
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
function Button({
  children,
  secondary = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return (
    <button {...props} className={`${secondary ? 'button secondary' : 'button'} ${props.className ?? ''}`}>
      {children}
    </button>
  );
}
function ErrorBox({ error }: { error: string }) {
  return error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
}
function Badge({ children, green = false }: { children: ReactNode; green?: boolean }) {
  return (
    <span className={`badge ${green ? 'green' : ''}`}>
      <span className="dot" />
      {children}
    </span>
  );
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand ${small ? 'small' : ''}`}>
      <span className="brand-mark">
        <Dices size={small ? 22 : 26} strokeWidth={1.4} />
      </span>
      gather<span className="brand-period">.</span>
    </span>
  );
}
function Landscape() {
  return (
    <svg className="landscape" viewBox="0 0 700 390" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="sky" x1="350" y1="0" x2="350" y2="390" gradientUnits="userSpaceOnUse">
          <stop stopColor="#25352b" />
          <stop offset="1" stopColor="#121d18" />
        </linearGradient>
        <linearGradient id="mount" x1="0" y1="150" x2="700" y2="390" gradientUnits="userSpaceOnUse">
          <stop stopColor="#53604a" />
          <stop offset="1" stopColor="#1d2b22" />
        </linearGradient>
      </defs>
      <path fill="url(#sky)" d="M0 0h700v390H0z" />
      <circle cx="482" cy="111" r="53" fill="#dba677" />
      <circle cx="482" cy="111" r="78" stroke="#b5b791" strokeOpacity=".16" />
      <circle cx="482" cy="111" r="100" stroke="#b5b791" strokeOpacity=".08" />
      <path d="m0 280 146-122 48 44 140-126 91 105 55-18 125 92 95-87v222H0Z" fill="url(#mount)" />
      <path d="m195 202 139-126 45 51-37-16-16 21-14-7-29 43-15-5-40 56Z" fill="#a8ad8a" opacity=".45" />
      <path d="m0 321 102-72 77 54 119-77 96 67 168-112 138 112v97H0Z" fill="#1c2b21" />
      <path d="M0 341c124-28 165 28 298-10s204-38 402-3v62H0Z" fill="#111d16" />
      <path
        d="M335 390c-29-43 116-47 127-81 10-31-20-35-5-55"
        stroke="#bfb084"
        strokeOpacity=".4"
        strokeWidth="2"
        strokeDasharray="4 6"
      />
      <g fill="#111d16">
        <path d="M447 259v-78h25v78zm-9-78 21-22 22 22zM451 159v-20h15v20z" />
        <path d="m80 336 23-94 23 94zm-41 0 19-67 18 67zm552 26 26-117 26 117zm36 0 20-87 24 87z" />
      </g>
      <path d="M458 232v-14a4 4 0 0 1 8 0v14" fill="#d5a065" />
      <g fill="#cecba4" opacity=".7">
        <circle cx="146" cy="67" r="1.4" />
        <circle cx="238" cy="39" r="1.1" />
        <circle cx="577" cy="54" r="1.2" />
        <circle cx="631" cy="121" r="1.3" />
        <circle cx="388" cy="32" r="1" />
        <circle cx="80" cy="140" r="1.1" />
      </g>
    </svg>
  );
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const refresh = async () => setMe(await api<Me>('/api/me'));
  useEffect(() => {
    refresh().catch((e) => setError(errorText(e)));
  }, []);
  if (!me)
    return (
      <div className="loading-page">
        <Mark />
        <p>{error || 'Setting the table…'}</p>
        {error && <Button onClick={() => location.reload()}>Try again</Button>}
      </div>
    );
  const screen = path.startsWith('/screen/');
  const match = path.match(/^\/(campaign|screen)\/([a-f0-9-]+)$/);
  return (
    <div className={`app ${screen ? 'screen-app' : ''}`}>
      {!screen && (
        <aside className="sidebar">
          <a href="/" className="brand-link">
            <Mark />
          </a>
          <div className="sidebar-section">YOUR ADVENTURES</div>
          <nav>
            <a
              className={path === '/' || path === '/new' || path.startsWith('/campaign') ? 'active' : ''}
              href="/"
            >
              <Compass {...icon} />
              Campaigns
            </a>
            <a className={path === '/characters' ? 'active' : ''} href="/characters">
              <Users {...icon} />
              Character library
            </a>
          </nav>
          <div className="sidebar-note">
            <span className="tiny-star">✧</span>
            <p>
              Every great story
              <br />
              starts around a table.
            </p>
            <span className="note-rule" />
          </div>
          <nav className="bottom-nav">
            <ThemeSelect />
            <a href="/settings" className={path === '/settings' ? 'active' : ''}>
              <Settings2 {...icon} />
              Settings
            </a>
          </nav>
          <div className="identity">
            <span className="avatar mini">{me.name[0]}</span>
            <div>
              <b>{me.name}</b>
              <small>Your local profile</small>
            </div>
          </div>
        </aside>
      )}
      <main className="main">
        {!screen && (
          <header className="topbar">
            <a href="/" className="mobile-brand">
              <Mark small />
            </a>
            <div className="breadcrumb">
              <span>Your table</span>
              <span>/</span>
              <b>
                {path === '/characters'
                  ? 'Characters'
                  : path === '/settings'
                    ? 'Settings'
                    : path.startsWith('/join')
                      ? 'Join a session'
                      : 'Campaigns'}
              </b>
            </div>
            <span className="local-status">
              <span className="dot" />
              Locally hosted
            </span>
          </header>
        )}
        {match ? (
          <Campaign id={match[2]} screen={screen} />
        ) : path.startsWith('/join/') ? (
          <Join code={path.split('/')[2]} me={me} />
        ) : path === '/characters' ? (
          <Library me={me} refresh={refresh} />
        ) : path === '/settings' ? (
          <Settings me={me} refresh={refresh} />
        ) : path === '/new' ? (
          <CreateCampaign />
        ) : (
          <Dashboard me={me} />
        )}
      </main>
    </div>
  );
}

function Dashboard({ me }: { me: Me }) {
  const [code, setCode] = useState('');
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">A PLACE FOR YOUR NEXT ADVENTURE</div>
          <h1>Your campaigns</h1>
          <p>Gather your party. Pick up where the story left off.</p>
        </div>
        <a href="/new" className="button">
          <Plus {...icon} />
          New campaign
        </a>
      </div>
      <section className="hero">
        <div className="hero-copy">
          <span className="overline">
            <span className="line" /> THE NEXT CHAPTER IS YOURS
          </span>
          <h2>
            Enter the slop with ai slop lmao.
            <br />
            Prepare to cringe.
          </h2>
          <p>Your imagination, your companions, and a game master ready to follow you into the unknown.</p>
          <a href="/new" className="button light">
            Start an adventure
            <ArrowRight {...icon} />
          </a>
          <div className="hero-foot">
            <Dices size={15} /> REAL ROLLS <span>·</span>
            <BookOpen size={15} /> LASTING STORIES
          </div>
        </div>
        <Landscape />
        <span className="illustration-label">THERE IS ALWAYS ANOTHER PATH</span>
      </section>
      <div className="section-heading">
        <h2>
          At your table <span className="count">{me.campaigns.length}</span>
        </h2>
        <span className="muted">Your worlds, saved between sessions</span>
      </div>
      {me.campaigns.length ? (
        <div className="campaign-grid">
          {me.campaigns.map((c, i) => (
            <a href={`/campaign/${c.id}`} className="campaign-card" key={c.id}>
              <div className={`card-art art-${i % 3}`}>
                <Compass size={60} strokeWidth={0.6} />
                <Badge green={c.status === 'active'}>
                  {c.status === 'active' ? 'In progress' : 'Preparing the party'}
                </Badge>
              </div>
              <div className="card-body">
                <span className="eyebrow">
                  {c.config.provider === 'practice' ? 'SCRIPTED PRACTICE' : 'CHATGPT GAME MASTER'}
                </span>
                <h3>{c.config.name}</h3>
                <p>{c.config.setting}</p>
                <div className="card-bottom">
                  <span>
                    <Users size={14} />
                    {c.isHost ? 'You are the leader' : 'Party member'}
                  </span>
                  <ArrowRight {...icon} />
                </div>
              </div>
            </a>
          ))}
        </div>
      ) : (
        <div className="empty-campaign">
          <div className="empty-icon">
            <BookOpen size={27} strokeWidth={1.2} />
          </div>
          <div>
            <h3>A fresh page awaits</h3>
            <p>Create your first campaign, or join a friend's table below.</p>
          </div>
          <a href="/new" className="text-link">
            Create a campaign
            <ArrowRight size={16} />
          </a>
        </div>
      )}
      <section className="join-strip">
        <span className="join-icon">
          <Users size={23} />
        </span>
        <div>
          <h3>Already have a seat at the table?</h3>
          <p>Enter the session code shared by your campaign leader.</p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            location.assign(`/join/${code.trim().toUpperCase()}`);
          }}
        >
          <input
            aria-label="Session code"
            placeholder="Session code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            pattern="[a-fA-F0-9]{12}"
          />
          <Button secondary>
            Join session
            <ArrowRight size={16} />
          </Button>
        </form>
      </section>
      <footer className="page-footer">
        <span>
          <Shield size={13} />
          Your worlds stay on your host.
        </span>
        <span>Made for the stories you tell together.</span>
      </footer>
    </div>
  );
}

function CreateCampaign() {
  const [config, setConfig] = useState<CampaignConfig>(defaultCampaign);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const from = new URLSearchParams(location.search).get('from');
    if (from)
      api<Snapshot>(`/api/campaigns/${from}`)
        .then((s) => setConfig({ ...s.config, name: `${s.config.name} — new run` }))
        .catch((e) => setError(errorText(e)));
  }, []);
  const change = <K extends keyof CampaignConfig>(key: K, value: CampaignConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const c = await api<Snapshot>('/api/campaigns', config);
      location.assign(`/campaign/${c.id}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <div className="page narrow">
      <a className="back-link" href="/">
        <ArrowLeft size={16} />
        All campaigns
      </a>
      <div className="page-heading">
        <div>
          <div className="eyebrow">SET THE SCENE</div>
          <h1>A new adventure</h1>
          <p>A few details give your game master a world to work with.</p>
        </div>
        <Compass className="heading-icon" size={46} strokeWidth={1} />
      </div>
      <form onSubmit={submit} className="form-panel">
        <div className="form-section">
          <h3>The world</h3>
          <Field label="Campaign name">
            <input
              value={config.name}
              maxLength={100}
              onChange={(e) => change('name', e.target.value)}
              placeholder="What will this story be called?"
              required
            />
          </Field>
          <Field label="Setting">
            <textarea
              value={config.setting}
              maxLength={500}
              onChange={(e) => change('setting', e.target.value)}
              placeholder="A world, a city, a time, or a feeling…"
              required
              rows={2}
            />
          </Field>
          <Field label="The premise">
            <textarea
              value={config.premise}
              maxLength={2500}
              onChange={(e) => change('premise', e.target.value)}
              placeholder="What brings the party together? Leave room for a surprise."
              rows={3}
            />
          </Field>
          <div className="two-columns">
            <Field label="Tone & themes">
              <input value={config.tone} maxLength={300} onChange={(e) => change('tone', e.target.value)} />
            </Field>
            <Field label="GM output language">
              <select
                aria-label="GM output language"
                aria-describedby="gm-language-help"
                value={config.language}
                onChange={(e) => change('language', e.target.value as CampaignConfig['language'])}
              >
                <option>English</option>
                <option>Nederlands</option>
              </select>
              <small id="gm-language-help">
                GM text uses this language. Game mechanics terms stay in English.
              </small>
            </Field>
          </div>
        </div>
        <div className="form-section">
          <h3>Make it yours</h3>
          <Field label="Extra instructions">
            <textarea
              value={config.instructions}
              maxLength={3000}
              onChange={(e) => change('instructions', e.target.value)}
              placeholder="More intrigue, less combat, a particular play style…"
              rows={2}
            />
          </Field>
          {config.custom.map((f, i) => (
            <div className="custom-row" key={i}>
              <input
                aria-label={`Custom field ${i + 1} name`}
                placeholder="Field name"
                value={f.key}
                onChange={(e) =>
                  change(
                    'custom',
                    config.custom.map((x, n) => (n === i ? { ...x, key: e.target.value } : x)),
                  )
                }
                required
              />
              <input
                aria-label={`Custom field ${i + 1} value`}
                placeholder="Value"
                value={f.value}
                onChange={(e) =>
                  change(
                    'custom',
                    config.custom.map((x, n) => (n === i ? { ...x, value: e.target.value } : x)),
                  )
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${f.key || 'field'}`}
                onClick={() =>
                  change(
                    'custom',
                    config.custom.filter((_, n) => n !== i),
                  )
                }
              >
                <X size={16} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="text-link"
            disabled={config.custom.length >= 20}
            onClick={() => change('custom', [...config.custom, { key: '', value: '' }])}
          >
            <Plus size={16} />
            Add a custom field
          </button>
        </div>
        <div className="form-section">
          <h3>Your game master</h3>
          <div className="mode-options">
            <label className={config.provider === 'chatgpt' ? 'mode selected' : 'mode'}>
              <input
                type="radio"
                name="provider"
                value="chatgpt"
                checked={config.provider === 'chatgpt'}
                onChange={() => change('provider', 'chatgpt')}
              />
              <Sparkles size={22} />
              <b>ChatGPT</b>
              <span>
                Uses the leader's connected plan.
                <br />
                Connect in Settings before starting.
              </span>
            </label>
            <label className={config.provider === 'practice' ? 'mode selected' : 'mode'}>
              <input
                type="radio"
                name="provider"
                value="practice"
                checked={config.provider === 'practice'}
                onChange={() => change('provider', 'practice')}
              />
              <Dices size={22} />
              <b>Practice table</b>
              <span>
                A scripted scene with real rolls.
                <br />
                No AI usage or credits needed.
              </span>
            </label>
          </div>
          {config.provider === 'chatgpt' && (
            <ModelSelect value={config.model} onChange={(value) => change('model', value)} disabled={busy} />
          )}
        </div>
        <ErrorBox error={error} />
        <div className="form-actions">
          <a href="/" className="muted">
            Cancel
          </a>
          <Button disabled={busy}>
            {busy ? <LoaderCircle className="spin" {...icon} /> : <Plus {...icon} />}Create campaign
          </Button>
        </div>
      </form>
    </div>
  );
}

function Library({ me, refresh }: { me: Me; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState<Character | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR CHARACTERS, YOUR STORIES</div>
          <h1>Character library</h1>
          <p>
            Describe a concept to discover your character, or reuse a saved character for another campaign.
          </p>
          <a className="text-link" href="/settings">
            Use Google sign-in to find your characters on another device
          </a>
        </div>
        <Button
          disabled={!!draft}
          onClick={() => {
            setEditingId(null);
            setDraft(templateCharacter('', ''));
          }}
        >
          <Plus {...icon} />
          Create a character
        </Button>
      </div>
      {draft && (
        <CharacterEditor
          key={editingId ?? 'new'}
          initial={draft}
          campaigns={me.campaigns}
          saveUrl={editingId ? `/api/characters/${editingId}` : undefined}
          onCancel={() => setDraft(null)}
          onSave={async () => {
            await refresh();
            setDraft(null);
          }}
        />
      )}
      <div className="character-grid">
        {me.characters.map((c) => (
          <article className="library-card" key={c.id}>
            <span className="avatar large">{c.name[0]}</span>
            <div className="eyebrow">{c.species}</div>
            <h2>{c.name}</h2>
            <p>{c.appearance}</p>
            <p>{c.background}</p>
            <div className="small-stats">
              {stats.map((stat) => (
                <div key={stat}>
                  <span>{stat}</span>
                  <b>{c.stats[stat]}</b>
                </div>
              ))}
            </div>
            {c.traits.map((t) => (
              <p className="small" key={t.id}>
                <b>{t.name}</b> · {t.description}
              </p>
            ))}
            <Abilities character={c} />
            <Button
              secondary
              disabled={!!draft}
              onClick={() => {
                const { id, ...sheet } = c;
                setEditingId(id);
                setDraft(sheet);
              }}
            >
              Review saved character
            </Button>
            <p className="small muted">
              Regenerate from a concept for future games, or review your character before starting.
            </p>
            <Button
              secondary
              disabled={!!draft}
              onClick={() => {
                const { id: _id, ...sheet } = c;
                setEditingId(null);
                setDraft(sheet);
              }}
            >
              Create from this template
            </Button>
          </article>
        ))}
      </div>
      {!me.characters.length && !draft && (
        <div className="large-empty">
          <Feather size={45} strokeWidth={1} />
          <h2>A character only you could imagine.</h2>
          <p>Start with a blank template or let ChatGPT interpret your concept.</p>
        </div>
      )}
    </div>
  );
}

function Join({ code, me }: { code: string; me: Me }) {
  const [invite, setInvite] = useState<{ name: string; setting: string; provider: string } | null>(null);
  const [name, setName] = useState(me.name === 'Adventurer' ? '' : me.name);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [characters, setCharacters] = useState(me.characters);
  const [selected, setSelected] = useState(me.characters[0]?.id ?? '');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    api<typeof invite>(`/api/invites/${code}`)
      .then(setInvite)
      .catch((e) => setError(errorText(e)));
  }, [code]);
  async function join(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<Snapshot>('/api/join', { code, playerName: name, characterId: selected });
      location.assign(`/campaign/${result.id}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <div className="page narrow">
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR SEAT AT THE TABLE</div>
          <h1>{invite?.name ?? 'Join the party'}</h1>
          <p>{invite?.setting ?? 'Checking your invitation…'}</p>
        </div>
        <Users size={45} strokeWidth={1} />
      </div>
      <ErrorBox error={error} />
      <ProfileAccess name={me.name} />
      {invite && (
        <>
          <form className="form-panel join-form" onSubmit={join}>
            <Badge green>
              {invite.provider === 'practice' ? 'Offline practice' : 'ChatGPT dungeon master'}
            </Badge>
            <Field label="Your player name">
              <input
                required
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                placeholder="What should the party call you?"
              />
            </Field>
            <Field label="Your character template">
              <select value={selected} required onChange={(e) => setSelected(e.target.value)}>
                <option value="">Choose a saved character</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.species}
                  </option>
                ))}
              </select>
            </Field>
            <button type="button" className="text-link" onClick={() => setEditing(true)}>
              <Plus size={16} />
              Create a new character
            </button>
            <p className="muted small">
              Your template is reusable. This campaign gets its own character state. Death ends this run
              permanently; the saved template remains available for future campaigns.
            </p>
            <div className="form-actions">
              <a href="/" className="muted">
                Back to your table
              </a>
              <Button disabled={busy || !selected}>{busy ? 'Joining…' : 'Join the party'}</Button>
            </div>
          </form>
          {editing && (
            <CharacterEditor
              code={code}
              onCancel={() => setEditing(false)}
              onSave={(c) => {
                setCharacters((all) => [c, ...all]);
                setSelected(c.id);
                setEditing(false);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function ProfileAccess({ name }: { name: string }) {
  const [account, setAccount] = useState<{
    configured: boolean;
    signedIn: boolean;
    email: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    new URLSearchParams(location.search).has('googleError')
      ? 'Google sign-in was cancelled or could not be verified. Your current profile is unchanged. Please try again.'
      : '',
  );
  useEffect(() => {
    api<typeof account>('/api/player-auth')
      .then(setAccount)
      .catch((e) => setError(errorText(e)));
  }, []);
  return (
    <section className="form-panel profile-access">
      <h2>Your player account</h2>
      <p>
        Playing as <b>{name}</b>
        {account?.signedIn ? ` · ${account.email}` : ' · saved in this browser'}.
      </p>
      <p>
        Sign in with the same Google account on your phone or laptop to open your characters and campaign seat
        on this host.
      </p>
      {!account?.signedIn && (
        <p className="small muted">
          First time? Sign in on the browser containing your characters to attach this profile. If your Google
          account already has a profile here, signing in opens that library instead; libraries are not merged.
        </p>
      )}
      {account && !account.configured && (
        <p role="status">
          Google sign-in needs host setup: an OAuth web client and an HTTPS callback address. See the Google
          sign-in section in README.md. You can keep playing with this browser profile meanwhile.
        </p>
      )}
      <Button
        secondary
        disabled={busy || !account?.configured}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const result = await api<{ url: string }>('/api/player-auth/google', {
              returnTo: location.pathname,
            });
            location.assign(result.url);
          } catch (e) {
            setError(errorText(e));
            setBusy(false);
          }
        }}
      >
        {account?.signedIn ? 'Switch Google account' : 'Continue with Google'}
      </Button>
      {account?.signedIn && (
        <Button
          secondary
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await api('/api/player-auth/logout', {});
              location.assign('/settings');
            } catch (e) {
              setError(errorText(e));
              setBusy(false);
            }
          }}
        >
          Sign out of this device
        </Button>
      )}
      <p className="small muted">
        Google identifies your player profile. The host’s ChatGPT connection still runs the game. Characters
        are stored on this host, not in Google Drive.
      </p>
      <ErrorBox error={error} />
    </section>
  );
}

function AbilityBalance() {
  const [data, setData] = useState<AbilityChoiceStats | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError('');
    try {
      setData(await api<AbilityChoiceStats>('/api/characters/ability-stats'));
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="form-panel ability-balance" aria-label="Ability choice statistics">
      <h3>Ability choice statistics</h3>
      <p className="muted small">
        Each saved character counts once. Edits replace its choices; joining campaigns adds no votes. This
        measures saved preferences, not combat success. Names and character concepts are excluded.
      </p>
      <Button secondary disabled={busy} onClick={load}>
        {busy ? 'Loading…' : 'Refresh statistics'}
      </Button>
      <ErrorBox error={error} />
      {data && (
        <>
          <p>
            {data.characters} saved characters · {data.offers} offers · {data.selections} selections
          </p>
          {data.rows.length ? (
            <div
              className="ability-balance-table"
              tabIndex={0}
              role="region"
              aria-label="Ability selection rates"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Ability</th>
                    <th scope="col">Base power</th>
                    <th scope="col">Offered</th>
                    <th scope="col">Chosen</th>
                    <th scope="col">Pick rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={JSON.stringify([row.kind, row.effect, row.stat, row.dice, row.bonus])}>
                      <th scope="row">
                        {row.kind === 'utility' ? 'Utility' : row.effect} · {row.stat}
                      </th>
                      <td>
                        {row.dice
                          ? `${row.dice}${row.bonus ? ` + ${row.bonus}` : ''}`
                          : row.effect === 'guard'
                            ? `+${3 + row.bonus} defense`
                            : `Advantage${row.bonus ? ` + ${row.bonus}` : ''}`}
                      </td>
                      <td>{row.offered}</td>
                      <td>{row.selected}</td>
                      <td>{Math.round((row.selected / row.offered) * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted small">
              Save a character with ability choices to start measuring preferences.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Settings({ me, refresh }: { me: Me; refresh: () => Promise<void> }) {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [name, setName] = useState(me.name);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    const update = () =>
      api<Auth>('/api/chatgpt')
        .then(setAuth)
        .catch((e) => setError(errorText(e)));
    update();
    const timer = setInterval(update, 3000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (auth?.connected)
      api<{ id: string; name: string }[]>('/api/chatgpt/models')
        .then(setModels)
        .catch((e) => setError(errorText(e)));
  }, [auth?.connected]);
  async function connect() {
    setError('');
    setBusy(true);
    try {
      const result = await api<{ url: string }>('/api/chatgpt/connect', {});
      setUrl(result.url);
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page narrow">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MAKE YOURSELF AT HOME</div>
          <h1>Table settings</h1>
          <p>Your profile and the connection behind your game master.</p>
        </div>
      </div>
      <section className="form-panel">
        <div className="connection-heading">
          <span className="connection-icon">
            <Sparkles size={26} />
          </span>
          <div>
            <h2>ChatGPT</h2>
            <p>Bring your subscription to the table.</p>
          </div>
          <Badge green={!!auth?.connected}>
            {auth?.connected ? (auth.shared ? 'Host signed in' : 'Signed in') : 'Not connected'}
          </Badge>
        </div>
        <p>
          Eligible requests use the connected ChatGPT plan and its usage limits. Gather has no API-key billing
          fallback.
        </p>
        {auth?.connected ? (
          <>
            <div className="connected-account">
              <CheckCheck size={20} />
              {auth.shared ? 'Using the host’s ChatGPT connection' : auth.email}
              <span>Using ChatGPT plan</span>
            </div>
            <p className="muted small">
              Sign-in is confirmed. AI requests can still be blocked by usage limits; signing in does not
              confirm that generation is available.
            </p>
            {models.length > 0 && (
              <p className="muted small">
                Available models: {models.map((m) => m.name).join(', ')}. Choose a model when creating a
                campaign. Automatic uses the first available model, regardless of price.
              </p>
            )}
            {auth.shared ? (
              <p className="muted small">
                The host provides ChatGPT for character creation and game turns. You do not need to sign in.
              </p>
            ) : (
              <div className="button-row">
                <a className="button secondary" href={auth.usageUrl} target="_blank" rel="noreferrer">
                  Manage usage
                  <ArrowRight size={16} />
                </a>
                <Button
                  secondary
                  onClick={async () => {
                    try {
                      const result = await api<{ message: string }>('/api/chatgpt/disconnect', {});
                      setNotice(result.message);
                      setAuth({ ...auth, connected: false });
                    } catch (e) {
                      setError(errorText(e));
                    }
                  }}
                >
                  Disconnect
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="info-box">
              Connect from the host computer using <b>127.0.0.1</b>. You'll authorize Gather in an OpenAI
              sign-in window, then return here. Subscription access depends on your account's eligibility.
            </div>
            <Button disabled={busy} onClick={connect}>
              {busy ? <LoaderCircle className="spin" {...icon} /> : <Sparkles {...icon} />}Continue with
              ChatGPT
            </Button>
            {url && (
              <p className="small">
                <a className="text-link" href={url} target="_blank" rel="noreferrer">
                  Open sign-in if the new tab did not appear
                  <ArrowRight size={14} />
                </a>
              </p>
            )}
          </>
        )}
        <ErrorBox error={error} />
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
      </section>
      <form
        className="form-panel"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('/api/profile', { name });
            await refresh();
            setNotice('Profile saved.');
          } catch (e) {
            setError(errorText(e));
          }
        }}
      >
        <h3>Your player profile</h3>
        <Field label="Display name">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
        </Field>
        <Button secondary>Save profile</Button>
        <p className="muted small">
          This browser remembers your local identity. Keep its cookies to return to your characters and
          campaigns.
        </p>
      </form>
      <ProfileAccess name={me.name} />
      {['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && auth?.shared !== true && (
        <AbilityBalance />
      )}
    </div>
  );
}

const conditionDescriptions: Partial<Record<string, string>> = {
  ...Object.fromEntries(ailments.map((name) => [name, conditionDescription(name)])),
  Downed: 'At 0 HP and unable to act. An ally can help you up to 1 HP or heal you.',
  Escaped: 'You have left the fight. Rejoining combat removes this condition.',
};

function ItemInspection({ item }: { item: Item }) {
  return (
    <details className="item-inspection">
      <summary>
        <ItemIcon kind={item.kind} />
        {item.name} <small>({item.kind})</small>
      </summary>
      <ItemDetails item={item} />
    </details>
  );
}

function MemberCard({
  member,
  ready,
  current,
  host,
  onActive,
  onHelpUp,
  helpDisabled = false,
}: {
  member: Member;
  ready: boolean;
  current: boolean;
  host?: boolean;
  onActive?: () => void;
  onHelpUp?: () => void;
  helpDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const state = member.state;
  const dead = isDead(state);
  const downed = isDowned(state);
  return (
    <article
      className={`member-card ${!member.active || dead ? 'sitting-out' : ''} ${downed ? 'downed' : ''}`}
    >
      <button className="member-heading" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="avatar">{member.character.name[0]}</span>
        <span>
          <b>{member.character.name}</b>
          <small>
            {member.character.species} · Lv {state.level}
          </small>
        </span>
        <ChevronDown size={15} className={open ? 'rotated' : ''} />
      </button>
      <div className="hp-row">
        <span>
          <Heart size={13} />
          {state.hp}
          <small> / {state.maxHp}</small>
        </span>
        <span className={`ready-state ${ready ? 'ready' : ''} ${downed ? 'downed-state' : ''}`}>
          {downed
            ? 'Downed · needs help'
            : dead
              ? 'Fallen'
              : !state.equipmentChosen
                ? 'Choosing equipment'
                : state.pendingLevelUps
                  ? `${state.pendingLevelUps} level-up rewards`
                  : !member.active
                    ? 'Sitting out'
                    : !current
                      ? 'Next turn'
                      : ready
                        ? 'Action submitted'
                        : 'Considering…'}
        </span>
      </div>
      <div className="hp-track">
        <span style={{ width: `${(state.hp / state.maxHp) * 100}%` }} />
      </div>
      <div className="hud-line">
        <span>XP {state.xp}/100</span>
        <span>DEF {defense(member.character, state)}</span>
        <span>{state.gold} gold</span>
      </div>
      {downed && (
        <>
          <p className="downed-hint">An ally can spend their turn to help them up with 1 HP.</p>
          {onHelpUp && (
            <Button secondary disabled={helpDisabled} onClick={onHelpUp}>
              Help up {member.character.name}
            </Button>
          )}
        </>
      )}
      {dead && member.replacement && (
        <p className="replacement-ready">
          {member.replacement.character.name} joins next turn after a victory · Level 1 · 0 XP
        </p>
      )}
      <div className="small-stats">
        {stats.map((stat) => (
          <div key={stat}>
            <span>{stat}</span>
            <b>
              {state.stats[stat]}{' '}
              <small>
                ({modifier(state.stats[stat]) >= 0 ? '+' : ''}
                {modifier(state.stats[stat])})
              </small>
            </b>
          </div>
        ))}
      </div>
      {state.conditions.length > 0 && (
        <div className="conditions">
          {state.conditions
            .filter((c) => !c.startsWith('Rested:'))
            .map((c) => (
              <span
                key={c}
                title={conditionDescriptions[c]}
                aria-label={conditionDescriptions[c] ? `${c}: ${conditionDescriptions[c]}` : c}
              >
                {c}
                {ailments.some((name) => name === c)
                  ? ` · ${state.conditionTurns[c] ?? conditionDuration(c)} turns`
                  : ''}
              </span>
            ))}
        </div>
      )}
      {open && (
        <div className="member-detail">
          <p>{member.character.appearance}</p>
          <p>{member.character.background}</p>
          <h4>Traits</h4>
          {member.character.traits.map((t) => (
            <p className="ability-detail" key={t.id}>
              <b>{t.name}</b>
              <small>{t.description}</small>
            </p>
          ))}
          <h4>Abilities</h4>
          <Abilities character={member.character} state={member.state} />
          <h4>Equipment</h4>
          <ul>
            {slots.map((slot) => (
              <li key={slot}>
                <b>{slotLabels[slot]}</b>
                {state.equipment[slot] ? <ItemInspection item={state.equipment[slot]} /> : <span>None</span>}
              </li>
            ))}
          </ul>
          <h4>
            Backpack {occupiedSlots(state)}/{capacity(member.character)}
          </h4>
          <ul>
            {state.inventory.map((item) => (
              <li key={item.id}>
                <ItemInspection item={item} />
                <span>×{item.quantity}</span>
              </li>
            ))}
          </ul>
          {dead && (
            <div className="death-report">
              <b>RUN ENDED</b>
              <p>{state.deathReason}</p>
              <small>
                Level {state.level} · {state.kills} enemies · {state.bosses} bosses
              </small>
            </div>
          )}
        </div>
      )}
      {host && state.hp > 0 && (
        <button className="sit-out" onClick={onActive}>
          {member.active ? 'Sit out player' : 'Rejoin next turn'}
        </button>
      )}
    </article>
  );
}

function WorldStatus({ snapshot: s, onTarget }: { snapshot: Snapshot; onTarget?: (name: string) => void }) {
  const encounter = s.scene.encounter;
  return (
    <div className="world-status">
      <div className="location-banner">
        <span className="eyebrow">CURRENT LOCATION</span>
        <h3>{s.scene.location.name}</h3>
        <p>{s.scene.location.atmosphere || s.config.premise}</p>
        <small>
          {s.scene.encounters} encounters completed
          {s.scene.location.hazard && ` · ${s.scene.location.hazard}`}
        </small>
      </div>
      {encounter && (
        <section className="combat-panel">
          <div className="section-heading">
            <h3>
              <Swords size={16} />{' '}
              {encounter.victory
                ? 'Encounter won'
                : encounter.escaped
                  ? 'The party escaped'
                  : `Combat · Round ${encounter.round}`}
            </h3>
            <Badge>{encounter.victory ? 'Loot available' : 'Initiative order'}</Badge>
          </div>
          <div className="initiative-order">
            {encounter.initiative.map((actor, i) => (
              <span key={actor.id}>
                {i + 1}.{' '}
                {s.members.find((m) => m.id === actor.id)?.character.name ??
                  encounter.enemies.find((e) => e.id === actor.id)?.name}{' '}
                ({actor.total})
              </span>
            ))}
          </div>
          <div className="enemy-list">
            {encounter.enemies.map((e) => (
              <article
                key={e.id}
                role={onTarget ? 'button' : undefined}
                tabIndex={onTarget && e.hp > 0 && !e.withdrawn ? 0 : undefined}
                aria-label={onTarget ? `Add ${e.name} to your action` : undefined}
                aria-disabled={onTarget && (e.hp === 0 || !!e.withdrawn)}
                onClick={() => e.hp > 0 && !e.withdrawn && onTarget?.(e.name)}
                onKeyDown={(event) => {
                  if (onTarget && e.hp > 0 && !e.withdrawn && ['Enter', ' '].includes(event.key)) {
                    event.preventDefault();
                    onTarget(e.name);
                  }
                }}
              >
                <span className="eyebrow">{e.tier}</span>
                <b>{e.name}</b>
                <p>{e.description}</p>
                <span>
                  {e.withdrawn ? 'Withdrawn · ' : ''}HP {e.hp}/{e.maxHp} · Defense{' '}
                  {e.defense - (e.conditions?.includes('Chilled') ? 2 : 0)} · Attack{' '}
                  {e.attack - (e.conditions?.includes('Weakened') ? 2 : 0) >= 0 ? '+' : ''}
                  {e.attack - (e.conditions?.includes('Weakened') ? 2 : 0)} · Damage {e.damage}
                </span>
                {!!e.conditions?.length && (
                  <div className="conditions">
                    {e.conditions.map((condition) => (
                      <span key={condition} title={conditionDescription(condition)}>
                        {condition} · {e.conditionTurns?.[condition] ?? conditionDuration(condition)} turns
                      </span>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ReplacementPicker({
  member,
  busy,
  command,
}: {
  member: Member;
  busy: boolean;
  command: (route: string, body: unknown) => Promise<Snapshot | undefined>;
}) {
  const [characters, setCharacters] = useState<SavedCharacter[]>([]);
  const [characterId, setCharacterId] = useState(member.replacement?.characterId ?? '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  async function load(signal?: AbortSignal) {
    setLoading(true);
    setError('');
    try {
      const me = await api<Me>('/api/me', undefined, signal);
      setCharacters(me.characters.filter((character) => character.selectedEquipmentIds.length === 2));
    } catch (e) {
      if (!signal?.aborted) setError(errorText(e));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);
  useEffect(() => {
    setCharacterId(member.replacement?.characterId ?? '');
  }, [member.replacement?.characterId]);
  return (
    <section className="replacement-picker" aria-label="Next-turn character">
      <h3>Return with a new character</h3>
      <p>
        Create and save a new character with two starting pieces, then queue them here. After a successful
        encounter, the game master introduces them on the next turn at level 1 with zero experience.
      </p>
      {member.replacement && (
        <p className="replacement-ready" role="status">
          <b>{member.replacement.character.name}</b> is ready for the next turn after a victory. Level 1 · 0
          XP · Fresh starting equipment.
        </p>
      )}
      <Field label="Replacement character">
        <select
          value={characterId}
          onChange={(e) => setCharacterId(e.target.value)}
          disabled={busy || loading}
        >
          <option value="">{loading ? 'Loading saved characters…' : 'Choose a character'}</option>
          {characters.map((character) => (
            <option key={character.id} value={character.id}>
              {character.name} · {character.species}
            </option>
          ))}
        </select>
      </Field>
      {!loading && !characters.length && (
        <p>Save a character and choose their two starting pieces in the character library first.</p>
      )}
      <ErrorBox error={error} />
      <div className="button-row">
        <Button
          disabled={busy || loading || !characterId || characterId === member.replacement?.characterId}
          onClick={() => command('replacement', { characterId })}
        >
          {member.replacement ? 'Change queued character' : 'Queue for next turn'}
        </Button>
        {member.replacement && (
          <Button secondary disabled={busy} onClick={() => command('replacement', { characterId: null })}>
            Cancel replacement
          </Button>
        )}
      </div>
      <div className="replacement-library">
        <a className="text-link" href="/characters" target="_blank" rel="noreferrer">
          Create a character <ArrowRight size={14} />
        </a>
        <button className="text-link" disabled={busy || loading} onClick={() => load()}>
          <RefreshCw size={14} /> Refresh saved characters
        </button>
      </div>
    </section>
  );
}

function CharacterControls({
  member,
  snapshot: s,
  busy,
  command,
  selectedAbility,
  onAbilitySelect,
}: {
  member: Member;
  snapshot: Snapshot;
  busy: boolean;
  command: (route: string, body: unknown) => Promise<Snapshot | undefined>;
  selectedAbility?: string | null;
  onAbilitySelect?: (name: string | null) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [rewardBusy, setRewardBusy] = useState(false);
  const manage = (body: unknown) => command('character', body);
  const state = member.state;
  const inCombat = isInCombat(s.scene, state);
  const downedAllies = s.members.filter(
    (ally) => ally.id !== member.id && isDowned(ally.state) && canInteract(s.scene, state, ally.state),
  );
  const locked =
    busy ||
    rewardBusy ||
    (!!s.turn && s.turn.phase !== 'collecting') ||
    !!s.turn?.actions.some((a) => a.memberId === member.id);
  if (isDowned(state))
    return (
      <div className="downed-report" role="status">
        <h2>DOWNED · {member.character.name}</h2>
        <p>
          {s.status === 'ended'
            ? 'No party member remains able to help. This run has ended in defeat.'
            : 'You cannot act while downed. An ally can spend their turn to help you up with 1 HP, or heal you. Once helped, you can act on the next turn. Going down again in this encounter is permanent death.'}
        </p>
      </div>
    );
  if (isDead(state))
    return (
      <div className="run-ended">
        <h2>FALLEN · {member.character.name}</h2>
        <p>{state.deathReason}</p>
        <p>
          Level {state.level} · {state.kills} enemies defeated · {state.bosses} bosses defeated
        </p>
        <p>Your character's death is permanent. You can keep watching the surviving party.</p>
        {s.status === 'active' ? (
          <ReplacementPicker member={member} busy={busy} command={command} />
        ) : s.status === 'ended' ? (
          <p>The party has been defeated. Start a new campaign to play another character.</p>
        ) : null}
      </div>
    );
  return (
    <div className="character-controls">
      {!state.equipmentChosen && (
        <section>
          <CharacterSheet character={member.character} />
          <EquipmentChoices
            character={member.character}
            state={state}
            items={state.starterEquipment}
            selected={selected}
            onChange={setSelected}
            disabled={locked}
          />
          <Button
            disabled={locked || selected.length !== 2}
            onClick={() => manage({ type: 'starter', itemIds: selected })}
          >
            Confirm starting equipment
          </Button>
        </section>
      )}
      {state.pendingLevelUps > 0 && (
        <section className="level-up">
          <span className="eyebrow">LEVEL {state.level}</span>
          <h3>Choose your level-up reward</h3>
          <p>
            {state.pendingLevelUps} {state.pendingLevelUps === 1 ? 'reward' : 'rewards'} available. Your
            maximum HP has increased.
          </p>
          <div className="level-up-choices">
            {(Object.entries(levelUpChoices) as [LevelUpChoice, string][]).map(([choice, label]) => {
              const kind = choice.endsWith('combat') ? 'combat' : 'utility';
              const unavailable =
                choice.startsWith('upgrade') && !member.character.abilities.some((a) => a.kind === kind);
              return (
                <Button
                  key={choice}
                  secondary
                  disabled={locked || unavailable}
                  title={unavailable ? 'Gain an ability in this category first.' : undefined}
                  onClick={async () => {
                    setRewardBusy(true);
                    try {
                      await command('level-up', { choice });
                    } finally {
                      setRewardBusy(false);
                    }
                  }}
                >
                  {label}
                </Button>
              );
            })}
          </div>
          {rewardBusy && (
            <p role="status">Generating and saving your reward… This can take up to two minutes.</p>
          )}
        </section>
      )}
      {state.lastLevelUp && <p className="reward-result">{state.lastLevelUp}</p>}
      {state.conditions.includes('Escaped') && (
        <p>
          You are outside combat. You can act and use out-of-combat abilities, but must rejoin the fight
          before interacting with anyone still fighting. Attacking or using an offensive combat ability
          rejoins the fight.
        </p>
      )}
      <Abilities
        character={member.character}
        state={state}
        inCombat={!!inCombat}
        selected={selectedAbility}
        onSelect={onAbilitySelect}
        disabled={locked || state.pendingLevelUps > 0 || !state.equipmentChosen}
      />
      {downedAllies.length > 0 && s.status === 'active' && (
        <section>
          <h3>Help a downed ally</h3>
          <p>
            Use Help up on their party card to spend your turn helping them recover with 1 HP. Healing an ally
            with an item or ability also uses your turn. They can act on the next turn.
          </p>
        </section>
      )}
      {state.equipmentChosen && (
        <EquipmentPanel
          member={member}
          snapshot={s}
          command={command}
          healingLockReason={
            busy || rewardBusy
              ? 'Saving your changes…'
              : s.status === 'archived' || s.status === 'ended'
                ? 'Healing is unavailable after this run.'
                : s.turn && s.turn.phase !== 'collecting'
                  ? 'Healing is locked while this round finishes.'
                  : s.turn?.actions.some((action) => action.memberId === member.id)
                    ? 'Your action is already submitted.'
                    : ''
          }
          lockReason={
            busy || rewardBusy
              ? 'Saving your changes…'
              : s.status === 'archived' || s.status === 'ended'
                ? 'Equipment changes are unavailable after this run.'
                : inCombat
                  ? 'Equipment changes are available outside combat. Healing items remain available.'
                  : s.turn && s.turn.phase !== 'collecting'
                    ? 'Equipment is locked while this round finishes.'
                    : s.turn?.actions.some((action) => action.memberId === member.id)
                      ? 'Equipment is locked after submitting your action, until the next turn.'
                      : ''
          }
        />
      )}
      {s.scene.safeRest && !inCombat && (
        <Button
          secondary
          disabled={locked || state.restedEncounter === s.scene.encounters}
          onClick={() => manage({ type: 'rest' })}
        >
          <Moon size={15} />
          Safe rest · restore 25% HP
        </Button>
      )}
    </div>
  );
}

function RollReceipt({ roll, members, action }: { roll: Roll; members: Member[]; action?: Action }) {
  const member = members.find((m) => m.id === roll.memberId);
  return (
    <details className={`roll-receipt ${roll.success ? 'success' : 'miss'}`}>
      <summary>
        <span className="die">
          <Dices size={20} />
        </span>
        <div>
          <b>
            {roll.label ??
              `${action?.characterName ?? member?.character.name ?? 'World'} · ${roll.stat}`}{' '}
          </b>
          <small>
            {roll.dice.join(', ')} {roll.modifier >= 0 ? '+' : '−'} {Math.abs(roll.modifier)}{' '}
            {(!roll.notation || roll.notation === 'd20') && <span>vs DC {roll.dc}</span>}
          </small>
        </div>
        <strong>{roll.total}</strong>
        <span className="roll-result">
          {roll.critical === 'success'
            ? 'NAT 20'
            : roll.critical === 'failure'
              ? 'NAT 1'
              : roll.success
                ? 'Success'
                : 'Setback'}
        </span>
        <ChevronDown className="roll-chevron" size={16} aria-hidden="true" />
      </summary>
      <dl className="roll-details">
        {action && !action.passed && (
          <>
            <dt>Submitted action</dt>
            <dd>{action.text}</dd>
          </>
        )}
        {(roll.abilityName || action?.abilityName) && (
          <>
            <dt>Ability</dt>
            <dd>{roll.abilityName ?? action?.abilityName}</dd>
          </>
        )}
        <dt>Check explanation</dt>
        <dd>{roll.reason}</dd>
        <dt>Roll mode</dt>
        <dd>{roll.mode}</dd>
        <dt>Dice source</dt>
        <dd>{roll.source}</dd>
      </dl>
    </details>
  );
}

function TurnSummary({ turn }: { turn: Turn }) {
  if (!turn.result) return null;
  const [situation, ...appendices] = turn.result.summary.split(
    /\n\n(?=(?:XP-beloningen|XP rewards|Uitrustingswijzigingen|Equipment changes):\n)/,
  );
  const bookkeeping =
    turn.resolution?.events.filter((event) => 'presentation' in event && event.presentation === 'log') ?? [];
  return (
    <div className="recap">
      <b>The situation</b>
      <p>{situation}</p>
      {(bookkeeping.length > 0 || appendices.length > 0) && (
        <details className="turn-mechanics">
          <summary>Mechanics & rewards</summary>
          {bookkeeping.map((event) => (
            <p key={event.id}>{event.fact}</p>
          ))}
          {appendices.map((text, index) => (
            <p key={index}>{text}</p>
          ))}
        </details>
      )}
    </div>
  );
}

function Campaign({ id, screen }: { id: string; screen: boolean }) {
  const [s, setS] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState('story');
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const actionInput = useRef<HTMLTextAreaElement>(null);
  const [abilityName, setAbilityName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const narration = useNarration(s?.config.language ?? 'English', !!s?.isHost || screen);
  useEffect(() => {
    let events: EventSource | undefined;
    let disposed = false;
    const connect = async () => {
      if (screen && location.hash) {
        await api(`/api/campaigns/${id}/display`, { token: location.hash.slice(1) });
        history.replaceState(null, '', location.pathname);
      }
      const snapshot = await api<Snapshot>(`/api/campaigns/${id}`);
      if (disposed) return;
      setS(snapshot);
      events = new EventSource(`/api/campaigns/${id}/events`);
      events.onopen = () => setConnected(true);
      events.onmessage = (event) => {
        setS(JSON.parse(event.data));
        setConnected(true);
      };
      events.onerror = () => setConnected(false);
    };
    connect().catch((e) => setError(errorText(e)));
    return () => {
      disposed = true;
      events?.close();
    };
  }, [id, screen]);
  useEffect(() => {
    setAction('');
    setAbilityName(null);
  }, [s?.turn?.id]);
  async function command(route: string, body: unknown) {
    setBusy(true);
    setError('');
    try {
      const updated = await api<Snapshot>(`/api/campaigns/${id}/${route}`, body);
      setS((previous) => (!previous || updated.version >= previous.version ? updated : previous));
      return updated;
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (!s)
    return (
      <div className="page">
        <ErrorBox error={error} />
        {!error && <p className="muted">Opening your campaign…</p>}
        <a href="/" className="back-link">
          Back to your table
        </a>
      </div>
    );
  const myCharacter = s.members.find((m) => m.id === s.myMemberId);
  const turn = s.turn;
  const mine = turn?.actions.find((a) => a.memberId === s.myMemberId);
  const canAct =
    !!s.myMemberId &&
    turn?.roster.includes(s.myMemberId) &&
    turn.phase === 'collecting' &&
    !mine?.supportAction &&
    !!myCharacter &&
    myCharacter.state.hp > 0 &&
    myCharacter.state.pendingLevelUps === 0 &&
    myCharacter.state.equipmentChosen;
  const latest = s.history.at(-1);
  const selectedIndex = s.history.findIndex((t) => t.id === selectedTurnId);
  const viewedIndex = selectedIndex < 0 ? s.history.length - 1 : selectedIndex;
  const viewedTurn = s.history[viewedIndex];
  const visibleHistory = viewedTurn ? [viewedTurn] : [];
  const viewingCurrent = viewedIndex === s.history.length - 1;
  const canTarget =
    viewingCurrent &&
    !screen &&
    canAct &&
    !mine &&
    !busy &&
    !!s.scene.encounter &&
    !s.scene.encounter.victory &&
    !s.scene.encounter.escaped;
  function insertTarget(name: string) {
    if (!canTarget) return;
    const cursor = actionInput.current?.selectionStart ?? action.length;
    // Insert without deleting the player's selection or changing their submitted intent.
    const before = action.slice(0, cursor);
    const after = action.slice(cursor);
    const inserted = action.trim()
      ? `${before && !/\s$/.test(before) ? ' ' : ''}${name}${after && !/^\s/.test(after) ? ' ' : ''}`
      : s!.config.language === 'Nederlands'
        ? `Ik val ${name} aan.`
        : `I attack ${name}.`;
    const next = action.trim() ? before + inserted + after : inserted;
    if (next.length > 2000) return;
    setAction(next);
    requestAnimationFrame(() => {
      actionInput.current?.focus();
      const position = action.trim() ? cursor + inserted.length : inserted.length;
      actionInput.current?.setSelectionRange(position, position);
    });
  }
  const submitted = turn?.actions.length ?? 0;
  const expected = turn?.roster.length ?? 0;
  const host = s.isHost && !screen;
  const partyOrigin = s.partyOrigins?.[0] ?? location.origin;
  const joinLink = `${partyOrigin}/join/${s.inviteCode}`;
  async function copyInvite() {
    try {
      if (!navigator.clipboard) throw new Error('Copy this session link: ' + joinLink);
      await navigator.clipboard.writeText(joinLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Session link: ' + joinLink);
    }
  }
  return (
    <div className={`page campaign-page ${screen ? 'display-page' : ''}`}>
      {screen && (
        <div className="display-top">
          <a href="/">
            <Mark small />
          </a>
          <div className="display-controls">
            <ThemeSelect />
            <span className="local-status">
              <span className="dot" />
              {connected ? 'Live at the table' : 'Reconnecting…'}
            </span>
          </div>
        </div>
      )}
      <div className="campaign-heading">
        <div>
          <span className="eyebrow">
            {s.config.provider === 'practice' ? 'PRACTICE TABLE · SCRIPTED, NO AI' : 'YOUR SHARED ADVENTURE'}
          </span>
          <h1>{s.config.name}</h1>
          <p>{s.config.setting}</p>
        </div>
        <div className="campaign-tools">
          {host && (
            <>
              <button className="button secondary" onClick={copyInvite}>
                {copied ? <Check size={16} /> : <Copy size={16} />}Invite players
              </button>
              <a
                className="button secondary"
                href={`${partyOrigin}/screen/${id}#${s.displayToken}`}
                target="_blank"
                rel="noreferrer"
              >
                <Monitor size={16} />
                Shared screen
              </a>
            </>
          )}
          <Badge green={connected}>
            {s.status === 'lobby'
              ? 'Gathering the party'
              : s.status === 'ended'
                ? 'Run ended'
                : `Turn ${turn?.number ?? 1}`}
          </Badge>
        </div>
      </div>
      <ErrorBox error={error} />
      {turn?.phase === 'failed' && !viewingCurrent && (
        <div role="alert" className="button-row">
          <span>The current turn is on hold. Your actions and dice are saved.</span>
          <Button onClick={() => setSelectedTurnId(null)}>View recovery controls</Button>
        </div>
      )}
      {screen && (
        <section className="form-panel">
          <b>Shared screen · viewing only</b>
          <p>
            Review characters and choose equipment from your player view. The campaign creator starts the
            story from their leader view.
          </p>
          <a className="button secondary" href={`/campaign/${id}`}>
            Open player / leader controls
          </a>
          <p className="small">
            If this device does not remember you, restore your profile in <a href="/settings">Settings</a>.
          </p>
        </section>
      )}
      {!screen && !s.isHost && !myCharacter && (
        <section className="form-panel">
          <h2>This browser is viewing the table</h2>
          <p>
            Your player profile is not signed in here. Open the invitation to join, or restore your existing
            profile in Settings.
          </p>
          <a className="button secondary" href="/settings">
            Find my player profile
          </a>
        </section>
      )}
      {s.status === 'lobby' && (
        <section className="form-panel lobby-setup">
          <h2>{!screen && myCharacter ? 'Prepare your character' : 'Party readiness'}</h2>
          <ul aria-label="Party readiness">
            {s.members.map((m) => (
              <li key={m.id}>
                <b>{m.character.name}</b> ·{' '}
                {!m.active
                  ? 'Sitting out'
                  : m.state.equipmentChosen
                    ? 'Ready to begin'
                    : 'Needs to choose two starting equipment pieces on their player device'}
              </li>
            ))}
          </ul>
          {!s.members.length && <p>Invite at least one player to join with a character.</p>}
          {!screen && myCharacter && (
            <>
              <p>
                You control <b>{myCharacter.character.name}</b>. Regenerating replaces your starting equipment
                and also saves your library template.
              </p>
              <Button secondary disabled={busy} onClick={() => setEditing(!editing)}>
                Review my character
              </Button>
              {editing ? (
                <CharacterEditor
                  campaignId={id}
                  initial={myCharacter.character}
                  saveUrl={`/api/campaigns/${id}/template`}
                  onCancel={() => setEditing(false)}
                  onSave={async () => {
                    setS(await api<Snapshot>(`/api/campaigns/${id}`));
                    setEditing(false);
                  }}
                />
              ) : (
                <CharacterControls member={myCharacter} snapshot={s} busy={busy} command={command} />
              )}
            </>
          )}
          {!screen && !host && myCharacter?.state.equipmentChosen && (
            <p role="status">You are ready. Waiting for the campaign leader to begin the story.</p>
          )}
          {host && (
            <p>
              {s.members.some((m) => m.active && !m.state.equipmentChosen)
                ? 'Waiting for the players listed above to choose two equipment pieces. Then Begin the story will unlock.'
                : 'When your party is ready, select Begin the story below.'}
            </p>
          )}
        </section>
      )}
      {s.status === 'ended' && (
        <div className="run-ended">
          <h2>RUN ENDED</h2>
          <p>
            {s.members.some((member) => isDowned(member.state))
              ? 'The party has been defeated. No one remains able to help the downed members. '
              : 'The party has fallen. '}
            Their choices and discoveries remain in this chronicle. Begin a new campaign for a new run.
          </p>
          <a className="button" href="/new">
            Start a new run
          </a>
        </div>
      )}
      {host && (
        <div className="host-bar">
          <span>
            <Shield size={15} />
            Leader's table
          </span>
          {s.status === 'lobby' ? (
            <>
              <span className="session-code">
                Session code <b>{s.inviteCode}</b>
              </span>
              {!s.myMemberId && (
                <a className="text-link" href={`/join/${s.inviteCode}`}>
                  Take a seat
                  <Plus size={14} />
                </a>
              )}
              <Button
                disabled={
                  busy || !s.members.length || s.members.some((m) => m.active && !m.state.equipmentChosen)
                }
                onClick={() => command('start', {})}
              >
                <Play size={15} />
                Begin the story
              </Button>
            </>
          ) : (
            <>
              <button
                className="text-link"
                disabled={busy}
                onClick={() => command('pause', { paused: !s.paused })}
              >
                {s.paused ? <Play size={15} /> : <Pause size={15} />}{' '}
                {s.paused ? 'Resume automatic turns' : 'Pause after this turn'}
              </button>
              <a className="text-link" href={`/new?from=${id}`}>
                New run from this world
              </a>
              <a className="text-link" href={`/api/campaigns/${id}/export`}>
                <Download size={15} />
                Export campaign
              </a>
            </>
          )}
        </div>
      )}
      {(s.isHost || screen) && (
        <section className="narration-controls" aria-label="Turn narration">
          <div className="narration-toolbar">
            {host && (
              <label className="field">
                <span>GM output language</span>
                <select
                  value={s.config.language}
                  onChange={(e) => command('language', { language: e.target.value })}
                  disabled={busy || turn?.phase === 'queued' || turn?.phase === 'resolving'}
                >
                  <option>English</option>
                  <option>Nederlands</option>
                </select>
              </label>
            )}
            <label className="field">
              <span>Narrator voice</span>
              <select
                value={narration.voiceId}
                onChange={(e) => narration.setVoiceId(e.target.value)}
                disabled={!narration.supported || narration.readingTurnId !== null}
              >
                <option value="">Automatic ({s.config.language})</option>
                {narration.voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name} ({voice.language})
                  </option>
                ))}
              </select>
            </label>
            <Button
              secondary
              disabled={!narration.supported || !latest?.result?.narration.trim()}
              onClick={() => latest?.result && narration.read(latest.id, latest.result.narration)}
            >
              <Volume2 size={16} />
              Read latest turn
            </Button>
            {narration.readingTurnId !== null && (
              <Button secondary onClick={narration.stop}>
                <Square size={15} />
                Stop reading
              </Button>
            )}
          </div>
          {host && (
            <p className="small">
              Future GM text uses this language. Game mechanics terms such as STR, DEX, attack, and strike
              stay in English. Saved turns keep their original text.
            </p>
          )}
          <p className="small" role="status">
            {!narration.supported
              ? 'Turn narration is unavailable in this browser.'
              : narration.readingTurnId !== null
                ? 'Reading aloud on this device…'
                : 'Narration plays through this device’s speakers. Available voices depend on your browser.'}
          </p>
          <ErrorBox error={narration.error} />
        </section>
      )}
      <div className="session-grid">
        <section className="story-column">
          <div className="session-tabs">
            <button className={tab === 'story' ? 'active' : ''} onClick={() => setTab('story')}>
              <BookOpen size={16} />
              The story
            </button>
            <button className={tab === 'journal' ? 'active' : ''} onClick={() => setTab('journal')}>
              <Feather size={16} />
              World journal <span>{s.journal.length}</span>
            </button>
            <span className="connection-status">
              {connected ? (
                <>
                  <Radio size={13} />
                  Live
                </>
              ) : (
                'Reconnecting…'
              )}
            </span>
          </div>
          {tab === 'journal' ? (
            <div className="journal">
              {s.journal.length ? (
                s.journal.map((j, i) => (
                  <article key={i}>
                    <span className="eyebrow">{j.kind}</span>
                    <h3>{j.name}</h3>
                    <p>{j.detail}</p>
                  </article>
                ))
              ) : (
                <div className="large-empty">
                  <Feather size={32} />
                  <h3>The world is still unfolding.</h3>
                  <p>People, places, and discoveries will be remembered here.</p>
                </div>
              )}
            </div>
          ) : (
            <>
              <WorldStatus snapshot={s} onTarget={canTarget ? insertTarget : undefined} />
              {s.status === 'lobby' && (
                <div className="lobby-scene">
                  <div className="lobby-art">
                    <Landscape />
                  </div>
                  <div className="lobby-copy">
                    <span className="eyebrow">BEFORE THE FIRST CHAPTER</span>
                    <h2>The table is set.</h2>
                    <p>
                      {s.members.length
                        ? 'Your companions are gathering. The leader can begin when everyone has chosen two starting equipment pieces.'
                        : 'Invite your companions and choose your characters. Every adventure starts with the people around the table.'}
                    </p>
                    {s.config.premise && <blockquote>{s.config.premise}</blockquote>}
                    {s.inviteCode && (
                      <div className="lobby-invite">
                        <span>JOIN THIS SESSION</span>
                        <b>{s.inviteCode}</b>
                        <small>{joinLink}</small>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {viewedTurn && (
                <nav className="turn-navigation" aria-label="Turn history">
                  <Button
                    secondary
                    disabled={viewedIndex <= 0}
                    onClick={() => setSelectedTurnId(s.history[viewedIndex - 1].id)}
                  >
                    <ArrowLeft size={15} />
                    Previous turn
                  </Button>
                  <span aria-live="polite">
                    {viewedTurn.number === 0 ? 'Viewing opening scene' : `Viewing turn ${viewedTurn.number}`}
                  </span>
                  <Button
                    secondary
                    disabled={viewingCurrent}
                    onClick={() =>
                      setSelectedTurnId(
                        viewedIndex + 1 === s.history.length - 1 ? null : s.history[viewedIndex + 1].id,
                      )
                    }
                  >
                    Next turn
                    <ArrowRight size={15} />
                  </Button>
                  <Button secondary disabled={viewingCurrent} onClick={() => setSelectedTurnId(null)}>
                    Current turn
                  </Button>
                </nav>
              )}
              {visibleHistory.map((t) => (
                <article className="story-turn" key={t.id}>
                  <div className="turn-divider">
                    <span>
                      {t.number === 0 ? 'THE OPENING SCENE' : `CHAPTER IN MOTION · TURN ${t.number}`}
                    </span>
                    <span className="line" />
                    <span>✧</span>
                  </div>
                  {t.actions.length > 0 && (
                    <div className="past-actions">
                      {t.actions.map((a) => (
                        <div key={a.memberId}>
                          <b>
                            {a.characterName ?? s.members.find((m) => m.id === a.memberId)?.character.name}
                          </b>
                          <span>
                            {a.passed ? 'Passed this turn.' : a.text}
                            {a.abilityName && <small> · {a.abilityName}</small>}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {t.rolls.length > 0 && (
                    <div className="rolls">
                      {t.rolls.map((r) => (
                        <RollReceipt
                          key={r.id}
                          roll={r}
                          members={s.members}
                          action={t.actions.find((a) => a.memberId === r.memberId)}
                        />
                      ))}
                    </div>
                  )}
                  {!!t.diagnostics?.length && (
                    <div className="gm-diagnostics">
                      <p>The GM recovered this turn. Debugging details:</p>
                      {t.diagnostics.map((message) => (
                        <ErrorBox key={message} error={message} />
                      ))}
                    </div>
                  )}
                  <div className="narrator">
                    <span className="gm-avatar">
                      <Sparkles size={17} />
                    </span>
                    <b>{s.config.provider === 'practice' ? 'Practice narrator' : 'Game master'}</b>
                    <small>
                      {s.config.provider === 'practice' ? 'Scripted scene' : 'Using ChatGPT plan'}
                    </small>
                    {(s.isHost || screen) && (
                      <button
                        className="text-link"
                        disabled={!narration.supported || !t.result?.narration.trim()}
                        onClick={() => t.result && narration.read(t.id, t.result.narration)}
                      >
                        <Volume2 size={14} />
                        {t.number === 0 ? 'Read opening scene' : `Read turn ${t.number}`}
                      </button>
                    )}
                  </div>
                  <div className="narration">
                    {t.result?.narration
                      .split('\n')
                      .filter(Boolean)
                      .map((p, i) => (
                        <p key={i}>{p}</p>
                      ))}
                  </div>
                  <TurnImagePrompt config={s.config} turn={t} />
                  <TurnSummary turn={t} />
                </article>
              ))}
              {viewingCurrent && turn && (
                <div className="current-turn">
                  <div className="current-heading">
                    <span className="eyebrow">
                      {turn.phase === 'collecting'
                        ? 'THE PARTY IS DECIDING'
                        : turn.phase === 'failed'
                          ? 'THE STORY IS ON HOLD'
                          : 'THE WORLD RESPONDS'}
                    </span>
                    <span>
                      {submitted} / {expected} ready
                    </span>
                  </div>
                  {turn.actions.map((a) => (
                    <div className="action-bubble" key={a.memberId}>
                      <span className="avatar mini">
                        {(a.characterName ?? s.members.find((m) => m.id === a.memberId)?.character.name)?.[0]}
                      </span>
                      <div>
                        <b>{a.characterName ?? s.members.find((m) => m.id === a.memberId)?.character.name}</b>
                        <p>
                          <span>{a.passed ? 'Passes this turn.' : a.text}</span>
                          {a.abilityName && <small> · {a.abilityName}</small>}
                        </p>
                      </div>
                      <Check size={15} />
                    </div>
                  ))}
                  {!!turn.equipmentChanges?.length && (
                    <div className="turn-equipment-changes">
                      <b>Equipment changes this turn</b>
                      {turn.equipmentChanges.map((change, index) => (
                        <p key={index}>
                          {change.characterName}: {change.description}
                        </p>
                      ))}
                    </div>
                  )}
                  {turn.phase === 'collecting' && (
                    <p className="waiting-copy">
                      {s.paused
                        ? 'Automatic turns are paused by the leader.'
                        : expected
                          ? 'The next turn begins as soon as everyone has submitted an action.'
                          : 'No active players. The leader can bring a player back to the table.'}
                    </p>
                  )}
                  {['queued', 'resolving'].includes(turn.phase) && (
                    <div className="thinking">
                      <LoaderCircle className="spin" size={22} />
                      <span>
                        {turn.automaticRetry
                          ? 'The GM timed out. Resuming your saved turn from checkpoints…'
                          : 'The game master is weaving your actions into the story…'}
                      </span>
                    </div>
                  )}
                  {turn.phase === 'failed' && (
                    <div className="failed-turn">
                      <ErrorBox error={turn.error ?? 'The turn could not finish.'} />
                      <p>Your actions, dice and completed steps are saved.</p>
                      {host && (
                        <div className="button-row">
                          <Button disabled={busy} onClick={() => command('retry', {})}>
                            <RefreshCw size={16} />
                            Retry saved turn
                          </Button>
                          <a className="text-link" href="/settings">
                            Connection settings
                            <ArrowRight size={14} />
                          </a>
                        </div>
                      )}
                      {!host && (
                        <p>
                          {s.leaderName ?? 'The campaign leader'} can resume this turn from the leader view.{' '}
                          <a className="text-link" href={`/campaign/${id}`}>
                            Open player / leader controls
                          </a>
                        </p>
                      )}
                      {turn.rolls.map((r) => (
                        <RollReceipt
                          key={r.id}
                          roll={r}
                          members={s.members}
                          action={turn.actions.find((a) => a.memberId === r.memberId)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {viewingCurrent && !screen && myCharacter && s.status !== 'lobby' && (
                <CharacterControls
                  member={myCharacter}
                  snapshot={s}
                  busy={busy}
                  command={command}
                  selectedAbility={abilityName}
                  onAbilitySelect={
                    canAct
                      ? (name) => {
                          setAbilityName(name);
                          if (name && !action.trim()) setAction(`Use ${name}.`);
                        }
                      : undefined
                  }
                />
              )}
              {viewingCurrent &&
                !screen &&
                s.myMemberId &&
                turn &&
                myCharacter &&
                myCharacter.state.hp > 0 && (
                  <form
                    className="action-composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      command('action', {
                        turnId: turn.id,
                        text: action,
                        passed: false,
                        abilityName,
                      });
                    }}
                  >
                    <label htmlFor="action-input">
                      {mine?.supportAction
                        ? 'Helping your party uses your turn. You can cancel while the party decides.'
                        : mine
                          ? 'Your action is submitted. Cancel it before rewriting to stop the party from advancing.'
                          : 'What does your character do?'}
                    </label>
                    {abilityName && !mine?.supportAction && (
                      <p className="selected-ability">
                        Using <b>{abilityName}</b>. Describe the situation and your intended target below.
                        <button
                          className="text-link"
                          type="button"
                          disabled={!canAct || busy}
                          onClick={() => setAbilityName(null)}
                        >
                          Remove ability
                        </button>
                      </p>
                    )}
                    <textarea
                      ref={actionInput}
                      id="action-input"
                      aria-label="Your action"
                      rows={3}
                      value={mine?.supportAction ? mine.text : action}
                      onChange={(e) => setAction(e.target.value)}
                      maxLength={2000}
                      disabled={!canAct || busy}
                      placeholder={
                        canAct
                          ? 'Describe your action. The world is listening…'
                          : 'Your next action opens with the next turn.'
                      }
                    />
                    <div className="composer-bottom">
                      <span>
                        <Feather size={14} />
                        Your action will appear on the shared screen.
                      </span>
                      <div>
                        {mine && turn.phase === 'collecting' && (
                          <Button
                            type="button"
                            secondary
                            disabled={busy}
                            onClick={async () => {
                              const updated = await command('action/cancel', { turnId: turn.id });
                              if (updated) {
                                if (!action.trim() || mine.supportAction) setAction(mine.text);
                                setAbilityName(mine.abilityName ?? null);
                              }
                            }}
                          >
                            Cancel action
                          </Button>
                        )}
                        <Button
                          type="button"
                          secondary
                          disabled={!canAct || busy}
                          onClick={() => command('action', { turnId: turn.id, text: '', passed: true })}
                        >
                          Pass
                        </Button>
                        <Button disabled={!canAct || busy || !action.trim()}>
                          <Send size={15} />
                          {mine ? 'Update action' : 'Submit action'}
                        </Button>
                      </div>
                    </div>
                  </form>
                )}
            </>
          )}
        </section>
        <aside className="party-column">
          <div className="party-heading">
            <h3>
              <Users size={17} />
              The party
            </h3>
            <span>{s.members.length}</span>
          </div>
          {!s.members.length && (
            <div className="empty-party">
              <Users size={30} strokeWidth={1} />
              <p>There's room for a few good companions.</p>
            </div>
          )}
          {s.members.map((m) => (
            <MemberCard
              key={m.id}
              member={m}
              ready={!!turn?.actions.some((a) => a.memberId === m.id)}
              current={s.status === 'lobby' || !!turn?.roster.includes(m.id)}
              host={host}
              onActive={() => command('member', { memberId: m.id, active: !m.active })}
              onHelpUp={
                viewingCurrent &&
                !screen &&
                s.status === 'active' &&
                myCharacter &&
                m.id !== myCharacter.id &&
                canInteract(s.scene, myCharacter.state, m.state) &&
                m.active
                  ? () => command('character', { type: 'help-up', targetId: m.id })
                  : undefined
              }
              helpDisabled={!canAct || !!mine || busy}
            />
          ))}
          <div className="table-note">
            <Dices size={23} strokeWidth={1.2} />
            <h4>Let the dice decide.</h4>
            <p>Checks are rolled by the server and saved with your story.</p>
            <span>Cryptographic d20 rolls</span>
          </div>
          {s.config.custom.length > 0 && (
            <div className="world-notes">
              <span className="eyebrow">WORLD DETAILS</span>
              {s.config.custom.map((f) => (
                <div key={f.key}>
                  <b>{f.key}</b>
                  <span>{f.value}</span>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
