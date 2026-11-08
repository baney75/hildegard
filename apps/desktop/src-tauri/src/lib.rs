// SPDX-License-Identifier: AGPL-3.0-only
//! The Hildegard app: a native window around the Studio. It finds the Hildegard already running on this computer, or
//! starts one, and shows the Studio from it. Its own start-up page (ui/) does the first-run install. The Studio itself
//! is the server's, at http://127.0.0.1:<port>, and has no access to the app at all.

mod browse;
#[cfg(windows)]
mod frames;
mod install;
mod nav;
mod paths;
mod server;
mod update;

use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::image::Image;
use tauri::ipc::Channel;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::browse::{Route, Site};
use crate::install::{Bundled, Event, Outcome};
use crate::paths::{system_env, Layout, Os};

#[cfg(target_os = "macos")]
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray-template.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray.png");

/// The link that Settings › Sharing turns on, as the tray last saw it.
#[derive(Clone, PartialEq, Debug)]
enum Sharing {
  /// Hildegard isn't answering, or the link was never turned on.
  Off,
  On {
    via: String,
  },
  /// Paused from the tray; resuming turns it on the same way again.
  Paused {
    via: String,
  },
}

struct Hildegard {
  layout: Layout,
  bundled: Bundled,
  /// The port the Studio is shown from: the only server the window may load.
  port: Arc<AtomicU16>,
  /// The server this app started, when it started one itself.
  sidecar: Mutex<Option<Child>>,
  /// This app started the server (itself or through the install), so quitting it stops the server too.
  started_here: AtomicBool,
  installer: Arc<Mutex<Option<Child>>>,
  showing_studio: AtomicBool,
  sharing: Mutex<Sharing>,
  sharing_item: Mutex<Option<MenuItem<Wry>>>,
  /// The tray's menu, which an update ready to install joins.
  menu: Mutex<Option<Menu<Wry>>>,
  /// The Browse menus (the tray's, and the menu bar's on macOS) and the sites they list, for when a site is added.
  browse_menus: Mutex<Vec<Submenu<Wry>>>,
  browse_listed: Mutex<Vec<String>>,
}

fn log(layout: &Layout, line: &str) {
  use std::io::Write;
  let _ = std::fs::create_dir_all(&layout.logs);
  if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(layout.logs.join("app.log")) {
    let _ = writeln!(f, "{line}");
  }
}

/// What the start-up page shows next.
#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum Launch {
  /// The window now shows the Studio.
  Studio,
  /// Hildegard isn't set up here yet. `partly`: the command is here, but `hildegard install` didn't finish.
  Install {
    data: String,
    partly: bool,
  },
  Failed {
    message: String,
    log: String,
  },
}

fn show_window(app: &AppHandle) {
  if let Some(w) = app.get_webview_window("main") {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
  }
}

fn show_studio(app: &AppHandle, port: u16, page: &str) {
  let hg = app.state::<Hildegard>();
  hg.port.store(port, Ordering::SeqCst);
  hg.showing_studio.store(true, Ordering::SeqCst);
  if let (Some(w), Ok(url)) = (app.get_webview_window("main"), Url::parse(&format!("{}/{page}", server::base(port)))) {
    let _ = w.navigate(url);
  }
  refresh_sharing(app);
}

/// Finds Hildegard, or starts it, and shows the Studio. `anyway`: start it even though the install didn't finish.
fn connect(app: &AppHandle, anyway: bool) -> Launch {
  let hg = app.state::<Hildegard>();
  let layout = &hg.layout;
  let mut port = paths::port(&layout.data, &system_env);
  let here = server::who(port, &layout.data);
  if here == server::Here::Ours {
    show_studio(app, port, "");
    return Launch::Studio;
  }
  let has_cli = layout.has_cli();
  if !has_cli || (!anyway && !layout.has_runtime()) {
    return Launch::Install { data: layout.data.display().to_string(), partly: has_cli };
  }
  // After an app update, the command and the server here move to the app's version too.
  if let Err(e) = install::lay_down(&hg.bundled, layout) {
    log(layout, &format!("Couldn’t update Hildegard in its folder: {e}"));
  }
  let failed = |message: String| Launch::Failed { message, log: server::server_log(layout) };
  // Another home's Hildegard, or another program, on the port: this one starts on the next free port, which its
  // server remembers for the CLI and the next launch.
  match server::free_port(port, here == server::Here::Theirs) {
    Some(p) if p != port => {
      log(layout, &format!("Port {port} is taken (another Hildegard home or another program), so Hildegard uses {p}."));
      port = p;
    }
    Some(_) => {}
    None => return failed(format!("Port {port} is taken, and no port near it is free.")),
  }
  let mut child = match server::spawn(layout, port) {
    Ok(c) => c,
    Err(e) => return failed(format!("Hildegard didn’t start: {e}")),
  };
  // The first start after an install can take a while: it checks ComfyUI before it answers.
  match server::wait_up(port, &mut child, Duration::from_secs(90)) {
    Ok(()) => {
      *hg.sidecar.lock().unwrap() = Some(child);
      hg.started_here.store(true, Ordering::SeqCst);
      show_studio(app, port, "");
      Launch::Studio
    }
    Err(why) => {
      let _ = child.kill();
      let _ = child.wait();
      failed(format!("Hildegard didn’t start. {why}"))
    }
  }
}

