// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Hildegard in the bar: a ring that fills while a take renders, and a panel with what's rendering, what just
// finished, and buttons to start, stop and open the Studio. Everything comes from bin/hildegard-omarchy, which
// only talks to Hildegard on 127.0.0.1.
Panel {
  id: root
  moduleName: "io.github.baney75.hildegard"
  ipcTarget: "io.github.baney75.hildegard"
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  readonly property string cli: decodeURIComponent(String(Qt.resolvedUrl("bin/hildegard-omarchy")).replace(/^file:\/\//, ""))
  readonly property color fg: bar ? bar.foreground : Color.foreground
  readonly property color bg: Color.popups.background
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color accent: Color.accent
  readonly property string font: bar ? bar.fontFamily : Style.font.family

  property var snap: null
  property string mark: Model.mark(snap)
  property string problem: ""
  property string busyVerb: ""

  // ── Talking to the backend ──────────────────────────────────────────────────────────────────────────────
  function refresh() {
    if (!poll.running) poll.running = true
  }
  function polled(code, text) {
    if (code !== 0) return
    try {
      const next = JSON.parse(text)
      // A notification for each take that finished since the last look, unless the panel is open to see it.
      if (!root.opened)
        Model.finished(snap, next).forEach(function(t) {
          Quickshell.execDetached([cli, "notify", t.status === "done" ? "Take ready" : "Take failed", t.title, Model.takeRoute(t)])
        })
      snap = next
    } catch (e) {}
  }
  Process {
    id: poll
    command: ["timeout", "--kill-after=2", "10", root.cli, "snapshot"]
    stdout: StdioCollector { id: pollOut; waitForEnd: true }
    onExited: function(code) { root.polled(code, pollOut.text) }
  }

  function act(id) {
    problem = ""
    switch (id) {
    case "studio": Quickshell.execDetached([cli, "open"]); root.close(); return
    case "queue": Quickshell.execDetached([cli, "open", "#/queue"]); root.close(); return
    case "agents": Quickshell.execDetached([cli, "open", "#/agents"]); root.close(); return
    case "setup": Quickshell.execDetached([cli, "setup"]); root.close(); return
    }
    if (verb.running) return
    busyVerb = id
    verb.command = ["timeout", "--kill-after=5", "120", cli, id]
    verb.running = true
  }
  Process {
    id: verb
    stderr: StdioCollector { id: verbErr; waitForEnd: true }
    onExited: function(code) {
      if (code !== 0) {
        const line = (verbErr.text || "").split("\n").filter(function(l) { return l.indexOf("hildegard: ") === 0 }).pop()
        root.problem = code === 124 || code === 137 ? "That took too long; try again." : line ? line.slice(11) : "That didn't work."
      }
      root.busyVerb = ""
      root.refresh()
    }
  }

  Timer {
    interval: root.mark === "busy" ? 1500 : root.opened ? 3000 : 15000
    running: true; repeat: true; triggeredOnStart: true
    onTriggered: root.refresh()
  }
  onOpenedChanged: if (opened) refresh(); else problem = ""

  // ── The bar mark: an aperture ring; it fills as the current take renders ─────────────────────────────────
  BarIconButton {
    id: button
    objectName: "hildegard-mark"
    anchors.fill: parent
    bar: root.bar
    tooltipText: "Hildegard · " + Model.status(root.snap)
    onPressed: root.toggle()
    iconComponent: Component {
      Item {
        implicitWidth: Style.space(14)
        implicitHeight: Style.space(14)
        Canvas {
          id: ring
          anchors.fill: parent
          readonly property real value: root.snap && root.snap.current ? root.snap.current.progress : 0
          readonly property string state_: root.mark
          onValueChanged: requestPaint()
          onState_Changed: requestPaint()
          onPaint: {
            var c = getContext("2d")
            var r = Math.min(width, height) / 2 - 1.5
            c.reset()
            c.lineWidth = 1.5
            c.strokeStyle = root.mark === "failed" ? root.urgent : Util.alpha(root.fg, root.mark === "off" ? 0.35 : 0.8)
            c.beginPath(); c.arc(width / 2, height / 2, r, 0, Math.PI * 2); c.stroke()
            if (root.mark === "busy") {
              c.strokeStyle = root.accent
              c.lineWidth = 2
              c.beginPath(); c.arc(width / 2, height / 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.04, value)); c.stroke()
            }
            c.fillStyle = root.mark === "failed" ? root.urgent : root.mark === "off" ? Util.alpha(root.fg, 0.35) : root.fg
            c.beginPath(); c.arc(width / 2, height / 2, r * 0.32, 0, Math.PI * 2); c.fill()
          }
        }
      }
    }
  }

  // ── The panel ───────────────────────────────────────────────────────────────────────────────────────────
  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keys
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(body.implicitHeight, panel.screen ? panel.screen.height - Style.space(96) : 0)

    Rectangle { anchors.fill: parent; color: root.bg }
    Item {
      id: keys
      anchors.fill: parent
      focus: true
      Keys.onEscapePressed: root.close()
      Keys.onReturnPressed: { var a = Model.actions(root.snap); if (a.length) root.act(a[0].id) }

      Column {
        id: body
        width: parent.width
        spacing: Style.space(10)

        Column {
          width: parent.width
          spacing: Style.space(2)
          Text {
            text: "Hildegard"
            color: root.fg
            font.family: root.font
            font.pixelSize: Style.font.title
            font.bold: true
          }
          Text {
            width: parent.width
            text: Model.status(root.snap)
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: root.mark === "failed" ? root.urgent : Qt.darker(root.fg, 1.3)
            font.family: root.font
            font.pixelSize: Style.font.bodySmall
          }
        }

        // What's rendering now
        Column {
          width: parent.width
          spacing: Style.space(6)
          visible: !!(root.snap && root.snap.current)
          PanelSectionHeader { text: "Rendering"; foreground: root.fg; fontFamily: root.font }
          Text {
            width: parent.width
            text: root.snap && root.snap.current ? root.snap.current.title : ""
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.fg
            font.family: root.font
            font.pixelSize: Style.font.body
          }
          Rectangle {
            width: parent.width
            height: Style.space(4)
            radius: height / 2
            color: Util.alpha(root.fg, 0.15)
            Rectangle {
              width: parent.width * Model.percent(root.snap && root.snap.current ? root.snap.current.progress : 0) / 100
              height: parent.height
              radius: parent.radius
              color: root.accent
              Behavior on width { NumberAnimation { duration: 400; easing.type: Easing.OutCubic } }
            }
          }
        }

        // What just finished
        Column {
          width: parent.width
          spacing: Style.space(2)
          visible: !!(root.snap && root.snap.recent && root.snap.recent.length)
          PanelSectionHeader { text: "Recent takes"; foreground: root.fg; fontFamily: root.font }
          Repeater {
            model: root.snap && root.snap.recent ? root.snap.recent : []
            Button {
              required property var modelData
              width: body.width
              leftAlign: true
              text: modelData.title + (modelData.status === "failed" ? " · failed" : "")
              tooltipText: Model.ago(modelData.at)
              foreground: modelData.status === "failed" ? root.urgent : root.fg
              fontFamily: root.font
              focusable: true
              onClicked: { Quickshell.execDetached([root.cli, "open", Model.takeRoute(modelData)]); root.close() }
            }
          }
        }

        Text {
          width: parent.width
          visible: root.problem !== ""
          text: root.problem
          textFormat: Text.PlainText
          wrapMode: Text.Wrap
          color: root.urgent
          font.family: root.font
          font.pixelSize: Style.font.bodySmall
        }

        Flow {
          width: parent.width
          spacing: Style.space(6)
          Repeater {
            model: Model.actions(root.snap)
            Button {
              required property var modelData
              text: root.busyVerb === modelData.id ? (modelData.id === "stop" ? "Stopping…" : "Starting…") : modelData.label
              selected: modelData.primary
              bordered: true
              focusable: true
              enabled: root.busyVerb === ""
              fontFamily: root.font
              foreground: root.fg
              onClicked: root.act(modelData.id)
            }
          }
        }
      }
    }
  }
}
