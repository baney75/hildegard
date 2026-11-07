// SPDX-License-Identifier: AGPL-3.0-only
//! The camera and microphone for the Studio in the window, so Record works there. The Studio asks the way any web page
//! does (`getUserMedia`, when a person taps Record); the system then asks them on its own: macOS from the usage strings
//! in Info.plist, Windows from its privacy settings, Linux from the desktop's portal. Only the Studio, served by
//! Hildegard at 127.0.0.1 on its own port, may use them; the app's own pages and everything else are refused.

use tauri::Url;

use crate::nav;

/// Whether this page may use the camera and microphone.
pub fn may_capture(url: &Url, port: u16) -> bool {
  nav::is_studio(url, port)
}

/// WebKitGTK ships with MediaStream off, so `navigator.mediaDevices` doesn't exist until it is switched on.
#[cfg(target_os = "linux")]
pub fn enable_media_stream(window: &tauri::WebviewWindow) {
  let _ = window.with_webview(|webview| {
    use webkit2gtk::{SettingsExt, WebViewExt};
    if let Some(settings) = webview.inner().settings() {
      settings.set_enable_media_stream(true);
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  fn u(s: &str) -> Url {
    Url::parse(s).unwrap()
  }

  #[test]
  fn only_the_studio_on_this_computers_port_may_record() {
    assert!(may_capture(&u("http://127.0.0.1:7341/#/voice"), 7341));
    // The app's own pages, another port, another host, and a page that only looks like the Studio.
    assert!(!may_capture(&u("tauri://localhost/index.html"), 7341));
    assert!(!may_capture(&u("http://tauri.localhost/index.html"), 7341));
    assert!(!may_capture(&u("http://127.0.0.1:8188/"), 7341));
    assert!(!may_capture(&u("http://localhost:7341/"), 7341));
    assert!(!may_capture(&u("https://127.0.0.1:7341/"), 7341));
    assert!(!may_capture(&u("https://example.com/"), 7341));
    assert!(!may_capture(&u("about:blank"), 7341));
  }
}
