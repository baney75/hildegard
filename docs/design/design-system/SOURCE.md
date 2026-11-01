# Hildegard design system (snapshot)

Copied 2026-10-16 from Donovan's Claude Design system artifact: https://claude.ai/artifact/FmXD11DFRiM1PXneDpHXWf
(made from design/hildegard-claude-design-prompt.md). The artifact is the live source; this folder is a snapshot for threads and the repo.

- README.md: brand book (voice, palette meanings, type, layout window classes, icons, logo rules, accessibility)
- tokens.json: colour (dark default + light), type, spacing, radius, shadow, breakpoints, targets
- components/: bundle.css + bundle.js (window.Hildegard: icons, watch(), setLayout()), index.d.ts, per-component README + preview.html
- fonts/: Cormorant Garamond, Source Sans 3, DM Mono, Uncial Antiqua (woff2, all OFL)
- assets/Logos, assets/App icons: SVGs of the burning-egg mark, wordmark, lockups, every platform icon, tray, favicon
- logo-preview.png: quick render of the mark, lockups and app icons

Covered vs the prompt: logo system, visual system, adaptive app shell (Studio at desktop/iPad/phone), components for
prompt bar, chips, buttons, status, rings, job row + Force now dialog, device card + Choir orbit, cost strip, tray popover, layout switch.
Not yet designed: Create Music/Voice/Video flows, full Choir/Queue/Models/Costs/Onboarding/Device settings screens,
mobile Connect/Library/Settings, widgets, Live Activity.
