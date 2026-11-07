// SPDX-License-Identifier: AGPL-3.0-only
//! Sites in their own windows: X, Instagram, TikTok, Facebook, Threads, Reddit, LinkedIn and YouTube, and any site the
//! person adds. Each opens in a window of its own with a profile of its own (cookies, storage, sign-in), where the only
//! pages it may show are that site's own and the few its sign-in uses. Everything else goes to the system browser.
//!
//! What a site window does not have, on purpose: a capability (no page in it can call the app), an initialization
//! script, or a user agent other than the webview's own. Google does not allow signing in inside an embedded window, so
//! a Google sign-in page is never shown here: the person is offered their browser instead.
//!
//! This file is the decisions, with no window in them, so they can be tested: which pages belong to a site, where a
//! profile lives, and what a link from the Studio opens.

use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use tauri::Url;

/// presets/post-sites.json: the same file the server and the Studio read.
const CATALOG: &str = include_str!("../../../../presets/post-sites.json");

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum OpensIn {
  /// A link from the Studio opens the site's window.
  App,
  /// The site doesn't allow signing in inside an app, so a link from the Studio opens the system browser.
  Browser,
}

#[derive(Clone, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Site {
  pub id: String,
  pub name: String,
  pub home: String,
  pub post: String,
  /// The site's own domains, and every subdomain of them.
  pub domains: Vec<String>,
  /// Domains its sign-in uses besides its own.
  pub auth: Vec<String>,
  pub opens_in: OpensIn,
}

#[derive(Deserialize)]
struct Catalog {
  sites: Vec<Site>,
}

/// The sites Hildegard knows.
pub fn catalog() -> Vec<Site> {
  serde_json::from_str::<Catalog>(CATALOG).expect("presets/post-sites.json").sites
}

/// Where the sites the person added are kept: `<data>/browse/sites.json`, written by the server on their word.
pub fn custom_file(data: &Path) -> PathBuf {
  data.join("browse").join("sites.json")
}

/// A site the person added, from a name and an address. The address is https, on a real host (a name with a dot,
/// never an IP address or `localhost`), with no login in it. The site owns that host and its subdomains, and `www.`
/// is not counted: adding www.example.com covers example.com.
pub fn custom_site(id: &str, name: &str, url: &str) -> Option<Site> {
  let ok_id = !id.is_empty()
    && id.len() <= 24
    && id.starts_with("c-")
    && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
  let name = name.trim();
  if !ok_id || name.is_empty() || name.chars().count() > 40 || url.len() > 500 {
    return None;
  }
  let u = Url::parse(url).ok()?;
  if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
    return None;
  }
  // `domain()` is only a name: an IPv4 or IPv6 address is not a site.
  let host = u.domain()?.to_ascii_lowercase();
  if !host.contains('.') || host.ends_with('.') {
    return None;
  }
  let own = host.strip_prefix("www.").unwrap_or(&host).to_owned();
  if own.rsplit('.').next().is_some_and(|tld| tld == "local" || tld == "localhost" || tld == "internal") {
    return None;
  }
  Some(Site {
    id: id.to_owned(),
    name: name.to_owned(),
    home: u.to_string(),
    post: u.to_string(),
    domains: vec![own],
    auth: vec![],
    opens_in: OpensIn::App,
  })
}

#[derive(Deserialize)]
struct CustomFile {
  sites: Vec<CustomEntry>,
}

#[derive(Deserialize)]
struct CustomEntry {
  id: String,
  name: String,
  url: String,
}

/// The sites the person added. An entry that doesn't pass `custom_site` is dropped, as is one that repeats an id.
pub fn custom_sites(data: &Path) -> Vec<Site> {
  let Ok(text) = std::fs::read_to_string(custom_file(data)) else { return vec![] };
  let Ok(file) = serde_json::from_str::<CustomFile>(&text) else { return vec![] };
  let mut seen = std::collections::HashSet::new();
  file.sites.iter().filter_map(|e| custom_site(&e.id, &e.name, &e.url)).filter(|s| seen.insert(s.id.clone())).collect()
}

/// The built-in sites, then the person's own.
pub fn all_sites(data: &Path) -> Vec<Site> {
  let mut all = catalog();
  all.extend(custom_sites(data));
  all
}

