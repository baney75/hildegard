// SPDX-License-Identifier: AGPL-3.0-only
import type {
  PostFile,
  PostPlatformId,
  PostSite,
  PostSourceRef,
  PostState,
  PostTarget,
} from '@hildegard/presets';
import { useEffect, useId, useMemo, useState } from 'react';
import { api } from '../lib/api.ts';
import { bytes, clock } from '../lib/format.ts';
import { Button, Icon, Modal, Status, Switch, toast, toastError } from './ui.tsx';

/** Puts text on the clipboard, with the older way for a page the browser doesn't call secure. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    t.setAttribute('readonly', '');
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}

const LAST = 'hildegard.post.targets';
const remembered = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(LAST) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** The rows to choose from: a platform, or each of the formats that differ in what they are for. */
const ROWS: Array<{ id: string; platform: PostPlatformId; label: string; target?: string }> = [
  { id: 'youtube', platform: 'youtube', label: 'YouTube', target: 'youtube' },
  { id: 'youtube-shorts', platform: 'youtube', label: 'YouTube Shorts', target: 'youtube-shorts' },
  { id: 'instagram-reels', platform: 'instagram', label: 'Instagram Reels', target: 'instagram-reels' },
  { id: 'instagram-feed', platform: 'instagram', label: 'Instagram feed', target: 'instagram-feed' },
  { id: 'tiktok', platform: 'tiktok', label: 'TikTok' },
  { id: 'x', platform: 'x', label: 'X' },
  { id: 'facebook', platform: 'facebook', label: 'Facebook' },
  { id: 'threads', platform: 'threads', label: 'Threads' },
  { id: 'reddit', platform: 'reddit', label: 'Reddit' },
  { id: 'linkedin', platform: 'linkedin', label: 'LinkedIn' },
];

const tagsOf = (raw: string) =>
  raw
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#+/, ''))
    .filter(Boolean);

