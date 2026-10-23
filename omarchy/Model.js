.pragma library
// SPDX-License-Identifier: AGPL-3.0-only
// Hildegard's bar widget, as pure functions: a snapshot from bin/hildegard-omarchy in, what to show out.
// Widget.qml draws what these return; test/model-test.mjs checks them without a shell.

// The bar mark: off (not running), idle, busy (rendering), or failed (the engine has a problem).
function mark(s) {
  if (!s || !s.running) return "off"
  if (s.engine && (s.engine.problem || !s.engine.online)) return "failed"
  if (s.queue && (s.queue.running || s.queue.queued)) return "busy"
  return "idle"
}

function plural(n, one, many) {
  return n + " " + (n === 1 ? one : many)
}

// One line under the title: what Hildegard is doing now.
function status(s) {
  if (!s) return ""
  if (!s.installed) return "Not set up on this computer yet"
  if (!s.running) return "Not running"
  var e = s.engine || {}
  if (e.problem) return e.problem
  if (!e.online) return "Waiting for ComfyUI"
  var q = s.queue || {}
  if (q.running || q.queued) {
    var parts = []
    if (q.running) parts.push("Rendering " + plural(q.running, "take", "takes"))
    if (q.queued) parts.push(q.queued + " waiting")
    // Paired devices' renders are in those counts; say so, or a GPU busy with nothing of yours looks odd.
    var others = q.guests ? " · " + q.guests + " from " + (q.guests === 1 ? "another device" : "other devices") : ""
    return parts.join(", ") + others + (e.paused ? " · paused" : "")
  }
  if (e.paused) return "Paused"
  return "Ready" + (e.device ? " on " + e.device : "") + (e.fake ? " (stand-in GPU)" : "")
}

function percent(v) {
  return Math.max(0, Math.min(100, Math.round((v || 0) * 100)))
}

// The Studio route for a take: its film, opened at that take.
function takeRoute(t) {
  return t && t.projectId && t.id ? "#/film/" + t.projectId + "/take/" + t.id : ""
}

function ago(iso, now) {
  var t = Date.parse(iso || "")
  if (isNaN(t)) return ""
  var m = Math.round(((now || Date.now()) - t) / 60000)
  if (m < 1) return "just now"
  if (m < 60) return m + " min ago"
  var h = Math.round(m / 60)
  if (h < 24) return h + " h ago"
  return Math.round(h / 24) + " d ago"
}

// Takes that finished since the last snapshot, for a notification each: ones that were rendering or waiting
// before and are now done or failed. `before` is the previous snapshot.
function finished(before, now) {
  if (!before || !before.running || !now || !now.running) return []
  var seen = {}
  ;(before.recent || []).forEach(function (t) { seen[t.id] = true })
  var q = before.queue || {}
  if (!q.running && !q.queued) return []
  return (now.recent || []).filter(function (t) { return !seen[t.id] })
}

// The buttons the panel offers, in order. Each is { id, label, primary }.
function actions(s) {
  if (!s) return []
  if (!s.installed) return [{ id: "setup", label: "Set up Hildegard", primary: true }]
  if (!s.running) return [{ id: "start", label: "Start", primary: true }, { id: "setup", label: "Set up", primary: false }]
  var out = [{ id: "studio", label: "Open Studio", primary: true }]
  if (s.queue && (s.queue.running || s.queue.queued)) out.push({ id: "queue", label: "Queue", primary: false })
  out.push({ id: "agents", label: "AI apps", primary: false })
  out.push({ id: "stop", label: "Stop", primary: false })
  return out
}