/// `host` is `domain` or one of its subdomains.
pub fn host_matches(host: &str, domain: &str) -> bool {
  host == domain
    || (host.len() > domain.len() && host.ends_with(domain) && host.as_bytes()[host.len() - domain.len() - 1] == b'.')
}

fn host_in(host: &str, domains: &[String]) -> bool {
  domains.iter().any(|d| host_matches(host, d))
}

/// Google's sign-in pages: `accounts.google.com`, and its country forms (`accounts.google.co.uk`). Google forbids
/// signing in there from an embedded window, so these are never loaded in one.
/// https://developers.google.com/identity/protocols/oauth2/policies#browsers
pub fn is_google_sign_in(url: &Url) -> bool {
  let Some(host) = url.host_str() else { return false };
  let labels: Vec<&str> = host.split('.').collect();
  // accounts.google + the end of Google's own name: com, a country (de), or a second-level one (co.uk, com.au). The
  // whole host has to match: accounts.google.com.evil.example is somebody else's.
  let country = |l: &str| l.len() == 2 && l.bytes().all(|b| b.is_ascii_lowercase());
  match labels.as_slice() {
    ["accounts", "google", "com"] => true,
    ["accounts", "google", cc] => country(cc),
    ["accounts", "google", "co" | "com", cc] => country(cc),
    _ => false,
  }
}

/// What a site's window does with a page it is about to show.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
  /// Show it here.
  Allow,
  /// Not this site's: the system browser opens it, and the window stays where it was.
  System,
  /// A Google sign-in page: not shown. The person is offered their browser, with the caption and file at hand.
  GoogleSignIn,
  /// Nothing opens it: a scheme that would run something here, or no address at all.
  Block,
}

/// Where `url` goes when the window for `site` meets it as a navigation or as a link to a new window.
pub fn route(site: &Site, url: &Url) -> Route {
  match url.scheme() {
    "https" => {}
    // What a page makes for a download or a preview of its own; it counts as the page that made it.
    "blob" => {
      return match Url::parse(url.path()) {
        Ok(inner) if inner.scheme() == "https" => match route(site, &inner) {
          Route::Allow => Route::Allow,
          _ => Route::Block,
        },
        _ => Route::Block,
      }
    }
    "about" => return if url.as_str() == "about:blank" { Route::Allow } else { Route::Block },
    // A plain http or mail link is for the system, as it is from the main window.
    "http" | "mailto" => return Route::System,
    _ => return Route::Block,
  }
  let Some(host) = url.host_str() else { return Route::Block };
  if is_google_sign_in(url) {
    return Route::GoogleSignIn;
  }
  // The default port only: another port on a site's name is not the site.
  let on_site = url.port().is_none() && (host_in(host, &site.domains) || host_in(host, &site.auth));
  if on_site {
    Route::Allow
  } else {
    Route::System
  }
}

/// What a link from the Studio's own window means for the sites: the site it belongs to, when that site opens in the
/// app and the address is one its window would show. Anything else is left to the system browser.
pub fn studio_link<'a>(url: &Url, sites: &'a [Site]) -> Option<&'a Site> {
  if url.scheme() != "https" {
    return None;
  }
  let host = url.host_str()?;
  let site = sites.iter().find(|s| host_in(host, &s.domains))?;
  (site.opens_in == OpensIn::App && route(site, url) == Route::Allow).then_some(site)
}

/// A site's window label.
pub fn window_label(id: &str) -> String {
  format!("site-{id}")
}

/// A site's profile: where its cookies and storage live, under Hildegard's own folder and nowhere else.
pub fn profile_dir(data: &Path, id: &str) -> Option<PathBuf> {
  // The id comes from a catalog or a validated custom entry; check once more that it can only name one folder.
  let single = Path::new(id).components().count() == 1
    && Path::new(id).components().all(|c| matches!(c, Component::Normal(_)))
    && !id.contains(['/', '\\']);
  single.then(|| data.join("browse").join(id))
}

