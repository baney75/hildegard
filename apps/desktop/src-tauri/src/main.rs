// SPDX-License-Identifier: AGPL-3.0-only
// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  hildegard_desktop::run()
}
