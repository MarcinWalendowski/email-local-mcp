import AppKit

// Menu-bar-only app: no dock icon, no main window.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
// Give text fields a standard Edit menu so Cmd-C/V/X/A/Z work (an accessory app
// has no menu bar from a nib, and those shortcuts come from the menu, not the field).
app.mainMenu = MainMenu.build(appName: "Email Local MCP")
app.run()
