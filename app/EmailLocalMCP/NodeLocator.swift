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
/// override, or a dev checkout.
///
/// The `enginePath` default is the only *reliable* way to point a dev build at
/// a checkout, because a clone can live anywhere. The candidate list below is a
/// convenience for the conventional spots and nothing more.
///
/// name-check: legacy-ok — names the retired path to say it is retired.
/// It used to be a single hardcoded `~/loki-labs/email-local-mcp/dist/index.js`
/// — one maintainer's workspace layout, under the old org name, at a directory
/// that did not exist even on that machine. So the "or the dev checkout" branch
/// had never once resolved, and the failure looked exactly like "no engine
/// found". Nothing here should encode whose machine it is.
/// name-check: /legacy-ok
enum EnginePaths {
    /// Conventional clone locations, relative to the user's home directory.
    private static let devCandidates = [
        "email-local-mcp",
        "src/email-local-mcp",
        "code/email-local-mcp",
        "Developer/email-local-mcp",
        "Projects/email-local-mcp",
    ]

    static func entry(override: String?) -> String? {
        let fm = FileManager.default
        if let o = override, !o.isEmpty, fm.fileExists(atPath: o) { return o }
        if let res = Bundle.main.resourceURL?.appendingPathComponent("engine/dist/index.js").path,
           fm.fileExists(atPath: res) { return res }
        let home = fm.homeDirectoryForCurrentUser
        for c in devCandidates {
            let p = home.appendingPathComponent("\(c)/dist/index.js").path
            if fm.fileExists(atPath: p) { return p }
        }
        return nil
    }
}
