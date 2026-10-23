// SPDX-License-Identifier: AGPL-3.0-only
//! The first-run install, the same as the one-line installers: Node.js and the release go in Hildegard's folder
//! (from inside the app, so nothing is downloaded for them), the `hildegard` command goes where install.sh and
//! install.ps1 put it, then `hildegard install --yes` sets up ComfyUI and PyTorch and starts Hildegard.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::paths::{version_of, Layout, Os};
use crate::server::no_console;

/// One step, as the CLI reports it (`Step` in packages/runtime/src/install.ts).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Step {
  pub id: String,
  pub title: String,
  pub status: String,
  pub detail: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub command: Option<String>,
}

/// What the first-run page sees while the install runs.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Event {
  Step { step: Step },
  Log { line: String },
}

/// How the install ended: the CLI's `{ ok, needsOwner, steps, message }`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
  pub ok: bool,
  #[serde(default)]
  pub needs_owner: bool,
  #[serde(default)]
  pub steps: Vec<Step>,
  #[serde(default)]
  pub message: String,
}

/// What the app carries: Node.js next to its own executable, and the release unpacked in its resources.
pub struct Bundled {
  pub node: PathBuf,
  pub payload: PathBuf,
}

impl Bundled {
  pub fn version(&self) -> Option<String> {
    version_of(&self.payload)
  }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
  std::fs::create_dir_all(to)?;
  for entry in std::fs::read_dir(from)? {
    let entry = entry?;
    let dest = to.join(entry.file_name());
    if entry.file_type()?.is_dir() {
      copy_dir(&entry.path(), &dest)?;
    } else {
      std::fs::copy(entry.path(), dest)?;
    }
  }
  Ok(())
}

fn node_version(node: &Path) -> Option<String> {
  let mut cmd = Command::new(node);
  cmd.arg("--version").stdin(Stdio::null()).stderr(Stdio::null());
  no_console(&mut cmd);
  let out = cmd.output().ok()?;
  out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// Points `app` at `app-<version>`: a symlink, or on Windows a junction (no admin rights needed), as the installers do.
fn link_app(layout: &Layout, version: &str) -> std::io::Result<()> {
  let link = &layout.app;
  if std::fs::symlink_metadata(link).is_ok() {
    // A link (or junction) goes with remove_file on Unix and remove_dir on Windows; neither touches its target.
    if std::fs::remove_file(link).is_err() {
      std::fs::remove_dir(link)?;
    }
  }
  #[cfg(unix)]
  {
    std::os::unix::fs::symlink(format!("app-{version}"), link)
  }
  #[cfg(windows)]
  {
    let target = layout.data.join(format!("app-{version}"));
    let mut cmd = Command::new("cmd");
    cmd.arg("/C").arg("mklink").arg("/J").arg(link).arg(&target).stdout(Stdio::null()).stderr(Stdio::null());
    no_console(&mut cmd);
    let status = cmd.status()?;
    if status.success() {
      Ok(())
    } else {
      Err(std::io::Error::other("Couldn’t link the app folder."))
    }
  }
}

/// The `hildegard` command, word for word what install.sh and install.ps1 write.
pub fn launcher_text(layout: &Layout) -> String {
  let home = layout.data.display();
  match layout.os {
    Os::Windows => format!(
      "@echo off\r\nset \"HILDEGARD_HOME={home}\"\r\nset \"HILDEGARD_ENTRY={app}\\hildegard.mjs\"\r\n\"{home}\\node\\node.exe\" \"{app}\\hildegard.mjs\" %*\r\n",
      app = layout.app.display()
    ),
    _ => format!(
      "#!/bin/sh\nexport HILDEGARD_HOME=\"{home}\"\n# AI apps get this path, which survives upgrades (app is a link to the current version).\nexport HILDEGARD_ENTRY=\"{home}/app/hildegard.mjs\"\nexec \"{home}/node/bin/node\" \"{home}/app/hildegard.mjs\" \"$@\"\n"
    ),
  }
}

/// Adds Hildegard's `bin` folder to this user's PATH on Windows, as install.ps1 does.
#[cfg(windows)]
fn add_to_path(bin: &Path) {
  let script = "$b = $args[0]; $p = [Environment]::GetEnvironmentVariable('Path', 'User'); \
    if (-not (($p -split ';') -contains $b)) { [Environment]::SetEnvironmentVariable('Path', ((@($p, $b) | Where-Object { $_ }) -join ';'), 'User') }";
  let mut cmd = Command::new("powershell");
  cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]).arg(bin).stdout(Stdio::null()).stderr(Stdio::null());
  no_console(&mut cmd);
  let _ = cmd.status();
}

