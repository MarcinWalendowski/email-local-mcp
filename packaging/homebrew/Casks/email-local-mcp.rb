# Cask: the macOS menu-bar app. For the CLI and MCP server, see ../Formula/.
#
# Not submitted to homebrew-cask, and not pending there either. homebrew-cask
# requires apps to be signed and notarized by an identified developer; this one
# is ad-hoc signed, which is exactly why the README has an "Open Anyway" step.
# A personal tap has no such gate. If a Developer ID release ever ships, the
# upstream cask becomes worth filing and this file is what gets submitted.
#
# The token is the same as the formula's on purpose, because that is the name
# people will type. Homebrew resolves a bare `brew install email-local-mcp` to
# the FORMULA; the cask needs `--cask` explicitly. Both spellings are in the
# README so nobody has to discover that.
#
# Source of truth is packaging/homebrew/ in the main repo; scripts/brew-sync.sh
# stamps version + sha256 from the release asset and copies it into the tap.

cask "email-local-mcp" do
  version "0.2.0"
  sha256 "55c1aefe2da13f5ded461029a0cc2dc9e3a8fb5559f5ca8858e0e9772aa1828a"

  url "https://github.com/MarcinWalendowski/email-local-mcp/releases/download/v#{version}/Email-Local-MCP-#{version}-universal.dmg",
      verified: "github.com/MarcinWalendowski/email-local-mcp/"
  name "Email Local MCP"
  desc "Connect every email account to your AI agent over IMAP/SMTP, locally"
  homepage "https://github.com/MarcinWalendowski/email-local-mcp"

  # Sparkle owns updates: the app checks on launch, every 6 hours, and when the
  # menu opens, then installs silently. Without this, brew treats a
  # self-updated app as "outdated relative to the cask" and reinstalls the
  # pinned version over it on the next `brew upgrade`, silently downgrading a
  # user who did nothing wrong.
  auto_updates true

  # app/project.yml sets deploymentTarget macOS 13.0. The bare symbol is the
  # minimum-version form; the `">= :ventura"` string spelling is deprecated and
  # warns on every `brew tap`.
  depends_on macos: :ventura

  app "Email Local MCP.app"

  # zap, not uninstall: these are the user's own mail credentials and account
  # registry, so they go only on an explicit `brew uninstall --zap`.
  #
  # The Keychain entries are deliberately NOT listed. Homebrew's zap deletes
  # paths; the App Passwords and OAuth refresh tokens live in the login
  # Keychain under the services "email-local-mcp" and "email-local-mcp-oauth",
  # and a cask cannot remove those. caveats says so rather than leaving a user
  # believing zap took everything.
  zap trash: [
    "~/.email-local-mcp",
    "~/Library/Caches/com.lokilabs.EmailLocalMCP",
    "~/Library/Caches/com.lokilabs.EmailLocalMCP.ShipIt",
    "~/Library/Preferences/com.lokilabs.EmailLocalMCP.plist",
    "~/Library/Application Support/com.lokilabs.EmailLocalMCP",
    "~/Library/HTTPStorages/com.lokilabs.EmailLocalMCP",
  ]

  caveats do
    <<~EOS
      The app is ad-hoc signed and not yet notarized, so macOS blocks the first
      launch. Open System Settings > Privacy & Security, find the "Email Local
      MCP was blocked" notice and click Open Anyway. macOS remembers it.

      Credentials live in your login Keychain under the services
      "email-local-mcp" and "email-local-mcp-oauth". `brew uninstall --zap`
      cannot remove Keychain items; delete those in Keychain Access if you want
      every trace gone.
    EOS
  end
end