/// The profile folder, made, and closed to everyone but this user where the system has that idea.
pub fn ensure_profile(data: &Path, id: &str) -> std::io::Result<PathBuf> {
  let dir = profile_dir(data, id).ok_or_else(|| std::io::Error::other("not a site"))?;
  std::fs::create_dir_all(&dir)?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    for d in [dir.parent().unwrap_or(&dir), &dir] {
      std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700))?;
    }
  }
  Ok(dir)
}

/// The data store id for macOS 14 and later, which has no data directory: 16 bytes from the site's id, the same every
/// time, so a site keeps its sign-in between launches. (FNV-1a over 128 bits; nothing secret hangs on it.)
#[cfg_attr(not(target_vendor = "apple"), allow(dead_code))]
pub fn store_id(id: &str) -> [u8; 16] {
  const OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
  const PRIME: u128 = 0x0000000001000000000000000000013b;
  let mut h = OFFSET;
  for b in format!("io.github.baney75.hildegard.browse/{id}").bytes() {
    h ^= u128::from(b);
    h = h.wrapping_mul(PRIME);
  }
  h.to_be_bytes()
}

/// Hildegard's "Ready to post" folder, where the files for each platform are made.
pub fn ready_dir(data: &Path) -> PathBuf {
  data.join("Ready to post")
}

/// `path`, if it is a file inside the "Ready to post" folder with no way out of it.
pub fn inside_ready(data: &Path, path: &str) -> Option<PathBuf> {
  let p = PathBuf::from(path);
  let ready = ready_dir(data);
  (p.is_absolute() && p.starts_with(&ready) && !p.components().any(|c| matches!(c, Component::ParentDir))).then_some(p)
}

/// Whether this macOS keeps a site's cookies apart from the others': 14 and later does. Older ones share one store.
pub fn separate_stores(macos_major: u32) -> bool {
  macos_major >= 14
}

#[cfg(test)]
mod tests {
  use super::*;

  fn u(s: &str) -> Url {
    Url::parse(s).unwrap()
  }

  fn site(id: &str) -> Site {
    catalog().into_iter().find(|s| s.id == id).unwrap()
  }

  #[test]
  fn the_catalog_has_every_site_once() {
    let ids: Vec<_> = catalog().into_iter().map(|s| s.id).collect();
    for want in ["x", "youtube", "instagram", "tiktok", "facebook", "threads", "reddit", "linkedin"] {
      assert_eq!(ids.iter().filter(|i| *i == want).count(), 1, "{want}");
    }
    // Every page the catalog sends people to is one its own window would show.
    for s in catalog() {
      assert_eq!(route(&s, &u(&s.home)), Route::Allow, "{} home", s.id);
      assert_eq!(route(&s, &u(&s.post)), Route::Allow, "{} post", s.id);
    }
  }

  #[test]
  fn a_site_shows_its_own_domains_and_subdomains() {
    let x = site("x");
    assert_eq!(route(&x, &u("https://x.com/home")), Route::Allow);
    assert_eq!(route(&x, &u("https://mobile.x.com/i/flow/login")), Route::Allow);
    assert_eq!(route(&x, &u("https://pbs.twimg.com/media/a.jpg")), Route::Allow);
    // Look-alikes and other people's sites are not the site.
    for other in [
      "https://notx.com/",
      "https://x.com.evil.example/",
      "https://evil.example/x.com",
      "https://evil.example/?u=https://x.com",
      "https://x.com@evil.example/",
      "https://xx.com/",
    ] {
      assert_eq!(route(&x, &u(other)), Route::System, "{other}");
    }
    // Another port is not the site's server.
    assert_eq!(route(&x, &u("https://x.com:8443/")), Route::System);
  }

  #[test]
  fn sign_in_domains_belong_to_the_site_that_names_them() {
    assert_eq!(route(&site("instagram"), &u("https://www.facebook.com/login.php")), Route::Allow);
    assert_eq!(route(&site("threads"), &u("https://www.instagram.com/accounts/login/")), Route::Allow);
    assert_eq!(route(&site("tiktok"), &u("https://appleid.apple.com/auth/authorize")), Route::Allow);
    // X's sign-in doesn't use Facebook.
    assert_eq!(route(&site("x"), &u("https://www.facebook.com/login.php")), Route::System);
    // A site's auth domains are not a way to treat it as that other site.
    assert!(studio_link(&u("https://appleid.apple.com/"), &catalog()).is_none());
  }