#[tauri::command]
async fn launch(app: AppHandle, anyway: bool) -> Launch {
  let a = app.clone();
  tauri::async_runtime::spawn_blocking(move || connect(&a, anyway))
    .await
    .unwrap_or_else(|e| Launch::Failed { message: e.to_string(), log: String::new() })
}

/// The first-run install, step by step: the same as the one-line installer, then `hildegard install`.
#[tauri::command]
async fn install(app: AppHandle, cpu: bool, on_event: Channel<Event>) -> Result<Outcome, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let hg = app.state::<Hildegard>();
    for step in install::lay_down(&hg.bundled, &hg.layout)? {
      let _ = on_event.send(Event::Step { step });
    }
    let outcome = install::run(&hg.layout, cpu, &hg.installer, |e| {
      let _ = on_event.send(e);
    })?;
    // The installer starts Hildegard as it finishes; this app started it, so quitting it stops it.
    if server::who(paths::port(&hg.layout.data, &system_env), &hg.layout.data) == server::Here::Ours {
      hg.started_here.store(true, Ordering::SeqCst);
    }
    Ok(outcome)
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_logs(app: AppHandle) -> Result<(), String> {
  let logs = app.state::<Hildegard>().layout.logs.clone();
  std::fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
  app.opener().open_path(logs.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

// ── Sites in their own windows ───────────────────────────────────────────────────────────────────────────────────

/// Opens a page in the system browser. The same page is not opened twice within two seconds, and nothing opens within
/// half a second of the last: a page that opens many popups to outside its site must not stack up browser tabs.
fn open_outside(app: &AppHandle, url: &Url) {
  static LAST: Mutex<Option<(String, Instant)>> = Mutex::new(None);
  if !nav::opens_outside(url) {
    return;
  }
  {
    let mut last = LAST.lock().unwrap();
    if let Some((u, at)) = last.as_ref() {
      if at.elapsed() < Duration::from_millis(500) || (u == url.as_str() && at.elapsed() < Duration::from_secs(2)) {
        return;
      }
    }
    *last = Some((url.to_string(), Instant::now()));
  }
  let _ = app.opener().open_url(url.as_str(), None::<&str>);
}

/// A link in the Studio: the window of the site it belongs to, or else the system browser.
fn link_out(app: &AppHandle, url: &Url) {
  let sites = browse::all_sites(&app.state::<Hildegard>().layout.data);
  match browse::studio_link(url, &sites) {
    Some(site) => open_site(app, site, url),
    None => open_outside(app, url),
  }
}

fn site_by_id(app: &AppHandle, id: &str) -> Option<Site> {
  browse::all_sites(&app.state::<Hildegard>().layout.data).into_iter().find(|s| s.id == id)
}

#[cfg(target_os = "macos")]
fn macos_major() -> u32 {
  std::process::Command::new("sw_vers")
    .arg("-productVersion")
    .output()
    .ok()
    .and_then(|o| String::from_utf8(o.stdout).ok())
    .and_then(|v| v.trim().split('.').next()?.parse().ok())
    .unwrap_or(14)
}

#[cfg(not(target_os = "macos"))]
fn macos_major() -> u32 {
  u32::MAX
}

fn say(app: &AppHandle, title: &str, text: String) {
  app.dialog().message(text).title(title).kind(MessageDialogKind::Info).show(|_| {});
}

/// Shows `site` at `url` in its own window, made if there isn't one. Not on the thread that handles the event: a window
/// built there can lock up on Windows.
fn open_site(app: &AppHandle, site: &Site, url: &Url) {
  let (app, site, url) = (app.clone(), site.clone(), url.clone());
  std::thread::spawn(move || {
    if let Err(e) = build_site(&app, &site, &url) {
      log(&app.state::<Hildegard>().layout, &format!("Couldn’t open {}: {e}", site.name));
    }
  });
}

fn build_site(app: &AppHandle, site: &Site, url: &Url) -> Result<(), String> {
  let label = browse::window_label(&site.id);
  if let Some(w) = app.get_webview_window(&label) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    if w.url().ok().as_ref() != Some(url) {
      let _ = w.navigate(url.clone());
    }
    return Ok(());
  }
  let hg = app.state::<Hildegard>();
  let dir = browse::ensure_profile(&hg.layout.data, &site.id).map_err(|e| e.to_string())?;
  if !browse::separate_stores(macos_major()) {
    static TOLD: AtomicBool = AtomicBool::new(false);
    if !TOLD.swap(true, Ordering::SeqCst) {
      say(
        app,
        "Sites share their sign-ins on this Mac",
        "On macOS 11 to 13, every site you open in Hildegard shares one set of cookies with the others and with the \
         Studio, so signing in to one is visible to the others, and Hildegard can’t sign you out of just one. To sign \
         out, use the site’s own Sign out in its window. macOS 14 and later keeps each site apart."
          .into(),
      );
    }
  }

  // A site's window has no capability, so nothing in it can call the app; it has no initialization script and shows
  // the webview's own user agent. All it can do is show its own pages and frames. On Windows it starts blank and goes
  // to the site once the frame check is in (frames.rs).
  let first = if cfg!(windows) { Url::parse("about:blank").map_err(|e| e.to_string())? } else { url.clone() };
  let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(first))
    .title(site.name.clone())
    .inner_size(1100.0, 800.0)
    .min_inner_size(480.0, 360.0)
    .data_directory(dir)
    // Files dropped on the page (a video for the site's upload box) must reach the page; on Windows the app's own
    // drag-and-drop handler would otherwise take them.
    .disable_drag_drop_handler()
    // The page and, on Linux and macOS, every frame: what isn't the site's is not loaded, and nothing opens outside.
    .on_navigation({
      let site = site.clone();
      move |url| browse::navigates(&site, url)
    })
    .on_new_window({
      let (app, site, label) = (app.clone(), site.clone(), label.clone());
      move |url, _| {
        match browse::route(&site, &url) {
          // A link that wants a new window opens in this one; popups that need their opener are not supported.
          Route::Allow if url.scheme() == "https" => {
            if let Some(w) = app.get_webview_window(&label) {
              let _ = w.navigate(url);
            }
          }
          Route::System => open_outside(&app, &url),
          Route::GoogleSignIn => google_offer(&app, &site),
          Route::Allow | Route::Block => {}
        }
        NewWindowResponse::Deny
      }
    })
    .on_download(downloads);
  #[cfg(target_vendor = "apple")]
  let builder = builder.data_store_identifier(browse::store_id(&site.id));
  #[cfg(not(target_os = "macos"))]
  let builder = builder.menu(site_window_menu(app, site).map_err(|e| e.to_string())?);
  let _window = builder.build().map_err(|e| e.to_string())?;
  #[cfg(windows)]
  if let Err(e) = frames::guard(&_window, site, url) {
    let _ = _window.destroy();
    say(
      app,
      "Update Microsoft Edge WebView2",
      format!(
        "Hildegard didn’t open {} because this computer’s WebView2 can’t keep other sites’ frames out of its window. \
         Updating Microsoft Edge updates WebView2; then try again.",
        site.name
      ),
    );
    return Err(format!("the frame check didn’t start: {e}"));
  }
  Ok(())
}

