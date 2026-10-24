// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

export function Icon({
  name,
  size,
  className = '',
}: {
  name: string;
  size?: 14 | 16 | 18 | 22 | 24;
  className?: string;
}) {
  return <span className={`i i-${name}${size ? ` s${size}` : ''} ${className}`.trim()} aria-hidden="true" />;
}

export type StatusKind = 'running' | 'queued' | 'done' | 'error' | 'idle';
/** Status always pairs a glyph with a word; colour never carries it alone. */
export function Status({ kind, children }: { kind: StatusKind; children: ReactNode }) {
  return <span className={`hg-status hg-status--${kind}`}>{children}</span>;
}

/**
 * A modal sheet or dialog on the native <dialog> element: the browser traps focus, makes the page behind inert and
 * handles Escape. Focus returns to whatever opened it.
 */
export function Modal({
  open,
  onClose,
  labelledBy,
  className,
  children,
  variant = 'center',
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  className?: string;
  children: ReactNode;
  variant?: 'center' | 'side' | 'side-right' | 'bottom' | 'dialog';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      d.showModal();
      const first = d.querySelector<HTMLElement>('[data-autofocus]');
      first?.focus();
    } else if (!open && d.open) {
      d.close();
      (opener.current as HTMLElement | null)?.focus?.();
    }
  }, [open]);
  useEffect(() => () => ref.current?.close(), []);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className={`hg-modal hg-modal--${variant} ${className ?? ''}`}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        // A press on the backdrop (the dialog box itself, outside its content) closes it.
        if (e.target === ref.current) onClose();
      }}
    >
      {children}
    </dialog>
  );
}

export function SheetHead({
  id,
  title,
  sub,
  onClose,
  children,
}: {
  id: string;
  title: string;
  sub?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="cs-sheet__h">
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 id={id}>{title}</h2>
        {sub ? <p>{sub}</p> : null}
      </div>
      {children}
      <button
        type="button"
        className="hg-btn hg-btn--icon hg-btn--ghost"
        aria-label="Close"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

/** Arrow keys move between radios, as in a native radio group. */
function arrowNav(e: KeyboardEvent<HTMLElement>, selector = '[role="radio"]') {
  const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)].filter(
    (b) => !b.hasAttribute('disabled'),
  );
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  const n =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[n]?.focus();
  items[n]?.click();
}

export interface Choice<T> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  className = 'hg-seg',
}: {
  label: string;
  value: T;
  options: Choice<T>[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={className} role="radiogroup" aria-label={label} onKeyDown={(e) => arrowNav(e)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A group of radio cards or chips with roving focus. Children must be role="radio" buttons. */
export function RadioGroup({
  label,
  children,
  className,
  style,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={className}
      style={style}
      onKeyDown={(e) => arrowNav(e)}
    >
      {children}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className="cs-sw"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    />
  );
}

/** A real range input, drawn like the design's slider. */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  valueText,
  ends,
  head,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  valueText?: string;
  ends?: [string, string];
  head?: ReactNode;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="cs-slider hg-range">
      {head}
      <input
        type="range"
        aria-label={label}
        aria-valuetext={valueText}
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {ends ? (
        <div className="ends" aria-hidden="true">
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </div>
      ) : null}
    </div>
  );
}

export function Button({
  icon,
  kind,
  size,
  children,
  className = '',
  busy,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: string;
  kind?: 'primary' | 'ghost' | 'force' | 'danger';
  size?: 'sm' | 'lg';
  busy?: boolean;
}) {
  const cls = [
    'hg-btn',
    kind && `hg-btn--${kind}`,
    size && `hg-btn--${size}`,
    !children && 'hg-btn--icon',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={cls}
      {...rest}
      aria-busy={busy || undefined}
      disabled={rest.disabled || busy}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} /> : null}
      {children}
    </button>
  );
}

/** A small menu for "More" buttons. Closes on Escape, outside clicks and after a choice. */
export function Menu({
  label,
  items,
  icon = 'more',
  size,
}: {
  label: string;
  icon?: string;
  size?: 'sm';
  items: Array<{ label: string; icon?: string; danger?: boolean; onSelect: () => void } | null>;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', off);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  const list = items.filter((x): x is NonNullable<typeof x> => !!x);
  return (
    <div className="hg-menu" ref={root}>
      <button
        type="button"
        className={`hg-btn hg-btn--icon hg-btn--ghost${size ? ' hg-btn--sm' : ''}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={icon} size={size ? 16 : undefined} />
      </button>
      {open ? (
        <div
          className="hg-menu__list"
          role="menu"
          id={id}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
              root.current?.querySelector<HTMLElement>('button')?.focus();
            }
            arrowNav(e, '[role="menuitem"]');
          }}
        >
          {list.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={it.danger ? 'danger' : undefined}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.icon ? <Icon name={it.icon} size={16} /> : null}
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Toasts ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
  action?: { label: string; run: () => void };
}
let toasts: Toast[] = [];
let nextId = 1;
const toastListeners = new Set<() => void>();
const emitToasts = () => {
  for (const l of toastListeners) l();
};

export function toast(
  text: string,
  opts: { tone?: Toast['tone']; action?: Toast['action']; ms?: number } = {},
) {
  const t: Toast = { id: nextId++, text, tone: opts.tone ?? 'info', action: opts.action };
  toasts = [...toasts.filter((x) => x.text !== text), t].slice(-3);
  emitToasts();
  setTimeout(() => dismiss(t.id), opts.ms ?? (opts.tone === 'error' ? 8000 : 4000));
}
const dismiss = (id: number) => {
  toasts = toasts.filter((x) => x.id !== id);
  emitToasts();
};
export const toastError = (e: unknown) => toast((e as Error).message, { tone: 'error' });

export function Toasts() {
  const list = useSyncExternalStore(
    (l) => {
      toastListeners.add(l);
      return () => toastListeners.delete(l);
    },
    () => toasts,
  );
  return (
    <div className="hg-toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`hg-toast${t.tone === 'error' ? ' err' : ''}`}>
          {t.tone === 'error' ? <Icon name="alert" size={18} /> : null}
          <span>{t.text}</span>
          {t.action ? (
            <button
              type="button"
              className="hg-btn hg-btn--sm hg-btn--ghost"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="hg-btn hg-btn--sm hg-btn--icon hg-btn--ghost"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The gold and green rings that turn while a take renders. `value` is 0..1. */
export function LiveRing({ value, size = 48 }: { value: number | null; size?: number }) {
  const outer = 2 * Math.PI * 20;
  const v = value ?? 0.08;
  return (
    <svg
      className={`cs-live__ring${value === null ? ' indeterminate' : ''}`}
      viewBox="0 0 48 48"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <circle className="tr" cx="24" cy="24" r="20" />
      <circle
        className="br"
        cx="24"
        cy="24"
        r="20"
        strokeDasharray={`${Math.max(4, v * outer)} ${outer}`}
        transform="rotate(-90 24 24)"
      />
      <circle className="tr" cx="24" cy="24" r="13" />
      <circle className="in spin" cx="24" cy="24" r="13" strokeDasharray="12 70" />
    </svg>
  );
}

/** Text with `code` spans, as the server and helpers write commands. */
export function WithCode({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string never reorder.
        i % 2 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>,
      )}
    </>
  );
}
