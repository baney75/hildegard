// SPDX-License-Identifier: AGPL-3.0-only
//! Talking to the Hildegard server on 127.0.0.1, and running it when nothing else does. Requests go straight to the
//! loopback socket with no proxy, so the server treats them as this computer, as it does the CLI's.

use std::fs::OpenOptions;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::paths::Layout;

fn agent(timeout: Duration) -> ureq::Agent {
  ureq::Agent::config_builder()
    .timeout_global(Some(timeout))
    .http_status_as_error(false)
    // Never through a proxy from the environment: this is 127.0.0.1.
    .proxy(None)
    .build()
    .into()
}

pub fn base(port: u16) -> String {
  format!("http://127.0.0.1:{port}")
}

/// The server's version when Hildegard answers on this port.
pub fn health(port: u16) -> Option<String> {
  let mut res = agent(Duration::from_millis(1500)).get(format!("{}/api/health", base(port))).call().ok()?;
  if res.status() != 200 {
    return None;
  }
  let v: Value = res.body_mut().read_json().ok()?;
  if v.get("ok")?.as_bool()? {
    v.get("version").and_then(|x| x.as_str()).map(str::to_owned).or(Some(String::new()))
  } else {
    None
  }
}

fn answer(mut res: ureq::http::Response<ureq::Body>) -> Result<Value, String> {
  let status = res.status().as_u16();
  let v: Value = res.body_mut().read_json().unwrap_or(Value::Null);
  if (200..300).contains(&status) {
    Ok(v)
  } else {
    Err(v.get("error").and_then(|e| e.as_str()).map(str::to_owned).unwrap_or_else(|| format!("HTTP {status}")))
  }
}

pub fn get(port: u16, path: &str) -> Result<Value, String> {
  let res = agent(Duration::from_secs(10)).get(format!("{}{path}", base(port))).call().map_err(|e| e.to_string())?;
  answer(res)
}

/// A request that changes something: the server wants `x-hildegard: 1` on those, as the Studio and CLI send.
pub fn post(port: u16, path: &str, body: Value) -> Result<Value, String> {
  let res = agent(Duration::from_secs(30))
    .post(format!("{}{path}", base(port)))
    .header("x-hildegard", "1")
    .send_json(body)
    .map_err(|e| e.to_string())?;
  answer(res)
}

/// Starts the server in the foreground of a child process, with no browser, writing to `logs/server.log` as
/// `hildegard start` does.
pub fn spawn(layout: &Layout, port: u16) -> std::io::Result<Child> {
  std::fs::create_dir_all(&layout.logs)?;
  let log = OpenOptions::new().create(true).append(true).open(layout.logs.join("server.log"))?;
  let mut cmd = Command::new(&layout.node);
  cmd
    .arg(&layout.entry)
    .args(["start", "--foreground", "--port", &port.to_string(), "--data"])
    .arg(&layout.data)
    .env("HILDEGARD_HOME", &layout.data)
    .env("HILDEGARD_ENTRY", &layout.entry)
    .stdin(Stdio::null())
    .stdout(log.try_clone()?)
    .stderr(log);
  no_console(&mut cmd);
  cmd.spawn()
}

/// No console window for a child on Windows.
pub fn no_console(cmd: &mut Command) {
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  #[cfg(not(windows))]
  let _ = cmd;
}

/// Waits for the server to answer, or for the child to give up.
pub fn wait_up(port: u16, child: &mut Child, timeout: Duration) -> Result<(), String> {
  let until = Instant::now() + timeout;
  while Instant::now() < until {
    if health(port).is_some() {
      return Ok(());
    }
    if let Ok(Some(status)) = child.try_wait() {
      return Err(format!("It stopped as it started ({status})."));
    }
    std::thread::sleep(Duration::from_millis(250));
  }
  Err(format!("It didn’t answer within {} seconds.", timeout.as_secs()))
}

/// Stops the server the way `hildegard stop` does, ComfyUI with it, then makes sure the child is gone.
pub fn stop(port: u16, child: Option<&mut Child>) {
  if health(port).is_some() {
    let _ = post(port, "/api/system/stop", Value::Object(Default::default()));
    let until = Instant::now() + Duration::from_secs(20);
    while Instant::now() < until && health(port).is_some() {
      std::thread::sleep(Duration::from_millis(250));
    }
  }
  if let Some(c) = child {
    let until = Instant::now() + Duration::from_secs(5);
    while Instant::now() < until {
      if !matches!(c.try_wait(), Ok(None)) {
        return;
      }
      std::thread::sleep(Duration::from_millis(100));
    }
    let _ = c.kill();
    let _ = c.wait();
  }
}

/// The log a person should look at when the server didn't start.
pub fn server_log(layout: &Layout) -> String {
  layout.logs.join("server.log").display().to_string()
}