/// Google doesn't allow signing in from an app's own window, so its sign-in page is never shown. The person is offered
/// their browser: Hildegard copies the caption it prepared, shows the file, and opens the site there.
fn google_offer(app: &AppHandle, site: &Site) {
  static OFFERING: AtomicBool = AtomicBool::new(false);
  if OFFERING.swap(true, Ordering::SeqCst) {
    return;
  }
  let (app2, site2) = (app.clone(), site.clone());
  let name = &site.name;
  app
    .dialog()
    .message(format!(
      "Google doesn’t let apps sign you in inside their own windows, so Hildegard won’t show its sign-in page here.\n\n\
       Open {name} in your browser instead? Hildegard copies your caption and shows your file there, ready to post.\n\n\
       If {name} has its own email or username sign-in, you can use that here."
    ))
    .title("Sign in with your browser")
    .kind(MessageDialogKind::Info)
    .buttons(MessageDialogButtons::OkCancelCustom("Open in your browser".into(), "Not now".into()))
    .show(move |yes| {
      OFFERING.store(false, Ordering::SeqCst);
      if yes {
        handoff(&app2, &site2);
      }
    });
}

/// Takes the person to the site in their own browser, with what Hildegard prepared for it: the caption on the
/// clipboard, the file shown in its folder, and the site's page for posting open.
fn handoff(app: &AppHandle, site: &Site) {
  let (app, site) = (app.clone(), site.clone());
  std::thread::spawn(move || {
    let hg = app.state::<Hildegard>();
    let port = hg.port.load(Ordering::SeqCst);
    if let Ok(latest) = server::get(port, &format!("/api/post/latest/{}", site.id)) {
      if latest["found"].as_bool() == Some(true) {
        if let Some(caption) = latest["caption"].as_str() {
          let _ = app.clipboard().write_text(caption.to_owned());
        }
        // The server names the file; only one in the "Ready to post" folder is shown.
        if let Some(path) = latest["path"].as_str().and_then(|p| browse::inside_ready(&hg.layout.data, p)) {
          let _ = app.opener().reveal_item_in_dir(path);
        }
      }
    }
    let _ = app.opener().open_url(site.post.as_str(), None::<&str>);
  });
}

