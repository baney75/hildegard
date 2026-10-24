// SPDX-License-Identifier: AGPL-3.0-only
//! Where Hildegard lives on this computer: the same folders, port file and launcher as the CLI and the installers
//! (apps/server/src/config.ts, install/install.sh, install/install.ps1), so the app and `hildegard` share one install.

use std::path::{Path, PathBuf};

/// The port Hildegard uses when nothing else names one.
pub const DEFAULT_PORT: u16 = 7341;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Os {
  Linux,
  Mac,
  Windows,
}

impl Os {
  pub fn current() -> Os {
    if cfg!(target_os = "windows") {
      Os::Windows
    } else if cfg!(target_os = "macos") {
      Os::Mac
    } else {
      Os::Linux
    }
  }
}

/// Reads an environment variable, treating an empty one as unset.
pub type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

pub fn system_env(name: &str) -> Option<String> {
  std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn home(os: Os, env: Env) -> PathBuf {
  let var = if os == Os::Windows { "USERPROFILE" } else { "HOME" };
  env(var).or_else(|| env("HOME")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// Hildegard's folder: HILDEGARD_HOME, else the folder an installed `hildegard` command was set up with (an install
/// to D:\Hildegard, or anywhere HILDEGARD_HOME pointed then), else `defaultDataDir` in apps/server/src/config.ts.
pub fn data_dir(os: Os, env: Env) -> PathBuf {
  if let Some(h) = env("HILDEGARD_HOME") {
    return PathBuf::from(h);
  }
  if let Some(h) = installed_home(os, env) {
    return h;
  }
  let home = home(os, env);
  match os {
    Os::Mac => home.join("Library").join("Application Support").join("Hildegard"),
    Os::Windows => {
      env("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData").join("Local")).join("Hildegard")
    }
    Os::Linux => {
      env("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local").join("share")).join("hildegard")
    }
  }
}

/// The home written into the first `hildegard` launcher found in the installers' bin folder or on PATH, if that folder
/// still exists. install.sh writes `export HILDEGARD_HOME="…"`, install.ps1 `set "HILDEGARD_HOME=…"`.
fn installed_home(os: Os, env: Env) -> Option<PathBuf> {
  let (name, prefix, suffix) = match os {
    Os::Windows => ("hildegard.cmd", "set \"HILDEGARD_HOME=", "\""),
    _ => ("hildegard", "export HILDEGARD_HOME=\"", "\""),
  };
  let mut dirs = Vec::new();
  if os != Os::Windows {
    dirs.push(env("XDG_BIN_HOME").map(PathBuf::from).unwrap_or_else(|| home(os, env).join(".local").join("bin")));
  }
  if let Some(path) = env("PATH").or_else(|| env("Path")) {
    dirs.extend(std::env::split_paths(&path));
  }
  dirs.iter().find_map(|d| {
    let text = std::fs::read_to_string(d.join(name)).ok()?;
    let home = text.lines().find_map(|l| l.trim().strip_prefix(prefix)?.strip_suffix(suffix))?;
    let home = PathBuf::from(home);
    home.is_dir().then_some(home)
  })
}

/// The port the server last started on, from `<data>/server.json`: `rememberedPort` in config.ts.
pub fn remembered_port(data: &Path) -> Option<u16> {
  let text = std::fs::read_to_string(data.join("server.json")).ok()?;
  let v: serde_json::Value = serde_json::from_str(&text).ok()?;
  v.get("port")?.as_u64().and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0)
}

/// The port `hildegard start` would use: HILDEGARD_PORT, the remembered one, or 7341.
pub fn port(data: &Path, env: Env) -> u16 {
  env("HILDEGARD_PORT")
    .and_then(|p| p.parse().ok())
    .filter(|p| *p > 0)
    .or_else(|| remembered_port(data))
    .unwrap_or(DEFAULT_PORT)
}

/// What the installers put in Hildegard's folder, and the `hildegard` command they add.
#[derive(Clone, Debug)]
pub struct Layout {
  pub os: Os,
  pub data: PathBuf,
  /// Hildegard's own Node.js.
  pub node: PathBuf,
  /// `app`, a link to the current `app-<version>` folder.
  pub app: PathBuf,
  /// `app/hildegard.mjs`: the CLI, server and MCP server in one file.
  pub entry: PathBuf,
  /// The `hildegard` command.
  pub launcher: PathBuf,
  pub logs: PathBuf,
}

impl Layout {
  pub fn new(os: Os, env: Env) -> Layout {
    let data = data_dir(os, env);
    let (node, launcher) = match os {
      Os::Windows => (data.join("node").join("node.exe"), data.join("bin").join("hildegard.cmd")),
      _ => {
        let bin = env("XDG_BIN_HOME").map(PathBuf::from).unwrap_or_else(|| home(os, env).join(".local").join("bin"));
        (data.join("node").join("bin").join("node"), bin.join("hildegard"))
      }
    };
    let app = data.join("app");
    Layout { os, entry: app.join("hildegard.mjs"), app, node, launcher, logs: data.join("logs"), data }
  }

  /// The CLI is here: Node.js and hildegard.mjs, as install.sh and install.ps1 leave them.
  pub fn has_cli(&self) -> bool {
    self.node.is_file() && self.entry.is_file()
  }

  /// `hildegard install` finished: ComfyUI runs here (runtime.json), or takes render on another device (Choir).
  pub fn has_runtime(&self) -> bool {
    if self.data.join("runtime.json").is_file() {
      return true;
    }
    std::fs::read_to_string(self.data.join("choir").join("devices.json"))
      .ok()
      .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
      .and_then(|v| v.get("use").and_then(|u| u.as_str()).map(|u| !u.is_empty() && u != "local"))
      .unwrap_or(false)
  }