/// Puts the app's Node.js and release in Hildegard's folder and adds the `hildegard` command. Safe to run again:
/// what is already there and the same is left alone. Keeps this version and the one before it, as the installers do.
pub fn lay_down(bundled: &Bundled, layout: &Layout) -> Result<Vec<Step>, String> {
  let version = bundled.version().ok_or("This app is missing its copy of Hildegard. Reinstall the app.")?;
  let fail = |what: &str, e: std::io::Error| format!("Couldn’t {what} in {}: {e}", layout.data.display());
  std::fs::create_dir_all(&layout.data).map_err(|e| fail("make Hildegard’s folder", e))?;
  let mut steps = vec![];

  // The release goes in when there's none here or the one here is older; a newer one (from the one-line installer)
  // stays, with its own Node.js.
  let current = layout.cli_version().filter(|_| layout.entry.is_file());
  let replace = current.as_deref().is_none_or(|c| older(c, &version));

  // Node.js: with a new release, unless the one here is already the same version.
  let want = node_version(&bundled.node).ok_or("This app’s copy of Node.js doesn’t run. Reinstall the app.")?;
  let have = node_version(&layout.node);
  if have.is_none() || (replace && have.as_deref() != Some(want.as_str())) {
    let fresh = layout.data.join("node.new");
    let _ = std::fs::remove_dir_all(&fresh);
    let dest = fresh.join(layout.node.strip_prefix(layout.data.join("node")).unwrap_or(Path::new("node")));
    std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| fail("copy Node.js", e))?;
    std::fs::copy(&bundled.node, &dest).map_err(|e| fail("copy Node.js", e))?;
    let old = layout.data.join("node");
    let _ = std::fs::remove_dir_all(&old);
    std::fs::rename(&fresh, &old).map_err(|e| fail("copy Node.js", e))?;
  }

  // The release, in app-<version>.
  if replace {
    let prev =
      std::fs::read_link(&layout.app).ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()));
    let dir = layout.data.join(format!("app-{version}"));
    let fresh = layout.data.join(format!("app-{version}.new"));
    let _ = std::fs::remove_dir_all(&fresh);
    copy_dir(&bundled.payload, &fresh).map_err(|e| fail("copy Hildegard", e))?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&fresh, &dir).map_err(|e| fail("copy Hildegard", e))?;
    link_app(layout, &version).map_err(|e| fail("link the app folder", e))?;
    if let Ok(entries) = std::fs::read_dir(&layout.data) {
      for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let keep = name == format!("app-{version}") || Some(&name) == prev.as_ref() || name == "app";
        if name.starts_with("app-") && !keep && e.path().is_dir() {
          let _ = std::fs::remove_dir_all(e.path());
        }
      }
    }
    steps.push(Step {
      id: "app".into(),
      title: "Put Hildegard in its folder".into(),
      status: "done".into(),
      detail: format!("Hildegard {version} is in {}.", layout.data.display()),
      command: None,
    });
  }

  // The `hildegard` command, for the terminal and for AI apps.
  let text = launcher_text(layout);
  if std::fs::read_to_string(&layout.launcher).ok().as_deref() != Some(text.as_str()) {
    let bin = layout.launcher.parent().unwrap();
    std::fs::create_dir_all(bin).map_err(|e| fail("add the hildegard command", e))?;
    std::fs::write(&layout.launcher, &text).map_err(|e| fail("add the hildegard command", e))?;
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let _ = std::fs::set_permissions(&layout.launcher, std::fs::Permissions::from_mode(0o755));
    }
    #[cfg(windows)]
    add_to_path(bin);
    steps.push(Step {
      id: "command".into(),
      title: "Add the hildegard command".into(),
      status: "done".into(),
      detail: format!("It’s in {}.", bin.display()),
      command: None,
    });
  }
  Ok(steps)
}