/// Clears a site's profile: its cookies, storage and sign-in. Its window closes. On macOS 11 to 13 every webview,
/// the Studio's too, keeps its cookies in one store, so there is no one site's to clear: the person is told to sign
/// out on the site itself.
fn sign_out(app: &AppHandle, site: &Site) {
  if !browse::separate_stores(macos_major()) {
    say(app, "Sign out on the site", browse::shared_store_sign_out(&site.name));
    return;
  }
  let (app, site) = (app.clone(), site.clone());
  std::thread::spawn(move || {
    let hg = app.state::<Hildegard>();
    let label = browse::window_label(&site.id);
    if let Some(w) = app.get_webview_window(&label) {
      let _ = w.clear_all_browsing_data();
      let _ = w.destroy();
    } else if cfg!(target_vendor = "apple") {
      // WebKit keeps a site's cookies in its own store, not in a folder to delete: open the store hidden and clear it.
      if let Ok(blank) = Url::parse("about:blank") {
        let hidden = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(blank)).visible(false);
        #[cfg(target_vendor = "apple")]
        let hidden = hidden.data_store_identifier(browse::store_id(&site.id));
        if let Ok(w) = hidden.build() {
          let _ = w.clear_all_browsing_data();
          let _ = w.destroy();
        }
      }
    }
    // Elsewhere the profile is a folder; it can go once nothing holds it open.
    if !cfg!(target_vendor = "apple") {
      std::thread::sleep(Duration::from_secs(1));
      if let Some(dir) = browse::profile_dir(&hg.layout.data, &site.id) {
        let _ = std::fs::remove_dir_all(dir);
      }
    }
    say(
      &app,
      "Signed out",
      format!("You’re signed out of {}. Its cookies and saved data are gone from Hildegard.", site.name),
    );
  });
}

/// A site the person took off the list: its window closes, and then its sign-in goes. Elsewhere that is its profile
/// folder (the server deletes it too, but not from under an open window); on macOS 14 and later it is its WebKit data
/// store, which only the app can remove. On macOS 11 to 13 there is no store of its own to remove.
fn forget_site(app: &AppHandle, id: &str) {
  let (app, id) = (app.clone(), id.to_owned());
  std::thread::spawn(move || {
    if let Some(w) = app.get_webview_window(&browse::window_label(&id)) {
      let _ = w.destroy();
    }
    #[cfg(target_vendor = "apple")]
    if browse::separate_stores(macos_major()) {
      remove_store(&app, browse::store_id(&id));
    }
    if !cfg!(target_vendor = "apple") {
      std::thread::sleep(Duration::from_secs(1));
      if let Some(dir) = browse::profile_dir(&app.state::<Hildegard>().layout.data, &id) {
        let _ = std::fs::remove_dir_all(dir);
      }
    }
  });
}

/// Removes a WebKit data store, trying for a while: WebKit refuses while a webview that used it is still going away.
#[cfg(target_vendor = "apple")]
fn remove_store(app: &AppHandle, store: [u8; 16]) {
  let mut why = String::new();
  for _ in 0..10 {
    std::thread::sleep(Duration::from_secs(1));
    match tauri::async_runtime::block_on(app.remove_data_store(store)) {
      Ok(()) => return,
      Err(e) => why = e.to_string(),
    }
  }
  log(&app.state::<Hildegard>().layout, &format!("Couldn’t remove a removed site’s data store: {why}"));
}

/// On macOS 14 and later, at launch: removes the data stores of sites no longer listed, such as one removed while
/// the app wasn't running. Every store with an id is a site's; the Studio's window uses the default store.
#[cfg(target_vendor = "apple")]
fn prune_stores(app: &AppHandle) {
  if !browse::separate_stores(macos_major()) {
    return;
  }
  let app = app.clone();
  std::thread::spawn(move || {
    // Only on the word of a list that was read: with no added sites' file, every store is kept.
    let Some(listed) = browse::listed_ids(&app.state::<Hildegard>().layout.data) else { return };
    let keep: Vec<[u8; 16]> = listed.iter().map(|id| browse::store_id(id)).collect();
    match tauri::async_runtime::block_on(app.fetch_data_store_identifiers()) {
      Ok(ids) => {
        for id in browse::stores_to_remove(&ids, &keep) {
          remove_store(&app, id);
        }
      }
      Err(e) => log(&app.state::<Hildegard>().layout, &format!("Couldn’t list the sites’ data stores: {e}")),
    }
  });
}

