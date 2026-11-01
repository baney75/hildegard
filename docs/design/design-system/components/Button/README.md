Buttons start or confirm one action; `hg-btn` plus one variant.

- `hg-btn--primary` (viriditas): the one main action per view, such as Create, Continue or Add a device.
- Default (no variant): secondary actions. `hg-btn--ghost`: tertiary and toolbar actions.
- `hg-btn--sapphire`: navigation to knowledge or another place ("Open in Choir").
- `hg-btn--force` (ember): **Force now only.** It always opens the confirmation that names what will be interrupted.
- `hg-btn--danger` (outline) asks; `hg-btn--destroy` (burgundy fill) confirms an irreversible delete.
- Sizes: `hg-btn--sm` (32px, pointer-only dense rows), default (36px, raised to 44px on touch), `hg-btn--lg` (48px, onboarding and phone primary actions). `hg-btn--icon` for square icon buttons, which need an `aria-label`. `hg-btn--block` fills its container.
- The consumer provides the label (sentence case, verb first) and an optional leading `<i data-icon>`.
- Don't put two primary buttons side by side, and don't use ember for anything that isn't urgent.
