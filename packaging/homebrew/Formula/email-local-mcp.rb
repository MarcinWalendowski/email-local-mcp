# Formula: the CLI and MCP server. For the menu-bar app, see ../Casks/.
#
# This lives in a PERSONAL TAP rather than homebrew-core, and that is not a
# staging step on the way there. homebrew-core does not accept node CLIs without
# established usage, and it requires a formula's upstream to be notable rather
# than new. A tap needs no approval, is owned outright, and is what
# `brew install marcinwalendowski/tap/email-local-mcp` resolves against.
#
# Source of truth is packaging/homebrew/ in the main repo; scripts/brew-sync.sh
# stamps the version and checksum from the published artifacts and copies the
# file into the tap. Editing the copy in the tap directly is how the two drift.

class EmailLocalMcp < Formula
  desc "Connect every email account to your AI agent over IMAP/SMTP, locally"
  homepage "https://github.com/MarcinWalendowski/email-local-mcp"
  url "https://registry.npmjs.org/email-local-mcp/-/email-local-mcp-0.3.0.tgz"
  sha256 "e0e4e2a52c092e40f4851db3ea5d6a8c18866f12751a03ac59fea225c406e4b2"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      Register the server with your agent, then add a mailbox:

        claude mcp add email-local -- email-local-mcp
        email-local-mcp add you@example.com --default

      Credentials go to the login Keychain, never to a file in this prefix.
      The first read of each account raises a Keychain prompt once; choose
      "Always Allow".

      This formula installs the CLI and the MCP server only. The menu-bar app
      is a separate cask:

        brew install --cask marcinwalendowski/tap/email-local-mcp
    EOS
  end

  test do
    # `help` is the one subcommand that touches neither the network, the
    # Keychain nor the registry, so it is the only one that can run in
    # Homebrew's sandbox without inventing state on the tester's machine.
    # It does not print a version, so do not assert one here: the version the
    # MCP handshake reports is checked in the repo's own suite
    # (src/node/mcp/version.test.ts), which runs on every push rather than
    # only when somebody audits this tap.
    assert_match "email-local-mcp", shell_output("#{bin}/email-local-mcp help")
  end
end
