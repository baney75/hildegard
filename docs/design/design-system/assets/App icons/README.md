App icons for every platform, all built from the same mark on a viriditas ground.

- `appicon-macos.svg`: 1024 canvas, 824 body with continuous corners and drop shadow (Apple grid). Export to `.icns`.
- `appicon-ios.svg`: full-bleed 1024 square, no transparency; iOS and iPadOS apply the mask.
- `appicon-android-foreground.svg` + `appicon-android-background.svg`: adaptive icon layers at 108dp (432px); the mark sits inside the 66dp safe zone. `appicon-android-monochrome.svg` is the themed-icon layer (Android 13+).
- `appicon-windows.svg`: 256 plate; export to `.ico` at 16, 24, 32, 48, 256.
- `appicon-linux-flat.svg` (any icon theme, Omarchy launcher) and `appicon-linux-symbolic.svg` (16px symbolic, black).
- `tray-template.svg`: macOS menu bar template (black + alpha). `tray-light.svg`: Windows and Linux trays on dark bars.
- `favicon.svg`: switches between green and vellum with the browser's colour scheme.