  #[test]
  fn other_schemes_never_open_a_page_here() {
    let x = site("x");
    for blocked in [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "tauri://localhost/index.html",
      "data:text/html,hi",
      "fb://profile",
      "ftp://x.com/",
      "smb://x.com/share",
      "view-source:https://x.com/",
    ] {
      assert_eq!(route(&x, &u(blocked)), Route::Block, "{blocked}");
    }
    // Plain http and mail go to the system, which upgrades or composes them.
    assert_eq!(route(&x, &u("http://x.com/")), Route::System);
    assert_eq!(route(&x, &u("mailto:someone@example.com")), Route::System);
    assert_eq!(route(&x, &u("about:blank")), Route::Allow);
    assert_eq!(route(&x, &u("about:srcdoc")), Route::Block);
  }

  #[test]
  fn a_blob_counts_as_the_page_that_made_it() {
    let x = site("x");
    assert_eq!(route(&x, &u("blob:https://x.com/6f1c2d3e-0000-4000-8000-000000000000")), Route::Allow);
    assert_eq!(route(&x, &u("blob:https://evil.example/6f1c2d3e-0000-4000-8000-000000000000")), Route::Block);
    assert_eq!(route(&x, &u("blob:null/abc")), Route::Block);
  }

  #[test]
  fn google_sign_in_is_never_shown_and_is_offered_the_browser() {
    for g in [
      "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fwww.youtube.com%2F",
      "https://accounts.google.com/ServiceLogin",
      "https://accounts.google.co.uk/signin",
      "https://accounts.google.de/signin",
      "https://accounts.google.com.au/signin",
    ] {
      assert!(is_google_sign_in(&u(g)), "{g}");
      assert_eq!(route(&site("youtube"), &u(g)), Route::GoogleSignIn, "{g}");
      // On any site: Reddit's "Continue with Google" is the same page.
      assert_eq!(route(&site("reddit"), &u(g)), Route::GoogleSignIn, "{g}");
    }
    for fine in [
      "https://www.youtube.com/",
      "https://google.com/",
      "https://notaccounts.google.com.evil.example/",
      "https://evilaccounts.google.com/",
      "https://myaccounts.google.com/",
      "https://accounts.google.com.evil.example/",
      "https://accounts.google.example/",
      "https://x.com/accounts.google.com",
    ] {
      assert!(!is_google_sign_in(&u(fine)), "{fine}");
    }
    // A page that only looks like it is somebody else's, and goes to the system browser like any other.
    assert_eq!(route(&site("youtube"), &u("https://accounts.google.com.evil.example/")), Route::System);
  }

  #[test]
  fn the_studio_opens_a_site_for_its_own_addresses_and_youtube_in_the_browser() {
    let sites = catalog();
    for (url, id) in [
      ("https://x.com/compose/post", "x"),
      ("https://www.tiktok.com/upload", "tiktok"),
      ("https://www.reddit.com/submit", "reddit"),
      ("https://www.instagram.com/", "instagram"),
    ] {
      assert_eq!(studio_link(&u(url), &sites).map(|s| s.id.as_str()), Some(id), "{url}");
    }
    // YouTube doesn't allow signing in inside an app: the Studio's link goes to the browser.
    assert!(studio_link(&u("https://www.youtube.com/upload"), &sites).is_none());
    // Other people's addresses, plain http and everything else too.
    for no in ["https://example.com/", "http://x.com/", "mailto:a@b.example", "https://x.com:444/"] {
      assert!(studio_link(&u(no), &sites).is_none(), "{no}");
    }
  }

