The layout switch lets a person choose Auto, Desktop, Tablet or Phone layout in any browser.

- Markup: `hg-seg` with `data-hg-layout-switch` and four `[data-mode]` radios. The bundle handles clicks, persists the choice to `hildegard.layout` and updates every `.hg-app`.
- Auto follows the window. Desktop on a phone sets the viewport to 1280px with zoom kept. Tablet and Phone on a wide window centre the app as a framed column.
- Place it in the top bar on expanded and wide windows and under More on compact. Label-only text on wide windows; icon-only with `aria-label`s in tight bars.
- `Hildegard.setLayout(mode)` does the same from code (for a keyboard shortcut or a settings page).
