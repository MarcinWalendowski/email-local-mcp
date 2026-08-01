import Foundation

/// Supervises the Node engine child process (`node dist/index.js --http`),
/// restarting it if it dies. The engine owns the Keychain + HTTP server.
@MainActor
final class EngineSupervisor {
    private let nodePath: String
    private let entryPath: String
    private var process: Process?
    private var stopping = false

    private(set) var running = false
    var onStateChange: (@MainActor () -> Void)?

    init(nodePath: String, entryPath: String) {
        self.nodePath = nodePath
        self.entryPath = entryPath
    }

    func start() {
        guard process == nil else { return }
        stopping = false
        launch()
    }

    private func launch() {
        guard !stopping, process == nil else { return }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        p.arguments = [entryPath, "--http"]

        // GUI apps have a minimal environment — ensure HOME is present so the
        // engine can find ~/.email-local-mcp and the Keychain.
        var env = ProcessInfo.processInfo.environment
        env["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path
        p.environment = env

        // Process calls this on a background thread — hop to the main actor.
        p.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.process = nil
                self.running = false
                self.onStateChange?()
                self.scheduleRestart()
            }
        }

        do {
            try p.run()
            process = p
            running = true
        } catch {
            running = false
        }
        onStateChange?()
    }

    private func scheduleRestart() {
        guard !stopping else { return }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, !self.stopping else { return }
            self.launch()
        }
    }

    func stop() {
        stopping = true
        process?.terminate()
        process = nil
        running = false
        onStateChange?()
    }
}
