import Foundation

/// Where each provider hides its App Passwords, and what has to be true first.
///
/// `url` is only set where the deep link is known-good. Everywhere else the route is
/// described in words and the agent (or the user) navigates: a guessed link that 404s is
/// worse than no link, and provider settings pages move.
struct ProviderGuide {
    /// Display name, e.g. "Gmail".
    let label: String
    /// Page to open for the manual path; nil when there's nothing universal to open.
    let url: URL?
    /// Human-readable route to the page, used inside the prompt.
    let path: String
    /// Precondition to state up front.
    let precondition: String
}

/// Builds the one-paste task handed to the user's own agent: create the App Password,
/// then register the account through the `add_account` MCP tool, so nothing has to come
/// back through the user by hand.
///
/// Pure and AppKit-free so it can be exercised without opening the window — see
/// `app/BUILD.md` for the one-liner that prints every provider's prompt.
enum AppPasswordPrompt {
    static func guide(for provider: String) -> ProviderGuide {
        switch provider {
        case "icloud":
            return ProviderGuide(
                label: "iCloud",
                url: URL(string: "https://account.apple.com"),
                path: "https://account.apple.com → Sign-In and Security → App-Specific Passwords",
                precondition: "Two-factor authentication must already be on for the Apple Account."
            )
        case "fastmail":
            return ProviderGuide(
                label: "Fastmail",
                url: URL(string: "https://app.fastmail.com/"),
                path: "Fastmail → Settings → Password & Security → App Passwords",
                precondition: "Scope the app password to IMAP + SMTP."
            )
        case "imap":
            return ProviderGuide(
                label: "IMAP",
                url: nil,
                path: "my mail host's control panel; look for “App Passwords” or similar",
                precondition: "Some hosts also require enabling IMAP access explicitly."
            )
        default:
            return ProviderGuide(
                label: "Gmail",
                url: URL(string: "https://myaccount.google.com/apppasswords"),
                path: "https://myaccount.google.com/apppasswords",
                precondition: "2-Step Verification must already be on."
            )
        }
    }

    /// Two rules in here earn their place.
    ///
    /// The happy path forbids echoing the password: an agent that *has* `add_account`
    /// otherwise tends to print it back "to confirm", which is the leak the tool call was
    /// supposed to avoid. And the reply-with-the-password fallback is strictly for agents
    /// missing the tool or a browser — a fresh claude.ai chat has neither, while the
    /// user's own Claude Code has both.
    static func text(provider: String, email: String, imapHost: String = "", smtpHost: String = "") -> String {
        let g = guide(for: provider)
        let who = email.isEmpty ? "<my \(g.label) address>" : email

        var args = [
            "email: \"\(who)\"",
            "appPassword: \"<the password you just created, spaces stripped>\"",
            "provider: \"\(provider)\"",
        ]
        if provider == "imap" {
            args.append("imapHost: \"\(imapHost.isEmpty ? "<imap.host.tld>" : imapHost)\"")
            args.append("smtpHost: \"\(smtpHost.isEmpty ? "<smtp.host.tld>" : smtpHost)\"")
        }
        let argList = args.map { "       \($0)" }.joined(separator: "\n")

        return """
        Add my \(g.label) account \(who) to Email Local MCP for me, end to end.

        1. Create an App Password (a per-app credential, never my normal password):
           - Go to \(g.path)
           - \(g.precondition)
           - Sign in as \(who) if asked, create an app password named "Email Local MCP", and copy it.

        2. Register it: call the `add_account` tool on my email-local-mcp MCP server with:
        \(argList)
           Then call `list_accounts` to confirm it's connected, and tell me it worked.
           Do not print, echo, or save the password anywhere: the tool call is the only
           place it belongs. The tool stores it in my macOS Keychain.

        If you don't have the email-local-mcp MCP server, or you can't open a browser, don't
        guess, say so, and reply with just the password on its own line. I'll paste it in.

        This password grants full access to the mailbox. Treat it as a secret.
        """
    }
}
