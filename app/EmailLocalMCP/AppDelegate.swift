import AppKit
import Sparkle

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let admin = AdminClient()
    private var supervisor: EngineSupervisor?
    private var accounts: [Account] = []
    private var addWindow: AddAccountWindowController?
    private var updater: SPUStandardUpdaterController?
    private var lastBackgroundUpdateCheck: Date = .distantPast

    nonisolated override init() {
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Sparkle: checks for updates on launch and every SUScheduledCheckInterval,
        // downloading and installing them automatically (Info.plist keys).
        updater = SPUStandardUpdaterController(
            startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil
        )

        let nodeOverride = UserDefaults.standard.string(forKey: "nodePath")
        let engineOverride = UserDefaults.standard.string(forKey: "enginePath")
        if let node = NodeLocator.find(override: nodeOverride),
           let entry = EnginePaths.entry(override: engineOverride) {
            supervisor = EngineSupervisor(nodePath: node, entryPath: entry)
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(
            systemSymbolName: "envelope.fill",
            accessibilityDescription: "Email Local MCP"
        )

        supervisor?.onStateChange = { [weak self] in
            self?.rebuildMenu()
            self?.refreshAccounts()
        }
        supervisor?.start()

        rebuildMenu()
        refreshAccounts()

        // QA affordance: open the Add Account window straight away so UI passes
        // and screenshots don't require clicking through the menu-bar item.
        if ProcessInfo.processInfo.arguments.contains("--show-add-account") {
            addAccount()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        supervisor?.stop()
    }

    // Re-opening the running app (Finder / Spotlight) also checks for updates.
    func applicationShouldHandleReopen(_ sender: NSApplication,
                                       hasVisibleWindows: Bool) -> Bool {
        backgroundUpdateCheck()
        return true
    }

    // MARK: - Updates

    // Silent check, on top of Sparkle's launch + scheduled checks: fires when
    // the user "opens" the app (menu-bar click or app reopen). Background
    // checks show UI only when an update actually exists; throttled so
    // repeated clicks don't hammer the feed.
    private func backgroundUpdateCheck() {
        guard let updater = updater?.updater, !updater.sessionInProgress else { return }
        guard Date().timeIntervalSince(lastBackgroundUpdateCheck) > 15 * 60 else { return }
        lastBackgroundUpdateCheck = Date()
        updater.checkForUpdatesInBackground()
    }

    nonisolated func menuWillOpen(_ menu: NSMenu) {
        Task { @MainActor in self.backgroundUpdateCheck() }
    }

    // MARK: - Data

    private func refreshAccounts(retries: Int = 12) {
        Task {
            do {
                let list = try await admin.listAccounts()
                accounts = list
                rebuildMenu()
            } catch {
                // Server may still be starting up — retry briefly.
                if retries > 0 {
                    try? await Task.sleep(for: .milliseconds(500))
                    refreshAccounts(retries: retries - 1)
                }
            }
        }
    }

    // MARK: - Menu

    private func rebuildMenu() {
        let menu = NSMenu()
        menu.delegate = self

        let running = supervisor?.running ?? false
        let statusText = supervisor == nil
            ? "⚠︎ node / engine not found"
            : (running ? "● Server running · 127.0.0.1:8765" : "○ Server stopped")
        let statusRow = NSMenuItem(title: statusText, action: nil, keyEquivalent: "")
        statusRow.isEnabled = false
        menu.addItem(statusRow)

        if supervisor == nil {
            menu.addItem(item("How to set paths…", #selector(configurePaths)))
        }

        menu.addItem(.separator())

        if accounts.isEmpty {
            let none = NSMenuItem(title: "No accounts connected", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        } else {
            for account in accounts {
                let title = (account.default ? "★ " : "   ") + account.email
                    + (account.readOnly ? "  · read-only" : "")
                let row = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                let sub = NSMenu()
                let remove = item("Remove \(account.email)", #selector(removeAccount(_:)))
                remove.representedObject = account.email
                sub.addItem(remove)
                row.submenu = sub
                menu.addItem(row)
            }
        }

        menu.addItem(item("Add Account…", #selector(addAccount), key: "n"))
        menu.addItem(.separator())
        menu.addItem(item("Install into Agents", #selector(installAgents)))

        let login = item("Start at Login", #selector(toggleLogin))
        login.state = LoginItem.isEnabled ? .on : .off
        menu.addItem(login)

        menu.addItem(.separator())

        if let updater {
            let version = Bundle.main
                .object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
            let check = NSMenuItem(
                title: "Check for Updates… (v\(version))",
                action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)),
                keyEquivalent: ""
            )
            check.target = updater
            menu.addItem(check)
        }

        menu.addItem(item("Quit Email Local MCP", #selector(quit), key: "q"))

        statusItem.menu = menu
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    // MARK: - Actions

    @objc private func addAccount() {
        if addWindow == nil {
            addWindow = AddAccountWindowController(admin: admin) { [weak self] in
                self?.refreshAccounts()
            }
        }
        NSApp.activate(ignoringOtherApps: true)
        addWindow?.showWindow(nil)
        addWindow?.window?.makeKeyAndOrderFront(nil)
    }

    @objc private func removeAccount(_ sender: NSMenuItem) {
        guard let email = sender.representedObject as? String else { return }
        Task {
            try? await admin.removeAccount(email: email)
            refreshAccounts()
        }
    }

    @objc private func installAgents() {
        Task {
            do {
                let lines = try await admin.install(all: false)
                alert("Installed into agents", lines.joined(separator: "\n"))
            } catch {
                alert("Install failed", error.localizedDescription)
            }
        }
    }

    @objc private func toggleLogin() {
        do {
            try LoginItem.setEnabled(!LoginItem.isEnabled)
        } catch {
            alert("Couldn't change login item", error.localizedDescription)
        }
        rebuildMenu()
    }

    @objc private func configurePaths() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        alert(
            "Set node / engine paths",
            """
            Auto-detection failed. Set them in Terminal, then relaunch the app:

            defaults write com.lokilabs.EmailLocalMCP nodePath /opt/homebrew/bin/node
            defaults write com.lokilabs.EmailLocalMCP enginePath \(home)/loki-labs/email-local-mcp/dist/index.js
            """
        )
    }

    @objc private func quit() {
        supervisor?.stop()
        NSApp.terminate(nil)
    }

    private func alert(_ title: String, _ message: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        a.runModal()
    }
}