fn site_window_menu(app: &AppHandle, site: &Site) -> tauri::Result<Menu<Wry>> {
  let external = MenuItem::with_id(
    app,
    format!("browse-external:{}", site.id),
    format!("Open {} in your browser", site.name),
    true,
    None::<&str>,
  )?;
  let signout =
    MenuItem::with_id(app, format!("browse-signout:{}", site.id), "Sign out of this site", true, None::<&str>)?;
  let sub = Submenu::with_items(app, "Site", true, &[&external, &signout])?;
  Menu::with_items(app, &[&sub])
}

fn fill_browse(app: &AppHandle, sub: &Submenu<Wry>) -> tauri::Result<()> {
  for site in browse::all_sites(&app.state::<Hildegard>().layout.data) {
    let open =
      MenuItem::with_id(app, format!("browse-open:{}", site.id), format!("Open {}", site.name), true, None::<&str>)?;
    let signout =
      MenuItem::with_id(app, format!("browse-signout:{}", site.id), "Sign out of this site", true, None::<&str>)?;
    sub.append(&Submenu::with_items(app, &site.name, true, &[&open, &signout])?)?;
  }
  sub.append(&PredefinedMenuItem::separator(app)?)?;
  sub.append(&MenuItem::with_id(app, "browse-add", "Add a site…", true, None::<&str>)?)?;
  Ok(())
}

/// A Browse menu with every site in it, kept so it can be redone when the person adds one.
fn browse_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
  let sub = Submenu::new(app, "Browse", true)?;
  fill_browse(app, &sub)?;
  let hg = app.state::<Hildegard>();
  *hg.browse_listed.lock().unwrap() = browse::all_sites(&hg.layout.data).into_iter().map(|s| s.id).collect();
  hg.browse_menus.lock().unwrap().push(sub.clone());
  Ok(sub)
}

/// Redoes the Browse menus when the sites the person added have changed.
fn refresh_browse(app: &AppHandle) {
  let hg = app.state::<Hildegard>();
  let now: Vec<String> = browse::all_sites(&hg.layout.data).into_iter().map(|s| s.id).collect();
  let before = hg.browse_listed.lock().unwrap().clone();
  if before == now {
    return;
  }
  if let Some(listed) = browse::listed_ids(&hg.layout.data) {
    for gone in before.iter().filter(|id| !listed.contains(id)) {
      forget_site(app, gone);
    }
  }
  for sub in hg.browse_menus.lock().unwrap().iter() {
    if let Ok(items) = sub.items() {
      for item in items {
        let _ = sub.remove(&item);
      }
    }
    if let Err(e) = fill_browse(app, sub) {
      log(&hg.layout, &format!("Couldn’t redo the Browse menu: {e}"));
    }
  }
  *hg.browse_listed.lock().unwrap() = now;
}

/// Every menu choice: the tray's, the menu bar's and a site window's. Tauri hands each menu event to every handler
/// registered for it, the app's and the tray's, so this is the only one: one click, one action.
fn menu_event(app: &AppHandle, id: &str) {
  match id {
    "open" => show_window(app),
    "sharing" => toggle_sharing(app),
    "update" => {
      let app = app.clone();
      std::thread::spawn(move || restart_to_update(&app));
    }
    "quit" => {
      let app = app.clone();
      // Stopping Hildegard can take a few seconds; not on the thread that draws the menu.
      std::thread::spawn(move || quit(&app));
    }
    other => browse_event(app, other),
  }
}

/// A choice from any Browse menu, or from a site window's own.
fn browse_event(app: &AppHandle, id: &str) {
  if id == "browse-add" {
    let port = app.state::<Hildegard>().port.load(Ordering::SeqCst);
    show_studio(app, port, "#/browse");
    show_window(app);
    return;
  }
  let Some((action, site)) = id.split_once(':') else { return };
  let Some(site) = site_by_id(app, site) else { return };
  match action {
    // YouTube opens too: its window is for watching, and it offers the browser where Google asks for a sign-in.
    "browse-open" => {
      if let Ok(home) = Url::parse(&site.home) {
        open_site(app, &site, &home);
      }
    }
    "browse-external" => handoff(app, &site),
    "browse-signout" => sign_out(app, &site),
    _ => {}
  }
}

