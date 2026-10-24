// SPDX-License-Identifier: AGPL-3.0-only
//! Updates to the app itself. It asks the latest release for a newer app, signed with Hildegard's key and built for
//! this kind of install, downloads it in the background, and offers it in the tray. Nothing installs until that's
//! chosen. A .deb belongs to the system's package manager, so it is never offered one.

use std::sync::Mutex;

use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

struct Ready {
  update: Update,
  bytes: Vec<u8>,
}

/// The update downloaded and waiting for a restart, if there is one.
#[derive(Default)]
pub struct Pending(Mutex<Option<Ready>>);

/// Whether this install updates itself: the macOS app, the AppImage, and the Windows installers.
pub fn updatable() -> bool {
  matches!(bundle_type(), Some(BundleType::App | BundleType::AppImage | BundleType::Nsis | BundleType::Msi))
}

/// Downloads a newer app, once. Returns its version when one is now ready to install.
pub async fn fetch(app: &AppHandle) -> Result<Option<String>, String> {
  if app.state::<Pending>().0.lock().unwrap().is_some() {
    return Ok(None);
  }
  let updater = app.updater().map_err(|e| e.to_string())?;
  let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
    return Ok(None);
  };
  let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
  let version = update.version.clone();
  *app.state::<Pending>().0.lock().unwrap() = Some(Ready { update, bytes });
  Ok(Some(version))
}

/// Installs the downloaded app. On Windows the installer takes over and this process ends; elsewhere the caller
/// restarts into the new app.
pub fn install(app: &AppHandle) -> Result<(), String> {
  let ready = app.state::<Pending>().0.lock().unwrap().take().ok_or("No update is downloaded.")?;
  ready.update.install(&ready.bytes).map_err(|e| e.to_string())
}