  /// The version of the CLI here, from its package.json.
  pub fn cli_version(&self) -> Option<String> {
    version_of(&self.app)
  }
}

/// The `version` in a release folder's package.json.
pub fn version_of(dir: &Path) -> Option<String> {
  let text = std::fs::read_to_string(dir.join("package.json")).ok()?;
  let v: serde_json::Value = serde_json::from_str(&text).ok()?;
  v.get("version")?.as_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;

  fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    move |k| m.get(k).cloned().filter(|v| !v.is_empty())
  }

  #[test]
  fn data_dir_matches_the_cli_on_each_os() {
    let e = env_of(&[
      ("HOME", "/home/ann"),
      ("USERPROFILE", "C:\\Users\\ann"),
      ("LOCALAPPDATA", "C:\\Users\\ann\\AppData\\Local"),
    ]);
    assert_eq!(data_dir(Os::Linux, &e), PathBuf::from("/home/ann/.local/share/hildegard"));
    assert_eq!(data_dir(Os::Mac, &e), PathBuf::from("/home/ann/Library/Application Support/Hildegard"));
    assert_eq!(data_dir(Os::Windows, &e), PathBuf::from("C:\\Users\\ann\\AppData\\Local").join("Hildegard"));
    let xdg = env_of(&[("HOME", "/home/ann"), ("XDG_DATA_HOME", "/data")]);
    assert_eq!(data_dir(Os::Linux, &xdg), PathBuf::from("/data/hildegard"));
    let set = env_of(&[("HOME", "/home/ann"), ("HILDEGARD_HOME", "/srv/hg")]);
    assert_eq!(data_dir(Os::Mac, &set), PathBuf::from("/srv/hg"));
  }

  #[test]
  fn data_dir_follows_an_installed_command_to_its_home() {
    let root = std::env::temp_dir().join(format!("hg-desktop-home-{}", std::process::id()));
    let (bin, home) = (root.join("bin"), root.join("elsewhere"));
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let h = home.to_str().unwrap();
    std::fs::write(bin.join("hildegard"), format!("#!/bin/sh\nexport HILDEGARD_HOME=\"{h}\"\nexec node\n")).unwrap();
    std::fs::write(bin.join("hildegard.cmd"), format!("@echo off\r\nset \"HILDEGARD_HOME={h}\"\r\nnode %*\r\n"))
      .unwrap();
    let e = env_of(&[("HOME", "/home/ann"), ("XDG_BIN_HOME", bin.to_str().unwrap())]);
    assert_eq!(data_dir(Os::Linux, &e), home);
    let w = env_of(&[("LOCALAPPDATA", "L"), ("PATH", bin.to_str().unwrap())]);
    assert_eq!(data_dir(Os::Windows, &w), home);
    // A launcher whose folder is gone is ignored, and HILDEGARD_HOME still wins.
    std::fs::remove_dir_all(&home).unwrap();
    assert_eq!(data_dir(Os::Linux, &e), PathBuf::from("/home/ann/.local/share/hildegard"));
    std::fs::remove_dir_all(&root).unwrap();
  }

  #[test]
  fn launcher_and_node_are_where_the_installers_put_them() {
    let e = env_of(&[("HOME", "/home/ann")]);
    let l = Layout::new(Os::Linux, &e);
    assert_eq!(l.launcher, PathBuf::from("/home/ann/.local/bin/hildegard"));
    assert_eq!(l.node, PathBuf::from("/home/ann/.local/share/hildegard/node/bin/node"));
    assert_eq!(l.entry, PathBuf::from("/home/ann/.local/share/hildegard/app/hildegard.mjs"));
    let w = Layout::new(Os::Windows, &env_of(&[("LOCALAPPDATA", "L"), ("USERPROFILE", "U")]));
    assert_eq!(w.launcher, PathBuf::from("L").join("Hildegard").join("bin").join("hildegard.cmd"));
    assert_eq!(w.node, PathBuf::from("L").join("Hildegard").join("node").join("node.exe"));
  }

  #[test]
  fn port_comes_from_the_environment_then_server_json_then_the_default() {
    let dir = std::env::temp_dir().join(format!("hg-desktop-port-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let none = env_of(&[]);
    assert_eq!(port(&dir, &none), DEFAULT_PORT);
    std::fs::write(dir.join("server.json"), r#"{"port":7420,"pid":1}"#).unwrap();
    assert_eq!(port(&dir, &none), 7420);
    assert_eq!(port(&dir, &env_of(&[("HILDEGARD_PORT", "7500")])), 7500);
    std::fs::write(dir.join("server.json"), r#"{"port":0}"#).unwrap();
    assert_eq!(port(&dir, &none), DEFAULT_PORT);
    std::fs::write(dir.join("server.json"), "not json").unwrap();
    assert_eq!(port(&dir, &none), DEFAULT_PORT);
    std::fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn runtime_counts_comfyui_here_or_a_device_to_render_on() {
    let dir = std::env::temp_dir().join(format!("hg-desktop-rt-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("choir")).unwrap();
    let e = env_of(&[("HILDEGARD_HOME", dir.to_str().unwrap())]);
    let l = Layout::new(Os::Linux, &e);
    assert!(!l.has_runtime());
    std::fs::write(dir.join("choir").join("devices.json"), r#"{"use":"local","devices":[]}"#).unwrap();
    assert!(!l.has_runtime());
    std::fs::write(dir.join("choir").join("devices.json"), r#"{"use":"parish1","devices":[]}"#).unwrap();
    assert!(l.has_runtime());
    std::fs::remove_file(dir.join("choir").join("devices.json")).unwrap();
    std::fs::write(dir.join("runtime.json"), "{}").unwrap();
    assert!(l.has_runtime());
    std::fs::remove_dir_all(&dir).unwrap();
  }
}
