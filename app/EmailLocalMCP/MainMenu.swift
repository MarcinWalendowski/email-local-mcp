import AppKit

/// A menu-bar-only (`.accessory` / LSUIElement) app gets no menu bar from a nib, and
/// this one never built one in code either. The catch: the standard editing shortcuts
/// (Cmd-C / Cmd-V / Cmd-X / Cmd-A / Cmd-Z) are dispatched by the **Edit menu's key
/// equivalents**, not by the text field itself, so with no main menu every `NSTextField`
/// silently ignores paste. Installing a main menu with a standard Edit menu restores them.
///
/// The Edit items use the standard first-responder selectors with `target == nil`, so
/// AppKit walks the responder chain and delivers them to the focused field's field editor.
/// When one of the app's windows is key, macOS shows this menu and honours its shortcuts
/// even for an accessory app.
enum MainMenu {
    static func build(appName: String) -> NSMenu {
        let mainMenu = NSMenu()
        // First menu is always the app menu (AppKit shows the process name as its title).
        mainMenu.addItem(submenu: appMenu(appName: appName))
        mainMenu.addItem(submenu: editMenu())
        return mainMenu
    }

    private static func appMenu(appName: String) -> NSMenu {
        let menu = NSMenu()
        menu.addItem(makeItem("Hide \(appName)", #selector(NSApplication.hide(_:)), "h"))
        menu.addItem(makeItem("Hide Others", #selector(NSApplication.hideOtherApplications(_:)),
                              "h", [.command, .option]))
        menu.addItem(makeItem("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""))
        menu.addItem(.separator())
        menu.addItem(makeItem("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"))
        return menu
    }

    /// The reason this file exists: Cut / Copy / Paste / Select All / Undo key equivalents.
    private static func editMenu() -> NSMenu {
        let menu = NSMenu(title: "Edit")
        menu.addItem(makeItem("Undo", Selector(("undo:")), "z"))
        menu.addItem(makeItem("Redo", Selector(("redo:")), "z", [.command, .shift]))
        menu.addItem(.separator())
        menu.addItem(makeItem("Cut", #selector(NSText.cut(_:)), "x"))
        menu.addItem(makeItem("Copy", #selector(NSText.copy(_:)), "c"))
        menu.addItem(makeItem("Paste", #selector(NSText.paste(_:)), "v"))
        menu.addItem(makeItem("Delete", #selector(NSText.delete(_:)), ""))
        menu.addItem(makeItem("Select All", #selector(NSText.selectAll(_:)), "a"))
        return menu
    }

    /// Item with `target == nil` so the action is routed through the responder chain
    /// (to the focused field editor for the editing commands, to NSApp for hide/quit).
    private static func makeItem(_ title: String, _ action: Selector, _ key: String,
                                 _ mask: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        if !key.isEmpty { item.keyEquivalentModifierMask = mask }
        return item
    }
}

private extension NSMenu {
    func addItem(submenu: NSMenu) {
        let holder = NSMenuItem()
        holder.submenu = submenu
        addItem(holder)
    }
}
