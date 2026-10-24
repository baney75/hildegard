// SPDX-License-Identifier: AGPL-3.0-only
//! The Hildegard app: a native window around the Studio. It finds the Hildegard already running on this computer, or
//! starts one, and shows the Studio from it. Its own start-up page (ui/) does the first-run install. The Studio itself
//! is the server's, at http://127.0.0.1:<port>, and has no access to the app at all.

mod install;
mod nav;
mod paths;
mod server;

use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tauri::image::Image;
use tauri::ipc::Channel;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

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
  app.exit(0);
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
  let open = MenuItem::with_id(app, "open", "Open Studio", true, None::<&str>)?;
  let sharing = MenuItem::with_id(app, "sharing", "Sharing is off", false, None::<&str>)?;
  let quit_item = MenuItem::with_id(app, "quit", "Quit Hildegard", true, None::<&str>)?;
  let menu = Menu::with_items(
    app,
    &[&open, &PredefinedMenuItem::separator(app)?, &sharing, &PredefinedMenuItem::separator(app)?, &quit_item],
  )?;
  *app.state::<Hildegard>().sharing_item.lock().unwrap() = Some(sharing);
  TrayIconBuilder::with_id("main")
    .icon(Image::from_bytes(TRAY_ICON)?)
    .icon_as_template(cfg!(target_os = "macos"))
    .tooltip("Hildegard")
    .menu(&menu)
    // A click opens the window on Windows and Linux; on macOS the menu bar shows the menu, as it does for every app.
    .show_menu_on_left_click(cfg!(target_os = "macos"))
    .on_menu_event(|app, e| match e.id().as_ref() {
      "open" => show_window(app),
      "sharing" => toggle_sharing(app),
      "quit" => {
        let app = app.clone();
        // Stopping Hildegard can take a few seconds; not on the thread that draws the menu.
        std::thread::spawn(move || quit(&app));
      }
      _ => {}
    })
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
    .plugin(
      tauri_plugin_window_state::Builder::default().with_state_flags(StateFlags::all() - StateFlags::VISIBLE).build(),
    )
    .invoke_handler(tauri::generate_handler![launch, install, open_logs])
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
      });

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
            let _ = handle.opener().open_url(url.as_str(), None::<&str>);
          }
          false
        })
        .on_new_window({
          let handle = app.handle().clone();
          move |url, _| {
            // Links that open a new tab (licenses, Tailscale's pages) go to the system browser.
            if nav::opens_outside(&url) {
              let _ = handle.opener().open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
          }
        })
        .on_download(downloads)
        .build()?;

      tray(app.handle())?;
      watch(app.handle().clone());
      Ok(())
    })
    .on_window_event(|window, event| {
      // Closing the window keeps Hildegard in the tray, rendering; Quit in the tray ends it.
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
