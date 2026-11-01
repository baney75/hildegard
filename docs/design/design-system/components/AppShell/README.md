The app shell is one markup that becomes sidebar, rail or tab bar by window class.

- `.hg-app` contains `hg-app__nav`, `hg-app__top`, `hg-app__main`, `hg-app__aside`, `hg-tabbar`. Call `Hildegard.watch(app)`; it sets `data-wc` to compact, medium, expanded or wide from the space available.
- Wide (1280+) docks the inspector; expanded shows the labelled sidebar; medium shows the rail; compact hides both and shows the tab bar with safe-area padding.
- Consumer provides nav items (max five in the tab bar; the rest go under More), page title, main content and inspector content.
- Never branch on device or user agent; never hide features on phones, only re-place them.
