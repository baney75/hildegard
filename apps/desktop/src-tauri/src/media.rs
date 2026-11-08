// SPDX-License-Identifier: AGPL-3.0-only
//! The camera and microphone for the Studio in the window, so Record works there. The Studio asks the way any web page
//! does (`getUserMedia`, when a person taps Record); the system then asks them on its own: macOS from the usage strings
//! in Info.plist, Windows from its privacy settings, Linux from the desktop's portal. Only the Studio, served by
//! Hildegard at 127.0.0.1 on its own port, may use them; the app's own pages and everything else are refused.
//!
//! Sharing the screen (`getDisplayMedia`, for Record's Screen sources) differs by system, and the Studio looks for it
//! itself, hiding the Screen sources with a one-line reason where it is missing:
//!  - Linux, WebKitGTK: a screen share asks this handler as `DisplayCapture`, granted to the Studio like the camera; the
//!    desktop portal then shows its own picker. MediaStream must be on (below).
//!  - Windows, WebView2: `getDisplayMedia` works and shows WebView2's own picker; it never asks this handler.
//!  - macOS, WKWebView: WebKit gives an app's web view no `getDisplayMedia` (WKMediaCaptureType has only the camera and
//!    microphone), so there is nothing to grant, and the Studio says to open it in a browser to record the screen.

use tauri::Url;

use crate::nav;

/// Whether a request for the camera or microphone may be granted. `top` is the window's page; `frame` is the page of
/// the frame that asked, when the runtime says which. Both must be the Studio: a cross-origin frame inside the Studio
/// is judged as itself, never as the Studio around it. Tauri 2.12 hands its permission handler the kind of permission
/// and nothing else, so `lib.rs` passes `None` and the Studio's `Permissions-Policy` header (`camera=(self),
/// microphone=(self)`, from the server) is what keeps other frames from asking; this function is ready for a runtime
/// that names the frame.
pub fn may_capture(top: &Url, frame: Option<&Url>, port: u16) -> bool {
  nav::is_studio(top, port) && frame.is_none_or(|f| nav::is_studio(f, port))
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
    assert!(may_capture(&u("http://127.0.0.1:7341/#/voice"), None, 7341));
    // The app's own pages, another port, another host, and a page that only looks like the Studio.
    assert!(!may_capture(&u("tauri://localhost/index.html"), None, 7341));
    assert!(!may_capture(&u("http://tauri.localhost/index.html"), None, 7341));
    assert!(!may_capture(&u("http://127.0.0.1:8188/"), None, 7341));
    assert!(!may_capture(&u("http://localhost:7341/"), None, 7341));
    assert!(!may_capture(&u("https://127.0.0.1:7341/"), None, 7341));
    assert!(!may_capture(&u("https://example.com/"), None, 7341));
    assert!(!may_capture(&u("about:blank"), None, 7341));
  }

  #[test]
  fn a_cross_origin_frame_inside_the_studio_is_judged_as_itself() {
    let studio = u("http://127.0.0.1:7341/#/sites");
    // The Studio's own frame may; a frame from another origin may not, though the window shows the Studio.
    assert!(may_capture(&studio, Some(&u("http://127.0.0.1:7341/preview/x/")), 7341));
    assert!(!may_capture(&studio, Some(&u("https://example.com/embed")), 7341));
    assert!(!may_capture(&studio, Some(&u("http://127.0.0.1:8188/")), 7341));
    assert!(!may_capture(&studio, Some(&u("about:srcdoc")), 7341));
    // And a Studio frame inside some other top-level page may not either.
    assert!(!may_capture(&u("https://example.com/"), Some(&studio), 7341));
  }
}
