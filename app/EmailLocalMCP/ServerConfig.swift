import Foundation

/// Mirrors ~/.email-local-mcp/server.json written by the Node engine on startup.
struct ServerConfig: Codable {
    let port: Int
    let token: String
    let url: String

    static var path: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".email-local-mcp/server.json")
    }

    static func load() -> ServerConfig? {
        guard let data = try? Data(contentsOf: path) else { return nil }
        return try? JSONDecoder().decode(ServerConfig.self, from: data)
    }

    /// The origin (scheme://host:port) with the /mcp path stripped, for admin calls.
    var origin: URL? {
        guard let mcp = URL(string: url) else { return nil }
        var comps = URLComponents()
        comps.scheme = mcp.scheme
        comps.host = mcp.host
        comps.port = mcp.port
        return comps.url
    }
}
