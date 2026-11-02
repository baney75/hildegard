// SPDX-License-Identifier: AGPL-3.0-only
// Runs in <head> before anything paints (vite.config.ts bundles it to /theme-init.js), so a light or custom look
// never flashes dark. The Studio applies the same look again when it starts.
import { applyTheme } from './lib/theme-core.ts';

applyTheme();
