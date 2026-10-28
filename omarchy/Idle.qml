// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import Quickshell
import Quickshell.Wayland

// Tells Hildegard when you leave the computer and when you come back, through Wayland's idle notifications: Hyprland
// has no idle clock Hildegard could ask. Made by Widget.qml only while this computer shares its GPU only when it's
// free, and on its own so a shell without IdleMonitor still shows the widget.
IdleMonitor {
  id: idle
  property string cli: ""
  // As long as Hildegard waits after your last input elsewhere (AWAY_AFTER_MINUTES in the server's presence.ts).
  property int minutes: 3
  timeout: minutes * 60
  respectInhibitors: true
  onIsIdleChanged: if (cli) Quickshell.execDetached([cli, "presence", isIdle ? "away" : "back"])
}
