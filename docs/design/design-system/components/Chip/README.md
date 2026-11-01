Chips pick a modality or filter; segmented controls pick one of a few options.

- `hg-chip` with `aria-pressed` in a `role="group"`. The selected chip fills with `brand`.
- Modality order is fixed: Transcribe, Label, Image, Voice, Music, Video, 3D, each with its icon.
- On compact windows wrap chips in `hg-scroll-x` so they scroll sideways instead of wrapping into three rows.
- `hg-seg` holds 2–5 `button`s with `role="radio"` + `aria-checked` or `role="tab"` + `aria-selected`.
- Consumer provides labels and selection state; one chip is always selected in the prompt bar.