// ── The tray ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// Reads the link's state from Hildegard and updates the tray to match.
fn refresh_sharing(app: &AppHandle) {
  let hg = app.state::<Hildegard>();
  let port = hg.port.load(Ordering::SeqCst);
  let up = hg.showing_studio.load(Ordering::SeqCst);
  let now = server::get(port, "/api/host").ok().filter(|_| up);
  let mut sharing = hg.sharing.lock().unwrap();
  *sharing = match (now, sharing.clone()) {
    (Some(h), _) if h["on"].as_bool() == Some(true) => {
      Sharing::On { via: h["via"].as_str().unwrap_or("tailscale").to_owned() }
    }
    (Some(_), Sharing::Paused { via }) => Sharing::Paused { via },
    _ => Sharing::Off,
  };
  let (text, enabled) = match &*sharing {
    Sharing::Off => ("Sharing is off", false),
    Sharing::On { .. } => ("Pause sharing", true),
    Sharing::Paused { .. } => ("Resume sharing", true),
  };
  drop(sharing);
  let item = hg.sharing_item.lock().unwrap().clone();
  if let Some(item) = item {
    let _ = item.set_text(text);
    let _ = item.set_enabled(enabled);
  }
}

/// Pauses the link (Settings › Sharing) through Hildegard's own API, or turns it on again the way it was.
fn toggle_sharing(app: &AppHandle) {
  let app = app.clone();
  std::thread::spawn(move || {
    let hg = app.state::<Hildegard>();
    let port = hg.port.load(Ordering::SeqCst);
    let was = hg.sharing.lock().unwrap().clone();
    let done = match &was {
      Sharing::On { via } => {
        server::post(port, "/api/host/off", json!({})).map(|_| Sharing::Paused { via: via.clone() })
      }
      Sharing::Paused { via } => {
        server::post(port, "/api/host", json!({ "via": via })).map(|_| Sharing::On { via: via.clone() })
      }
      Sharing::Off => return,
    };
    match done {
      Ok(s) => *hg.sharing.lock().unwrap() = s,
      Err(e) => {
        log(&hg.layout, &format!("Sharing didn’t change: {e}"));
        // Settings › Sharing says what went wrong and how to fix it.
        show_studio(&app, port, "#/settings/sharing");
        show_window(&app);
      }
    }
    refresh_sharing(&app);
  });
}

/// Quits, stopping Hildegard only if this app started it. A Hildegard started from the terminal keeps running.
fn quit(app: &AppHandle) {
  static QUITTING: AtomicBool = AtomicBool::new(false);
  if QUITTING.swap(true, Ordering::SeqCst) {
    return;
  }
  stop_here(app);
  app.exit(0);
}

/// Stops the install and the Hildegard this app started, as quitting does.
fn stop_here(app: &AppHandle) {
  let hg = app.state::<Hildegard>();
  let _ = app.save_window_state(StateFlags::all() - StateFlags::VISIBLE);
  if let Some(mut c) = hg.installer.lock().unwrap().take() {
    let _ = c.kill();
  }
  if hg.started_here.load(Ordering::SeqCst) {
    let port = hg.port.load(Ordering::SeqCst);
    let mut sidecar = hg.sidecar.lock().unwrap().take();
    server::stop(port, sidecar.as_mut());
  }
}

/// Installs the app update the tray offered and opens the new app, which starts Hildegard again and moves the
/// command to its version.
fn restart_to_update(app: &AppHandle) {
  stop_here(app);
  if let Err(e) = update::install(app) {
    log(&app.state::<Hildegard>().layout, &format!("Couldn’t install the app update: {e}"));
  }
  app.restart();
}

