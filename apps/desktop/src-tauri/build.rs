// SPDX-License-Identifier: AGPL-3.0-only
// The app's own commands need a permission like any plugin's, so only the start-up page (capabilities/main.json)
// can call them; the Studio, loaded from Hildegard's server, can't call anything.
fn main() {
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
    "launch",
    "install",
    "open_logs",
  ])))
  .expect("the Tauri build step");
}
