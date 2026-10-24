// SPDX-License-Identifier: AGPL-3.0-only
//! Where the app window may go: its own start-up page, and the Studio on 127.0.0.1 at Hildegard's port. Every other
//! link opens in the system browser instead, and the window stays where it was.

use tauri::Url;

/// The app's own pages: `tauri://localhost` on macOS and Linux, `http://tauri.localhost` on Windows.
pub fn is_app_page(url: &Url) -> bool {
  match url.scheme() {
    "tauri" => url.host_str() == Some("localhost"),
    "http" | "https" => url.host_str() == Some("tauri.localhost"),
    _ => false,
  }
}

/// The Studio, served by Hildegard on this computer at this port.
pub fn is_studio(url: &Url, port: u16) -> bool {
  url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(port)
}

pub fn allowed_in_window(url: &Url, port: u16) -> bool {
  is_app_page(url) || is_studio(url, port)
}

/// Links worth handing to the system: web pages and email. Nothing that would run something on this computer.
pub fn opens_outside(url: &Url) -> bool {
  matches!(url.scheme(), "http" | "https" | "mailto")
}

/// One of the app's own pages, by path: `index.html#stopped`, say.
pub fn app_page(path: &str) -> Url {
  let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
  Url::parse(base).and_then(|b| b.join(path)).expect("a page of the app")
}

#[cfg(test)]
mod tests {
  use super::*;

  fn u(s: &str) -> Url {
    Url::parse(s).unwrap()
  }

  #[test]
  fn the_window_shows_the_app_and_the_studio_and_nothing_else() {
    assert!(allowed_in_window(&u("tauri://localhost/index.html"), 7341));
    assert!(allowed_in_window(&u("http://tauri.localhost/index.html#stopped"), 7341));
    assert!(allowed_in_window(&u("http://127.0.0.1:7341/#/settings/sharing"), 7341));
    // Another port is someone else's server; localhost could be rebound; https isn't how Hildegard serves here.
    assert!(!allowed_in_window(&u("http://127.0.0.1:8188/"), 7341));
    assert!(!allowed_in_window(&u("http://localhost:7341/"), 7341));
    assert!(!allowed_in_window(&u("https://127.0.0.1:7341/"), 7341));
    assert!(!allowed_in_window(&u("https://huggingface.co/oauth/authorize?x=1"), 7341));
    assert!(!allowed_in_window(&u("tauri://evil.example/"), 7341));
    assert!(!allowed_in_window(&u("file:///etc/passwd"), 7341));
    assert!(!allowed_in_window(&u("about:blank"), 7341));
  }

  #[test]
  fn only_web_pages_and_email_open_outside() {
    assert!(opens_outside(&u("https://huggingface.co/Lightricks")));
    assert!(opens_outside(&u("mailto:someone@example.com")));
    assert!(!opens_outside(&u("file:///Applications/Calculator.app")));
    assert!(!opens_outside(&u("javascript:alert(1)")));
    assert!(!opens_outside(&u("smb://server/share")));
  }

  #[test]
  fn app_pages_are_the_apps_own() {
    assert!(is_app_page(&app_page("index.html#stopped")));
    assert_eq!(app_page("index.html#stopped").fragment(), Some("stopped"));
  }
}