/// On launch and every six hours: downloads a newer app, if there is one, and offers it at the top of the tray.
fn watch_updates(app: AppHandle) {
  if !update::updatable() {
    return;
  }
  std::thread::spawn(move || loop {
    match tauri::async_runtime::block_on(update::fetch(&app)) {
      Ok(Some(version)) => {
        let offer = || -> tauri::Result<()> {
          let item = MenuItem::with_id(&app, "update", format!("Restart to update to {version}"), true, None::<&str>)?;
          if let Some(menu) = app.state::<Hildegard>().menu.lock().unwrap().as_ref() {
            menu.insert_items(&[&item, &PredefinedMenuItem::separator(&app)?], 0)?;
          }
          Ok(())
        };
        if let Err(e) = offer() {
          log(&app.state::<Hildegard>().layout, &format!("Couldn’t offer the app update in the tray: {e}"));
        }
      }
      Ok(None) => {}
      // Offline, or GitHub didn't answer: the next check tries again.
      Err(e) => log(&app.state::<Hildegard>().layout, &format!("Couldn’t check for an app update: {e}")),
    }
    std::thread::sleep(Duration::from_secs(6 * 60 * 60));
  });
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
  let open = MenuItem::with_id(app, "open", "Open Studio", true, None::<&str>)?;
  let sharing = MenuItem::with_id(app, "sharing", "Sharing is off", false, None::<&str>)?;
  let quit_item = MenuItem::with_id(app, "quit", "Quit Hildegard", true, None::<&str>)?;
  let browse = browse_menu(app)?;
  let menu = Menu::with_items(
    app,
    &[
      &open,
      &PredefinedMenuItem::separator(app)?,
      &browse,
      &PredefinedMenuItem::separator(app)?,
      &sharing,
      &PredefinedMenuItem::separator(app)?,
      &quit_item,
    ],
  )?;
  *app.state::<Hildegard>().sharing_item.lock().unwrap() = Some(sharing);
  *app.state::<Hildegard>().menu.lock().unwrap() = Some(menu.clone());
  TrayIconBuilder::with_id("main")
    .icon(Image::from_bytes(TRAY_ICON)?)
    .icon_as_template(cfg!(target_os = "macos"))
    .tooltip("Hildegard")
    .menu(&menu)
    // A click opens the window on Windows and Linux; on macOS the menu bar shows the menu, as it does for every app.
    .show_menu_on_left_click(cfg!(target_os = "macos"))
    // Its menu's choices reach the app's one menu handler, `menu_event`.
    .on_tray_icon_event(|tray, e| {
      if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
        show_window(tray.app_handle());
      }
    })
    .build(app)?;
  Ok(())
}

/// Every few seconds: notices when Hildegard stops (from the Studio's Settings, say) and shows the start-up page
/// again, and keeps the tray's sharing item up to date.
fn watch(app: AppHandle) {
  std::thread::spawn(move || {
    let mut misses = 0;
    for tick in 0u64.. {
      std::thread::sleep(Duration::from_secs(2));
      let hg = app.state::<Hildegard>();
      if !hg.showing_studio.load(Ordering::SeqCst) {
        continue;
      }
      let port = hg.port.load(Ordering::SeqCst);
      if server::health(port).is_some() {
        misses = 0;
        if tick % 10 == 0 {
          refresh_sharing(&app);
        }
        // Reads one small file; the menus are redone, and a removed site's window closed, only when the list changed.
        refresh_browse(&app);
        continue;
      }
      // An update restarts Hildegard as the new version; that's a pause, not a stop.
      if updating(&hg.layout) {
        misses = 0;
        continue;
      }
      misses += 1;
      if misses < 2 {
        continue;
      }
      misses = 0;
      hg.showing_studio.store(false, Ordering::SeqCst);
      if let Some(mut c) = hg.sidecar.lock().unwrap().take() {
        let _ = c.wait();
      }
      hg.started_here.store(false, Ordering::SeqCst);
      refresh_sharing(&app);
      if let Some(w) = app.get_webview_window("main") {
        let _ = w.navigate(nav::app_page("index.html#stopped"));
      }
    }
  });
}

/// `hildegard update` is restarting Hildegard: it leaves this file until the new version answers, or for at most
/// fifteen minutes.
fn updating(layout: &Layout) -> bool {
  std::fs::metadata(layout.data.join("updating"))
    .and_then(|m| m.modified())
    .is_ok_and(|t| t.elapsed().is_ok_and(|e| e < Duration::from_secs(15 * 60)))
}

/// Saves a download in the Downloads folder, under a name nothing else there has, and shows it when it's done.
fn downloads(webview: tauri::Webview, event: DownloadEvent<'_>) -> bool {
  match event {
    DownloadEvent::Requested { url, destination } => {
      let name = destination
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .or_else(|| url.path_segments().and_then(|mut s| s.next_back()).map(str::to_owned))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Hildegard download".to_owned());
      if let Ok(dir) = webview.app_handle().path().download_dir() {
        let mut path = dir.join(&name);
        let (stem, ext) = match name.rsplit_once('.') {
          Some((s, e)) => (s.to_owned(), format!(".{e}")),
          None => (name.clone(), String::new()),
        };
        let mut n = 2;
        while path.exists() {
          path = dir.join(format!("{stem} ({n}){ext}"));
          n += 1;
        }
        *destination = path;
      }
      true
    }
    DownloadEvent::Finished { path: Some(path), success: true, .. } => {
      let _ = webview.app_handle().opener().reveal_item_in_dir(path);
      true
    }
    _ => true,
  }
}

