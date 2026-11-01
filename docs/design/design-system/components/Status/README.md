Status shows the state of a job or device with a glyph and a word, never colour alone.

- `hg-status--running` (gold, spinning ring), `--queued` (sapphire, hollow ring), `--idle` (silver-grey, dash), `--done` (green, check), `--error` (burgundy, triangle).
- Device modes: `hg-status--server` (solid square), `--opportunistic` (half-filled ring).
- `hg-dots` summarises the Choir in a strip: `i.on` running, `i.q` queued, plain idle. Give the group an `aria-label` with the counts.
- The text is the consumer's: keep it to a few words ("Queued · 3rd", "Out of memory on Studio Mac").
