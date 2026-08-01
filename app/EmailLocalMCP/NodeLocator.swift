import Foundation

/// GUI apps don't inherit the shell PATH, so `which node` is unreliable.
/// Probe the common install locations plus an optional user override.
enum NodeLocator {
    static let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]

    static func find(override: String?) -> String? {
        let fm = FileManager.default
        if let o = override, !o.isEmpty, fm.isExecutableFile(atPath: o) { return o }

        // Runtime bundled inside the .app (Resources/engine/bin/node). Preferred
        // over any system Node so a downloaded app needs no prerequisites; the
        // user override above still wins for developers pointing at their own.
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("engine/bin/node").path,
           fm.isExecutableFile(atPath: bundled) { return bundled }

        for c in candidates where fm.isExecutableFile(atPath: c) { return c }

        // nvm: newest installed version
        let nvm = fm.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node").path
        if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
            for v in versions.sorted().reversed() {
                let p = "\(nvm)/\(v)/bin/node"
                if fm.isExecutableFile(atPath: p) { return p }
            }
        }
        return nil
    }
}

/// Locate the engine entrypoint (dist/index.js) — bundled Resources, an
/// override, or the dev checkout.
enum EnginePaths {
    static func entry(override: String?) -> String? {
        let fm = FileManager.default
        if let o = override, !o.isEmpty, fm.fileExists(atPath: o) { return o }
        if let res = Bundle.main.resourceURL?.appendingPathComponent("engine/dist/index.js").path,
           fm.fileExists(atPath: res) { return res }
        let dev = fm.homeDirectoryForCurrentUser
            .appendingPathComponent("loki-labs/email-local-mcp/dist/index.js").path
        if fm.fileExists(atPath: dev) { return dev }
        return nil
    }
}
