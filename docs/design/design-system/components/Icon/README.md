Icons are drawn on a 24px grid at 1.5px stroke with round caps, in `currentColor`.

- Render with `Hildegard.icon(name, size, label?)` or `<i data-icon="name" data-size="20">` then `Hildegard.hydrate()`.
- At 16px and below the stroke thickens to 2px automatically.
- Pass a label only when the icon stands alone; otherwise it is hidden from assistive tech.