export function PostSheet({
  source,
  title,
  kind,
  compact,
  onClose,
}: {
  source: PostSourceRef;
  title: string;
  kind: 'video' | 'image';
  compact: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const [targets, setTargets] = useState<PostTarget[]>([]);
  const [sites, setSites] = useState<PostSite[]>([]);
  const [post, setPost] = useState<PostState | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(remembered()));
  const [name, setName] = useState(title);
  const [about, setAbout] = useState('');
  const [tags, setTags] = useState('');
  const [link, setLink] = useState('');
  const [disclose, setDisclose] = useState(true);
  const [onScreen, setOnScreen] = useState(false);
  const [fill, setFill] = useState(false);
  const [uhd, setUhd] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api
      .postTargets()
      .then((r) => {
        setTargets(r.targets);
        setSites(r.sites);
      })
      .catch(toastError);
    // One already prepared for this, if there is one: the checklist picks up where it was left.
    api
      .posts()
      .then((all) => setPost(all.find((p) => p.source.id === source.id && p.status !== 'failed') ?? null))
      .catch(() => {});
  }, [source.id]);

  // While it's being made, look again every second.
  const running = post?.status === 'running';
  useEffect(() => {
    if (!running || !post) return;
    const t = setInterval(
      () =>
        api
          .post(post.id)
          .then(setPost)
          .catch(() => {}),
      1000,
    );
    return () => clearInterval(t);
  }, [running, post]);

  const takes = useMemo(() => new Map(targets.map((t) => [t.id, t] as const)), [targets]);
  const canMake = (row: (typeof ROWS)[number]) => {
    const t = takes.get(row.target ?? row.id) ?? takes.get(row.id);
    return !t || t.media.includes(kind);
  };

  const toggle = (rowId: string) =>
    setChosen((c) => {
      const next = new Set(c);
      if (!next.delete(rowId)) next.add(rowId);
      return next;
    });

  const start = async () => {
    const rows = ROWS.filter((r) => chosen.has(r.id) && canMake(r));
    if (!rows.length) return;
    try {
      localStorage.setItem(LAST, JSON.stringify([...chosen]));
    } catch {}
    setStarting(true);
    try {
      const made = await api.preparePost({
        source,
        platforms: [...new Set(rows.map((r) => r.platform))],
        formats: rows.flatMap((r) => (r.target ? [r.target] : [])),
        facts: {
          title: name.trim() || undefined,
          about: about.trim() || undefined,
          tags: tagsOf(tags),
          link: link.trim() || undefined,
          disclose,
        },
        onScreenText: onScreen ? name.trim() || title : undefined,
        fit: fill ? 'crop' : 'blur',
        youtube4k: uhd || undefined,
      });
      setPost(made);
    } catch (e) {
      toastError(e);
    } finally {
      setStarting(false);
    }
  };

  const picked = ROWS.filter((r) => chosen.has(r.id) && canMake(r)).length;
  const done = post?.files.filter((f) => f.status === 'done').length ?? 0;
  const posted = post?.files.filter((f) => f.posted).length ?? 0;

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy={id}
      variant={compact ? 'bottom' : 'dialog'}
      className="st-dialog hg-postdlg"
    >
      <div className="st-dialog__h">
        <div style={{ flex: 1 }}>
          <h2 id={id}>Post</h2>
          <p>Hildegard gets each file and its words ready. You press Post, on the site.</p>
        </div>
      </div>
      <div className="st-dialog__b">
        {!post ? (
          <Form
            kind={kind}
            canMake={canMake}
            chosen={chosen}
            toggle={toggle}
            name={name}
            setName={setName}
            about={about}
            setAbout={setAbout}
            tags={tags}
            setTags={setTags}
            link={link}
            setLink={setLink}
            disclose={disclose}
            setDisclose={setDisclose}
            onScreen={onScreen}
            setOnScreen={setOnScreen}
            fill={fill}
            setFill={setFill}
            uhd={uhd}
            setUhd={setUhd}
          />
        ) : (
          <Ready post={post} sites={sites} setPost={setPost} />
        )}
      </div>
      <div className="st-dialog__f">
        {post ? (
          <>
            <span className="st-cost">
              {running
                ? `Making ${Math.min(done + 1, post.files.length)} of ${post.files.length}…`
                : post.files.length
                  ? `${posted} of ${done} posted`
                  : ''}
            </span>
            <span style={{ flex: 1 }} />
            <Button kind="ghost" onClick={() => setPost(null)} disabled={running}>
              Start over
            </Button>
            <Button kind="primary" onClick={onClose} data-autofocus="">
              Done
            </Button>
          </>
        ) : (
          <>
            <a className="body-sm hg-postdlg__sites" href="#/browse">
              Sites in the app
            </a>
            <span style={{ flex: 1 }} />
            <Button kind="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              kind="primary"
              icon="check"
              busy={starting}
              disabled={!picked}
              onClick={start}
              data-autofocus=""
            >
              {picked > 1 ? `Prepare ${picked} files` : 'Prepare'}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

function Form(p: {
  kind: 'video' | 'image';
  canMake: (r: (typeof ROWS)[number]) => boolean;
  chosen: Set<string>;
  toggle: (id: string) => void;
  name: string;
  setName: (v: string) => void;
  about: string;
  setAbout: (v: string) => void;
  tags: string;
  setTags: (v: string) => void;
  link: string;
  setLink: (v: string) => void;
  disclose: boolean;
  setDisclose: (v: boolean) => void;
  onScreen: boolean;
  setOnScreen: (v: boolean) => void;
  fill: boolean;
  setFill: (v: boolean) => void;
  uhd: boolean;
  setUhd: (v: boolean) => void;
}) {
  return (
    <>
      <fieldset className="hg-postdlg__where">
        <legend className="body-sm sec-text">Where it’s going</legend>
        {ROWS.map((r) => {
          const ok = p.canMake(r);
          return (
            <label key={r.id} data-off={ok ? undefined : ''}>
              <input
                type="checkbox"
                checked={p.chosen.has(r.id) && ok}
                disabled={!ok}
                onChange={() => p.toggle(r.id)}
              />
              <span>{r.label}</span>
              {ok ? null : <small className="muted">takes video</small>}
            </label>
          );
        })}
      </fieldset>
      <label className="hg-field--block">
        Title
        <input value={p.name} maxLength={300} onChange={(e) => p.setName(e.target.value)} />
      </label>
      <label className="hg-field--block">
        About it, in your words (optional)
        <textarea value={p.about} maxLength={5000} rows={3} onChange={(e) => p.setAbout(e.target.value)} />
      </label>
      <div className="hg-postdlg__two">
        <label className="hg-field--block">
          Your hashtags (optional)
          <input value={p.tags} placeholder="river heron" onChange={(e) => p.setTags(e.target.value)} />
        </label>
        <label className="hg-field--block">
          A link for the caption (optional)
          <input value={p.link} placeholder="https://" onChange={(e) => p.setLink(e.target.value)} />
        </label>
      </div>
      <p className="body-sm muted">
        Only what you write here goes into a caption. Each platform’s limit is kept, and what doesn’t fit is
        left out and listed for you.
      </p>
      <div className="hg-postdlg__opts">
        <div className="hg-postdlg__opt">
          <Switch checked={p.disclose} onChange={p.setDisclose} label="Say it is AI-generated" />
          <span>Say it’s AI-generated</span>
        </div>
        <div className="hg-postdlg__opt">
          <Switch checked={p.onScreen} onChange={p.setOnScreen} label="Show the title on the picture" />
          <span>Show the title on the picture, clear of each app’s buttons</span>
        </div>
        <div className="hg-postdlg__opt">
          <Switch checked={p.fill} onChange={p.setFill} label="Fill the frame" />
          <span>Fill the frame (crops the edges) instead of fitting it whole</span>
        </div>
        {p.kind === 'video' ? (
          <div className="hg-postdlg__opt">
            <Switch checked={p.uhd} onChange={p.setUhd} label="YouTube in 4K" />
            <span>YouTube at 3840 × 2160</span>
          </div>
        ) : null}
      </div>
    </>
  );
}

function fileLine(f: PostFile) {
  const parts = [`${f.width} × ${f.height}`];
  if (f.seconds != null) parts.push(clock(f.seconds));
  if (f.bytes != null) parts.push(bytes(f.bytes));
  if (f.lufs != null) parts.push(`${f.lufs.toFixed(1)} LUFS`);
  return parts.join(' · ');
}

function Ready({
  post,
  sites,
  setPost,
}: {
  post: PostState;
  sites: PostSite[];
  setPost: (p: PostState) => void;
}) {
  const site = (p: PostPlatformId) => sites.find((s) => s.id === p);
  const tick = async (f: PostFile, posted: boolean) => {
    try {
      setPost(await api.tickPosted(post.id, f.target, posted));
    } catch (e) {
      toastError(e);
    }
  };
  // Copy the words, show the file, and let the link open the site: the one click the person makes before they post.
  const take = async (f: PostFile) => {
    const ok = await copyText(f.text.caption);
    toast(ok ? 'Caption copied. Drop the file in, paste, and press Post.' : 'Couldn’t copy the caption.', {
      tone: ok ? undefined : 'error',
    });
    if (post.folder) api.revealPost(post.id, f.target).catch(() => {});
  };
  return (
    <>
      {post.status === 'failed' ? (
        <p className="body-sm hg-err" role="alert">
          <Icon name="alert" size={16} /> {post.error}
        </p>
      ) : null}
      <ol className="hg-postdlg__list">
        {post.files.map((f) => {
          const s = site(f.platform);
          return (
            <li key={f.target} data-posted={f.posted ? '' : undefined}>
              <div className="hg-postdlg__head">
                <b>{f.label}</b>
                {f.status === 'done' ? (
                  <small className="muted">{fileLine(f)}</small>
                ) : f.status === 'failed' ? (
                  <Status kind="error">Failed</Status>
                ) : (
                  <Status kind={f.status === 'running' ? 'running' : 'queued'}>
                    {f.status === 'running' ? 'Making it' : 'Waiting'}
                  </Status>
                )}
              </div>
              {f.status === 'failed' ? (
                <p className="body-sm hg-err" role="alert">
                  {f.error}
                </p>
              ) : null}
              {f.status === 'done' ? (
                <>
                  {f.text.title ? (
                    <p className="body-sm">
                      <b>Title:</b> {f.text.title}
                    </p>
                  ) : null}
                  <textarea
                    className="hg-postdlg__caption"
                    readOnly
                    rows={Math.min(6, Math.max(2, f.text.caption.split('\n').length))}
                    value={f.text.caption}
                    aria-label={`${f.label} ${f.text.title ? 'description' : 'caption'}`}
                  />
                  <small className="muted" aria-live="polite">
                    {f.text.length} of {f.text.limit} characters
                    {f.trimmed ? ' · cut to the longest this platform takes' : ''}
                    {f.textBox ? ' · title on the picture' : ''}
                  </small>
                  <div className="hg-postdlg__acts">
                    {s ? (
                      <a
                        className="hg-btn hg-btn--primary"
                        href={s.post}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => take(f)}
                      >
                        <Icon name="link" size={18} />
                        Open {s.name}
                      </a>
                    ) : null}
                    <Button
                      icon="copy"
                      onClick={async () =>
                        toast((await copyText(f.text.caption)) ? 'Copied.' : 'Couldn’t copy.')
                      }
                    >
                      Copy {f.text.title ? 'description' : 'caption'}
                    </Button>
                    {f.text.title ? (
                      <Button
                        kind="ghost"
                        onClick={async () =>
                          toast((await copyText(f.text.title!)) ? 'Title copied.' : 'Couldn’t copy.')
                        }
                      >
                        Copy title
                      </Button>
                    ) : null}
                    {post.folder ? (
                      <Button
                        kind="ghost"
                        icon="search"
                        onClick={() => api.revealPost(post.id, f.target).catch(toastError)}
                      >
                        Show file
                      </Button>
                    ) : (
                      <a
                        className="hg-btn hg-btn--ghost"
                        href={`/api/post/${post.id}/files/${f.file}?download`}
                        download
                      >
                        <Icon name="download" size={18} />
                        Download
                      </a>
                    )}
                    <label className="hg-postdlg__tick">
                      <input type="checkbox" checked={f.posted} onChange={(e) => tick(f, e.target.checked)} />
                      Posted
                    </label>
                  </div>
                </>
              ) : null}
            </li>
          );
        })}
      </ol>
      {post.notes.length || post.skipped.length ? (
        <ul className="body-sm muted hg-postdlg__notes">
          {post.skipped.map((s) => (
            <li key={s.platform}>{s.why}</li>
          ))}
          {post.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {post.folder ? (
        <p className="body-sm muted">
          The files are in <code>{post.folder}</code>.
        </p>
      ) : null}
    </>
  );
}
