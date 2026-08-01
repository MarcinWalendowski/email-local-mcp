import Foundation

struct Account: Decodable {
    let email: String
    let displayName: String?
    let `default`: Bool
    let readOnly: Bool
    let credentialPresent: Bool
}

/// Talks to the engine's bearer-token-gated admin API on 127.0.0.1.
final class AdminClient {
    struct AdminError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private func request(
        _ path: String,
        method: String,
        body: [String: Any]? = nil
    ) async throws -> Data {
        guard let cfg = ServerConfig.load(), let origin = cfg.origin else {
            throw AdminError(message: "Server not ready yet (no server.json).")
        }
        var req = URLRequest(url: origin.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("Bearer \(cfg.token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw AdminError(message: "No response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw AdminError(message: msg ?? "Request failed (\(http.statusCode))")
        }
        return data
    }

    func listAccounts() async throws -> [Account] {
        struct R: Decodable { let accounts: [Account] }
        let data = try await request("admin/accounts", method: "GET")
        return try JSONDecoder().decode(R.self, from: data).accounts
    }

    func addAccount(
        email: String,
        appPassword: String,
        displayName: String?,
        makeDefault: Bool,
        readOnly: Bool,
        provider: String,
        connection: [String: Any]?
    ) async throws {
        var body: [String: Any] = [
            "email": email,
            "appPassword": appPassword,
            "default": makeDefault,
            "readOnly": readOnly,
            "provider": provider,
        ]
        if let displayName, !displayName.isEmpty { body["displayName"] = displayName }
        if let connection { body["connection"] = connection }
        _ = try await request("admin/accounts", method: "POST", body: body)
    }

    func removeAccount(email: String) async throws {
        let enc = email.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? email
        _ = try await request("admin/accounts/\(enc)", method: "DELETE")
    }

    func install(all: Bool) async throws -> [String] {
        struct R: Decodable { let lines: [String] }
        let data = try await request("admin/install", method: "POST", body: ["all": all])
        return try JSONDecoder().decode(R.self, from: data).lines
    }
}