pub fn run() {
  // WebKitGTK draws a blank window on some Linux GPUs (NVIDIA on Wayland, as on many Omarchy machines) unless its
  // DMA-BUF renderer is off. Someone who set it either way keeps their choice.
  #[cfg(target_os = "linux")]
  if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
  }

  let app = tauri::Builder::default()
    // First, so a second launch only brings this one forward.
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(
      tauri_plugin_window_state::Builder::default().with_state_flags(StateFlags::all() - StateFlags::VISIBLE).build(),
    )
    .invoke_handler(tauri::generate_handler![launch, install, open_logs])
    .on_menu_event(|app, event| menu_event(app, event.id().as_ref()))
    .setup(|app| {
      let layout = Layout::new(Os::current(), &system_env);
      let exe_dir = std::env::current_exe()?.parent().map(|p| p.to_path_buf()).unwrap_or_default();
      let bundled = Bundled {
        // Named so it never takes the place of a system `node` (the .deb puts it in /usr/bin).
        node: exe_dir.join(if cfg!(windows) { "hildegard-node.exe" } else { "hildegard-node" }),
        payload: app.path().resource_dir()?.join("hildegard"),
      };
      let port = Arc::new(AtomicU16::new(paths::port(&layout.data, &system_env)));
      app.manage(Hildegard {
        layout,
        bundled,
        port: port.clone(),
        sidecar: Mutex::new(None),
        started_here: AtomicBool::new(false),
        installer: Arc::new(Mutex::new(None)),
        showing_studio: AtomicBool::new(false),
        sharing: Mutex::new(Sharing::Off),
        sharing_item: Mutex::new(None),
        menu: Mutex::new(None),
        browse_menus: Mutex::new(Vec::new()),
        browse_listed: Mutex::new(Vec::new()),
      });
      app.manage(update::Pending::default());

      let handle = app.handle().clone();
      WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Hildegard")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 520.0)
        .background_color(tauri::window::Color(10, 14, 19, 255))
        .on_navigation(move |url| {
          if nav::allowed_in_window(url, port.load(Ordering::SeqCst)) {
            return true;
          }
          if nav::opens_outside(url) {
            // A link to X, Instagram or another site that has a window opens that window.
            link_out(&handle, url);
          }
          false
        })
        .on_new_window({
          let handle = app.handle().clone();
          move |url, _| {
            // Links that open a new tab go to the site's window (the Post sheet's links to X, Instagram and the
            // rest) or, for licenses and Tailscale's pages, the system browser.
            if nav::opens_outside(&url) {
              link_out(&handle, &url);
            }
            NewWindowResponse::Deny
          }
        })
        .on_download(downloads)
        .build()?;

      tray(app.handle())?;
      // On macOS the menu bar shows the app's own menus; Browse joins them. Elsewhere the Browse menu is the tray's.
      #[cfg(target_os = "macos")]
      {
        let menu = Menu::default(app.handle())?;
        let at = menu.items()?.len().saturating_sub(2);
        menu.insert(&browse_menu(app.handle())?, at)?;
        app.set_menu(menu)?;
      }
      #[cfg(target_vendor = "apple")]
      prune_stores(app.handle());
      watch(app.handle().clone());
      watch_updates(app.handle().clone());
      Ok(())
    })
    .on_window_event(|window, event| {
      // Closing the window keeps Hildegard in the tray, rendering; Quit in the tray ends it. A site's window closes.
      if window.label() != "main" {
        return;
      }
      if let WindowEvent::CloseRequested { api, .. } = event {
        let _ = window.app_handle().save_window_state(StateFlags::all() - StateFlags::VISIBLE);
        api.prevent_close();
        let _ = window.hide();
      }
    })
    .build(tauri::generate_context!())
    .expect("the Hildegard app to start");

  app.run(|app, event| match event {
    // The Dock icon on macOS brings the window back.
    #[cfg(target_os = "macos")]
    RunEvent::Reopen { .. } => show_window(app),
    RunEvent::ExitRequested { api, code, .. } if code.is_none() => {
      // The window never closes (it hides), so this is the system asking: Quit in the macOS menu, ⌘Q, logging out.
      // Quit as the tray does, stopping a Hildegard this app started; that ends in an exit with a code.
      api.prevent_exit();
      let app = app.clone();
      std::thread::spawn(move || quit(&app));
    }
    _ => {
      let _ = app;
    }
  });
}

#[cfg(test)]
mod tests {
  #[test]
  fn one_menu_handler_takes_every_choice() {
    // Tauri gives every menu event to the app's handler and to the tray's: two handlers would act twice on one click
    // (two windows, two browser tabs, two sign-outs).
    let lib = include_str!("lib.rs");
    let handler = [".on_menu", "_event("].concat();
    assert_eq!(lib.matches(handler.as_str()).count(), 1);
    assert!(lib.contains(&format!("{handler}|app, event| menu_event(app, event.id().as_ref()))")));
    for id in ["\"open\"", "\"sharing\"", "\"update\"", "\"quit\"", "other => browse_event(app, other)"] {
      let menu = &lib[lib.find("fn menu_event").unwrap()..lib.find("fn browse_event").unwrap()];
      assert!(menu.contains(id), "{id}");
    }
  }
}