  #[test]
  fn an_added_site_is_https_on_a_real_host_and_owns_only_that_host() {
    let s = custom_site("c-1a2b3c4d", "Bluesky", "https://bsky.app/").unwrap();
    assert_eq!(s.domains, vec!["bsky.app".to_owned()]);
    assert_eq!(route(&s, &u("https://bsky.app/profile/x")), Route::Allow);
    assert_eq!(route(&s, &u("https://cdn.bsky.app/img")), Route::Allow);
    assert_eq!(route(&s, &u("https://evil.example/")), Route::System);
    // www. is the site's own front door, not a separate site.
    let w = custom_site("c-1", "Example", "https://www.example.com/start").unwrap();
    assert_eq!(w.domains, vec!["example.com".to_owned()]);
    assert_eq!(route(&w, &u("https://example.com/")), Route::Allow);
    for (id, url) in [
      ("c-1", "http://example.com/"),
      ("c-1", "https://localhost/"),
      ("c-1", "https://127.0.0.1/"),
      ("c-1", "https://[::1]/"),
      ("c-1", "https://192.168.1.10/"),
      ("c-1", "https://intranet/"),
      ("c-1", "https://printer.local/"),
      ("c-1", "https://user:pw@example.com/"),
      ("c-1", "https://example.com:8443/"),
      ("c-1", "file:///etc/passwd"),
      ("c-1", "not a url"),
      ("x", "https://example.com/"),
      ("c-../evil", "https://example.com/"),
      ("c-A", "https://example.com/"),
    ] {
      assert!(custom_site(id, "Name", url).is_none(), "{id} {url}");
    }
    assert!(custom_site("c-1", "  ", "https://example.com/").is_none());
  }

  #[test]
  fn the_added_sites_file_is_read_with_the_same_checks() {
    let dir = std::env::temp_dir().join(format!("hg-browse-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("browse")).unwrap();
    std::fs::write(
      custom_file(&dir),
      r#"{"sites":[
        {"id":"c-aaaa","name":"Bluesky","url":"https://bsky.app/"},
        {"id":"c-aaaa","name":"Again","url":"https://bsky.app/"},
        {"id":"c-bad","name":"Local","url":"https://localhost/"},
        {"id":"x","name":"Impostor","url":"https://example.com/"}
      ]}"#,
    )
    .unwrap();
    let ids: Vec<_> = custom_sites(&dir).into_iter().map(|s| s.id).collect();
    assert_eq!(ids, vec!["c-aaaa".to_owned()]);
    assert_eq!(all_sites(&dir).len(), catalog().len() + 1);
    assert!(custom_sites(Path::new("/nonexistent-hildegard")).is_empty());
    std::fs::write(custom_file(&dir), "not json").unwrap();
    assert!(custom_sites(&dir).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn every_site_has_its_own_profile_folder_inside_hildegards() {
    let data = Path::new("/data/hildegard");
    assert_eq!(profile_dir(data, "x").unwrap(), data.join("browse").join("x"));
    assert_ne!(profile_dir(data, "x"), profile_dir(data, "tiktok"));
    for bad in ["", "..", ".", "../x", "x/y", "x\\y", "/etc"] {
      assert!(profile_dir(data, bad).is_none(), "{bad:?}");
    }
    let ids: std::collections::HashSet<_> = catalog().iter().map(|s| store_id(&s.id)).collect();
    assert_eq!(ids.len(), catalog().len());
    // The same site gets the same store every launch, so it stays signed in.
    assert_eq!(store_id("x"), store_id("x"));
    assert_ne!(store_id("x"), [0u8; 16]);
  }

  #[cfg(unix)]
  #[test]
  fn a_profile_folder_is_made_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("hg-profile-{}", std::process::id()));
    let p = ensure_profile(&dir, "x").unwrap();
    assert_eq!(p, dir.join("browse").join("x"));
    assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(std::fs::metadata(p.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    assert!(ensure_profile(&dir, "../x").is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn only_a_file_in_the_ready_folder_is_shown_from_the_server_s_word() {
    let data = Path::new("/data/hildegard");
    let ok = "/data/hildegard/Ready to post/heron-abc123/heron-x.mp4";
    assert_eq!(inside_ready(data, ok), Some(PathBuf::from(ok)));
    for no in [
      "/data/hildegard/Ready to post/../state.json",
      "/data/hildegard/browse/x/Cookies",
      "/etc/passwd",
      "Ready to post/a.mp4",
      "/data/hildegard/Ready to post2/a.mp4",
      "",
    ] {
      assert_eq!(inside_ready(data, no), None, "{no}");
    }
  }

  #[test]
  fn macos_before_14_shares_one_cookie_store() {
    assert!(!separate_stores(11));
    assert!(!separate_stores(13));
    assert!(separate_stores(14));
    assert!(separate_stores(26));
  }
}
