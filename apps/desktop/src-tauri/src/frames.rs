// SPDX-License-Identifier: AGPL-3.0-only
//! Windows only: the same rule as `browse::navigates` for every document a site's window loads, its page's and every
//! frame's. wry reports main-frame navigations only on Windows, so without this a frame from any host would show
//! inside the window, Google's sign-in frames included.
//!
//! WebView2 raises WebResourceRequested before it asks the network. A document `browse::document_allowed` refuses is
//! answered here with an empty 403 and never reaches its server; an allowed one passes untouched. Nothing else is
//! done with the webview: no script, no message, no other handler.
//!
//! The filter is added with `AddWebResourceRequestedFilterWithRequestSourceKinds` (ICoreWebView2_22, WebView2
//! 1.0.2365): the older `AddWebResourceRequestedFilter` raises the event only for the main frame and frames from its
//! own origin. https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/icorewebview2#addwebresourcerequestedfilter
//! A WebView2 too old to have it can't keep frames out, so the site's window doesn't open on it.

use std::sync::mpsc;
use std::time::Duration;

use tauri::{Url, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
  ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
  COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT,
};
use webview2_com::{take_pwstr, WebResourceRequestedEventHandler};
use windows_core::{Interface, HSTRING, PWSTR};

use crate::browse::{self, Site};

/// Adds the document check to a site's window, which shows `about:blank` until then, and then goes to `url`: the
/// check is in place before the site's first page asks for a frame. An error means the window must not be shown.
pub fn guard(window: &WebviewWindow, site: &Site, url: &Url) -> Result<(), String> {
  let (tx, rx) = mpsc::channel();
  let (site, url) = (site.clone(), url.clone());
  window
    .with_webview(move |platform| {
      let added = unsafe { add(&platform, site, &url) };
      let _ = tx.send(added.map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;
  rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "the window didn’t answer".to_owned())?
}

unsafe fn add(platform: &tauri::webview::PlatformWebview, site: Site, url: &Url) -> windows_core::Result<()> {
  unsafe {
    let webview = platform.controller().CoreWebView2()?;
    let environment = platform.environment();
    let frames: ICoreWebView2_22 = webview.cast()?;
    frames.AddWebResourceRequestedFilterWithRequestSourceKinds(
      &HSTRING::from("*"),
      COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
      COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT,
    )?;
    let mut token = 0i64;
    webview.add_WebResourceRequested(
      &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let allowed = || -> windows_core::Result<bool> {
          // wry's own filters (its custom protocols) raise this event too; only documents are decided here.
          let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
          args.ResourceContext(&mut context)?;
          if context != COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT {
            return Ok(true);
          }
          let mut uri = PWSTR::null();
          args.Request()?.Uri(&mut uri)?;
          Ok(browse::document_allowed(&site, &take_pwstr(uri)))
        };
        // A request WebView2 can't describe is refused too.
        if !allowed().unwrap_or(false) {
          let denied =
            environment.CreateWebResourceResponse(None, 403, &HSTRING::from("Forbidden"), &HSTRING::new())?;
          args.SetResponse(&denied)?;
        }
        Ok(())
      })),
      &mut token,
    )?;
    webview.Navigate(&HSTRING::from(url.as_str()))
  }
}