/// Whether version `a` comes before `b`, comparing their numbers (0.1.9 before 0.1.10).
pub fn older(a: &str, b: &str) -> bool {
  let nums = |v: &str| -> Vec<u64> { v.split(['.', '-']).map_while(|p| p.parse().ok()).collect() };
  nums(a) < nums(b)
}

/// Reads the CLI's `install --events` output: a line of JSON per step or log line, then the result.
pub fn parse_line(line: &str) -> Option<Event> {
  let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
  if let Some(step) = v.get("step") {
    return serde_json::from_value(step.clone()).ok().map(|step| Event::Step { step });
  }
  v.get("log").and_then(|l| l.as_str()).map(|l| Event::Log { line: l.to_owned() })
}

/// Runs `hildegard install --yes --events`, passing each step and log line on as it comes.
pub fn run(
  layout: &Layout,
  cpu: bool,
  running: &Arc<Mutex<Option<Child>>>,
  on_event: impl Fn(Event),
) -> Result<Outcome, String> {
  let mut cmd = Command::new(&layout.node);
  cmd
    .arg(&layout.entry)
    .args(["install", "--yes", "--events"])
    .args(if cpu { &["--cpu"][..] } else { &[] })
    .args(["--data"])
    .arg(&layout.data)
    .env("HILDEGARD_HOME", &layout.data)
    .env("HILDEGARD_ENTRY", &layout.entry)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  no_console(&mut cmd);
  let mut child = cmd.spawn().map_err(|e| format!("Couldn’t run the installer: {e}"))?;
  let stdout = child.stdout.take().unwrap();
  let mut stderr = child.stderr.take().unwrap();
  *running.lock().unwrap() = Some(child);
  let errors = std::thread::spawn(move || {
    let mut s = String::new();
    let _ = stderr.read_to_string(&mut s);
    s
  });

  let mut rest = String::new();
  for line in BufReader::new(stdout).lines().map_while(Result::ok) {
    match parse_line(&line) {
      Some(e) => on_event(e),
      None => {
        rest.push_str(&line);
        rest.push('\n');
      }
    }
  }
  let status = running.lock().unwrap().take().map(|mut c| c.wait());
  let errors = errors.join().unwrap_or_default();
  match serde_json::from_str::<Outcome>(rest.trim()) {
    Ok(o) => Ok(o),
    Err(_) => {
      let why = errors.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("it gave no reason").to_owned();
      match status {
        Some(Ok(s)) if s.success() => Err(format!("The installer finished without saying how: {why}")),
        None => Err("The install was stopped.".into()),
        _ => Err(format!("The installer stopped: {why}")),
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::paths::Env;

  #[test]
  fn reads_steps_and_log_lines_and_leaves_the_result() {
    assert_eq!(
      parse_line(r#"{"step":{"id":"uv","title":"Get uv","status":"done","detail":"Installed uv 0.9."}}"#),
      Some(Event::Step {
        step: Step {
          id: "uv".into(),
          title: "Get uv".into(),
          status: "done".into(),
          detail: "Installed uv 0.9.".into(),
          command: None
        }
      })
    );
    assert_eq!(parse_line(r#"{"log":"Downloading torch"}"#), Some(Event::Log { line: "Downloading torch".into() }));
    assert_eq!(parse_line("{"), None);
    assert_eq!(parse_line(r#"  "ok": true,"#), None);
    let o: Outcome = serde_json::from_str(
      r#"{"ok":false,"needsOwner":true,"steps":[{"id":"check","title":"Check the GPU works","status":"needs-owner","detail":"Update the driver.","command":"nvidia-smi"}],"message":"x","url":"http://127.0.0.1:7341"}"#,
    )
    .unwrap();
    assert!(o.needs_owner && !o.ok);
    assert_eq!(o.steps[0].command.as_deref(), Some("nvidia-smi"));
  }

  #[test]
  fn compares_versions_by_their_numbers() {
    assert!(older("0.1.9", "0.1.10"));
    assert!(older("0.1.0", "1.0.0"));
    assert!(!older("0.2.0", "0.1.10"));
    assert!(!older("0.1.0", "0.1.0"));
  }

  // Paths join with the host's separator, so a Linux layout only reads right on a Unix host.
  #[cfg(unix)]
  #[test]
  fn the_launcher_matches_install_sh() {
    let env: Env = &|k: &str| (k == "HOME").then(|| "/home/ann".to_owned());
    let l = Layout::new(Os::Linux, env);
    let text = launcher_text(&l);
    assert!(text.starts_with("#!/bin/sh\nexport HILDEGARD_HOME=\"/home/ann/.local/share/hildegard\"\n"));
    assert!(text.contains("exec \"/home/ann/.local/share/hildegard/node/bin/node\" \"/home/ann/.local/share/hildegard/app/hildegard.mjs\" \"$@\"\n"));
  }

  #[cfg(unix)]
  #[test]
  fn lays_down_node_the_release_and_the_command_and_is_safe_to_repeat() {
    let root = std::env::temp_dir().join(format!("hg-desktop-lay-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let payload = root.join("payload");
    std::fs::create_dir_all(payload.join("studio")).unwrap();
    std::fs::write(payload.join("package.json"), r#"{"version":"9.9.9"}"#).unwrap();
    std::fs::write(payload.join("hildegard.mjs"), "// hildegard").unwrap();
    std::fs::write(payload.join("studio").join("index.html"), "<!doctype html>").unwrap();
    // Stands in for Node.js: anything that prints a version.
    let node = root.join("node");
    std::fs::write(&node, "#!/bin/sh\necho v24.21.0\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
    let home = root.join("home");
    let h = home.to_str().unwrap().to_owned();
    let data = root.join("data");
    let d = data.to_str().unwrap().to_owned();
    let env = move |k: &str| match k {
      "HOME" => Some(h.clone()),
      "HILDEGARD_HOME" => Some(d.clone()),
      _ => None,
    };
    let layout = Layout::new(Os::Linux, &env);
    let bundled = Bundled { node, payload };
    // An older version, which stays as the one to go back to, and one older still, which goes.
    std::fs::create_dir_all(data.join("app-0.0.1")).unwrap();
    std::fs::create_dir_all(data.join("app-0.0.2")).unwrap();
    std::fs::write(data.join("app-0.0.2").join("package.json"), r#"{"version":"0.0.2"}"#).unwrap();
    std::os::unix::fs::symlink("app-0.0.2", data.join("app")).unwrap();

    let first = lay_down(&bundled, &layout).unwrap();
    assert_eq!(first.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["app", "command"]);
    assert!(layout.has_cli());
    assert_eq!(layout.cli_version().as_deref(), Some("9.9.9"));
    assert_eq!(std::fs::read_link(&layout.app).unwrap(), PathBuf::from("app-9.9.9"));
    assert!(data.join("app").join("studio").join("index.html").is_file());
    assert!(data.join("app-0.0.2").is_dir());
    assert!(!data.join("app-0.0.1").exists());
    assert_eq!(std::fs::read_to_string(&layout.launcher).unwrap(), launcher_text(&layout));
    let mode = std::fs::metadata(&layout.launcher).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o755);

    assert!(lay_down(&bundled, &layout).unwrap().is_empty());

    // A newer Hildegard from the one-line installer stays as it is.
    std::fs::create_dir_all(data.join("app-10.0.0")).unwrap();
    std::fs::write(data.join("app-10.0.0").join("package.json"), r#"{"version":"10.0.0"}"#).unwrap();
    std::fs::write(data.join("app-10.0.0").join("hildegard.mjs"), "// newer").unwrap();
    std::fs::remove_file(&layout.app).unwrap();
    std::os::unix::fs::symlink("app-10.0.0", &layout.app).unwrap();
    assert!(lay_down(&bundled, &layout).unwrap().is_empty());
    assert_eq!(layout.cli_version().as_deref(), Some("10.0.0"));
    std::fs::remove_dir_all(&root).unwrap();
  }
}
