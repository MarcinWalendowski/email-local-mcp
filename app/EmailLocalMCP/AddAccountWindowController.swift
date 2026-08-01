import AppKit

/// Add-account form: email + password (+ provider, name, flags) → POST /admin/accounts.
/// Supports Gmail (default), iCloud, Fastmail, and a Custom IMAP account with its own
/// hosts/ports.
///
/// Below the form are the two ways to get an App Password. This app never automates the
/// provider's page itself — it only opens it, or hands the job to an agent you choose:
///
///   - **Do it yourself** — the button opens the provider's page; paste the code into the
///     field. The password goes straight to the local engine → Keychain, so no model ever
///     sees it. This is the private path, and it stays one button away.
///   - **Hand it to your agent** — copy the prompt into any agent you already use. It
///     creates the App Password *and* registers the account via the `add_account` MCP
///     tool, so one paste finishes the job with nothing to type back. The cost is privacy:
///     the password becomes a tool-call argument, so it passes through the model's context
///     and the MCP client's logs. The prompt and the caption both say so.
@MainActor
final class AddAccountWindowController: NSWindowController, NSTextFieldDelegate {
    private let admin: AdminClient
    private let onDone: @MainActor () -> Void

    private let emailField = NSTextField()
    private let passField = NSSecureTextField()
    private let nameField = NSTextField()
    private let defaultCheck = NSButton(checkboxWithTitle: "Make default", target: nil, action: nil)
    private let readOnlyCheck = NSButton(checkboxWithTitle: "Read-only", target: nil, action: nil)
    private let providerPopup = NSPopUpButton()
    private let imapHostField = NSTextField()
    private let imapPortField = NSTextField()
    private let smtpHostField = NSTextField()
    private let smtpPortField = NSTextField()
    private let startTlsCheck = NSButton(checkboxWithTitle: "SMTP uses STARTTLS (port 587)", target: nil, action: nil)
    private let imapFields = NSStackView()
    private let statusLabel = NSTextField(labelWithString: "")
    private let addButton = NSButton(title: "Add Account", target: nil, action: nil)

    private let rootStack = NSStackView()
    private let promptView = NSTextView()
    private let promptScroll = NSScrollView()
    private let copyButton = NSButton(title: "Copy Prompt", target: nil, action: nil)
    private let openPageButton = NSButton(title: "", target: nil, action: nil)

    private static let windowWidth: CGFloat = 470
    private static let contentWidth: CGFloat = 430

    init(admin: AdminClient, onDone: @escaping @MainActor () -> Void) {
        self.admin = admin
        self.onDone = onDone
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: Self.windowWidth, height: 560),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Add Mail Account"
        super.init(window: window)
        window.center()
        buildUI()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    private func buildUI() {
        guard let content = window?.contentView else { return }

        emailField.placeholderString = "you@gmail.com"
        passField.placeholderString = "App Password / IMAP password"
        nameField.placeholderString = "Display name (optional)"
        emailField.delegate = self
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 4
        statusLabel.preferredMaxLayoutWidth = 420

        addButton.target = self
        addButton.action = #selector(add)
        addButton.keyEquivalent = "\r"

        // Password row with an inline "Paste" button — for a password an agent returned.
        let pasteButton = NSButton(title: "Paste", target: self, action: #selector(pastePassword))
        pasteButton.bezelStyle = .rounded
        pasteButton.setContentHuggingPriority(.required, for: .horizontal)
        passField.widthAnchor.constraint(equalToConstant: 240).isActive = true
        let passRow = NSStackView(views: [passField, pasteButton])
        passRow.orientation = .horizontal
        passRow.spacing = 6

        providerPopup.addItems(withTitles: ["Gmail", "iCloud", "Fastmail", "Custom IMAP"])
        providerPopup.target = self
        providerPopup.action = #selector(providerChanged)
        buildIMAPFields()

        rootStack.setViews([
            labeled("Email", emailField),
            labeled("Provider", providerPopup),
            imapFields,
            labeled("Password", passRow),
            labeled("Name", nameField),
            defaultCheck,
            readOnlyCheck,
            NSBox.horizontalSeparator(width: Self.contentWidth),
            createSection(),
            statusLabel,
            addButton,
        ], in: .leading)
        rootStack.orientation = .vertical
        rootStack.alignment = .leading
        rootStack.spacing = 8
        rootStack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        rootStack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(rootStack)
        NSLayoutConstraint.activate([
            rootStack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            rootStack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            rootStack.topAnchor.constraint(equalTo: content.topAnchor),
            rootStack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        for field in [emailField, nameField] {
            field.widthAnchor.constraint(equalToConstant: 300).isActive = true
        }
        updateIMAPFields()
    }

    // MARK: - Provider / custom IMAP

    private func buildIMAPFields() {
        imapHostField.placeholderString = "imap.host.tld"
        imapPortField.placeholderString = "993"
        smtpHostField.placeholderString = "smtp.host.tld"
        smtpPortField.placeholderString = "465"
        imapHostField.delegate = self
        smtpHostField.delegate = self
        for f in [imapHostField, imapPortField, smtpHostField, smtpPortField] {
            f.widthAnchor.constraint(equalToConstant: 220).isActive = true
        }
        imapFields.orientation = .vertical
        imapFields.alignment = .leading
        imapFields.spacing = 6
        for row in [
            labeled("IMAP host", imapHostField),
            labeled("IMAP port", imapPortField),
            labeled("SMTP host", smtpHostField),
            labeled("SMTP port", smtpPortField),
        ] {
            imapFields.addArrangedSubview(row)
        }
        imapFields.addArrangedSubview(startTlsCheck)
    }

    private func providerId() -> String {
        switch providerPopup.indexOfSelectedItem {
        case 1: return "icloud"
        case 2: return "fastmail"
        case 3: return "imap"
        default: return "gmail"
        }
    }

    @objc private func providerChanged() { updateIMAPFields() }

    private func updateIMAPFields() {
        imapFields.isHidden = providerId() != "imap"
        refreshPrompt()
        resizeToFit()
    }

    // MARK: - App Password section

    /// One copyable prompt that does the whole job, plus the manual escape hatch.
    /// The prompt is shown rather than hidden behind a button: it hands an agent a
    /// full-mailbox credential, so it should be readable before it's trusted.
    private func createSection() -> NSView {
        let header = NSTextField(labelWithString: "Need an App Password?")
        header.font = .boldSystemFont(ofSize: 12)

        let caption = wrapped(
            "Paste this into any agent you use; it creates the App Password and adds the account here, in one go.",
            size: 11, color: .secondaryLabelColor, maxWidth: Self.contentWidth, lines: 2
        )

        buildPromptView()

        copyButton.target = self
        copyButton.action = #selector(copyPrompt)
        copyButton.bezelStyle = .rounded
        copyButton.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: nil)
        copyButton.imagePosition = .imageLeading

        openPageButton.target = self
        openPageButton.action = #selector(openAppPasswordsPage)
        openPageButton.bezelStyle = .rounded

        let buttonRow = NSStackView(views: [copyButton, openPageButton])
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 6

        let note = wrapped(
            "The agent sees a password that grants full access to this mailbox. To keep it private, create it yourself and paste it above instead.",
            size: 10, color: .secondaryLabelColor, maxWidth: Self.contentWidth, lines: 3
        )

        let box = NSStackView(views: [header, caption, promptScroll, buttonRow, note])
        box.orientation = .vertical
        box.alignment = .leading
        box.spacing = 6
        return box
    }

    private func buildPromptView() {
        promptView.isEditable = false
        promptView.isSelectable = true
        promptView.drawsBackground = false
        promptView.font = .monospacedSystemFont(ofSize: 10.5, weight: .regular)
        promptView.textColor = .secondaryLabelColor
        promptView.textContainerInset = NSSize(width: 6, height: 6)
        // Standard incantation for a text view that grows vertically inside a scroll view.
        promptView.minSize = NSSize(width: 0, height: 0)
        promptView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        promptView.isVerticallyResizable = true
        promptView.isHorizontallyResizable = false
        promptView.autoresizingMask = [.width]
        promptView.textContainer?.widthTracksTextView = true

        promptScroll.documentView = promptView
        promptScroll.hasVerticalScroller = true
        promptScroll.borderType = .bezelBorder
        promptScroll.translatesAutoresizingMaskIntoConstraints = false
        promptScroll.widthAnchor.constraint(equalToConstant: Self.contentWidth).isActive = true
        // Deliberately shorter than the prompt: a preview to confirm what you're copying,
        // scrollable for anyone who wants to read the whole thing first.
        promptScroll.heightAnchor.constraint(equalToConstant: 96).isActive = true
    }

    /// Rebuilds the preview from the current email/provider/host fields.
    private func refreshPrompt() {
        promptView.string = taskPrompt()
        let g = AppPasswordPrompt.guide(for: providerId())
        openPageButton.isHidden = g.url == nil
        openPageButton.title = "Open \(g.label)'s page"
    }

    func controlTextDidChange(_ obj: Notification) { refreshPrompt() }

    // MARK: - Assistant actions

    @objc private func openAppPasswordsPage() {
        let g = AppPasswordPrompt.guide(for: providerId())
        guard let url = g.url else { return }
        NSWorkspace.shared.open(url)
        setInfo("Opened \(g.label)'s App Password page. Create one named “Email Local MCP”, then paste the code above and click Add.")
    }

    @objc private func copyPrompt() {
        copyToClipboard(taskPrompt())
        let previous = copyButton.title
        copyButton.title = "Copied"
        setInfo("Prompt copied. Paste it into your agent; it will create the App Password and add the account for you.")
        Task {
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            copyButton.title = previous
        }
    }

    @objc private func pastePassword() {
        if let s = NSPasteboard.general.string(forType: .string), !s.isEmpty {
            // Google shows App Passwords as "abcd efgh ijkl mnop"; strip the spaces.
            passField.stringValue = s
                .replacingOccurrences(of: " ", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            setInfo("Pasted the password from your clipboard. Click Add to verify & save.")
        } else {
            setInfo("Clipboard is empty. Copy the password first.")
        }
    }

    /// The one-paste task, prefilled from whatever's currently in the form.
    private func taskPrompt() -> String {
        AppPasswordPrompt.text(
            provider: providerId(),
            email: emailField.stringValue.trimmingCharacters(in: .whitespaces),
            imapHost: imapHostField.stringValue.trimmingCharacters(in: .whitespaces),
            smtpHost: smtpHostField.stringValue.trimmingCharacters(in: .whitespaces)
        )
    }

    // MARK: - Helpers

    /// Sizes the window to whatever the stack actually needs, so showing/hiding the custom
    /// IMAP fields (or a longer status line) can't clip content.
    private func resizeToFit() {
        guard let window, let content = window.contentView else { return }
        content.layoutSubtreeIfNeeded()
        window.setContentSize(NSSize(width: Self.windowWidth, height: rootStack.fittingSize.height))
    }

    private func copyToClipboard(_ s: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(s, forType: .string)
    }

    private func setInfo(_ s: String) {
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.stringValue = s
    }

    private func wrapped(_ text: String, size: CGFloat, color: NSColor, maxWidth: CGFloat, lines: Int) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.textColor = color
        label.font = .systemFont(ofSize: size)
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = lines
        label.preferredMaxLayoutWidth = maxWidth
        return label
    }

    private func labeled(_ title: String, _ field: NSView) -> NSView {
        let label = NSTextField(labelWithString: title)
        label.alignment = .right
        label.widthAnchor.constraint(equalToConstant: 90).isActive = true
        let row = NSStackView(views: [label, field])
        row.orientation = .horizontal
        row.spacing = 8
        return row
    }

    @objc private func add() {
        let email = emailField.stringValue.trimmingCharacters(in: .whitespaces)
        let pass = passField.stringValue
        guard !email.isEmpty, !pass.isEmpty else {
            statusLabel.textColor = .systemRed
            statusLabel.stringValue = "Email and password are required."
            return
        }
        let provider = providerId()
        var connection: [String: Any]?
        if provider == "imap" {
            let ih = imapHostField.stringValue.trimmingCharacters(in: .whitespaces)
            let sh = smtpHostField.stringValue.trimmingCharacters(in: .whitespaces)
            guard !ih.isEmpty, !sh.isEmpty else {
                statusLabel.textColor = .systemRed
                statusLabel.stringValue = "Custom IMAP needs an IMAP host and an SMTP host."
                return
            }
            let startTls = startTlsCheck.state == .on
            connection = [
                "imapHost": ih,
                "imapPort": Int(imapPortField.stringValue) ?? 993,
                "smtpHost": sh,
                "smtpPort": Int(smtpPortField.stringValue) ?? (startTls ? 587 : 465),
                "smtpSecure": !startTls,
            ]
        }

        addButton.isEnabled = false
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.stringValue = "Verifying IMAP + SMTP…"

        Task {
            do {
                try await admin.addAccount(
                    email: email,
                    appPassword: pass,
                    displayName: nameField.stringValue,
                    makeDefault: defaultCheck.state == .on,
                    readOnly: readOnlyCheck.state == .on,
                    provider: provider,
                    connection: connection
                )
                onDone()
                reset()
                close()
            } catch {
                statusLabel.textColor = .systemRed
                statusLabel.stringValue = error.localizedDescription
                addButton.isEnabled = true
            }
        }
    }

    private func reset() {
        emailField.stringValue = ""
        passField.stringValue = ""
        nameField.stringValue = ""
        defaultCheck.state = .off
        readOnlyCheck.state = .off
        providerPopup.selectItem(at: 0)
        imapHostField.stringValue = ""
        imapPortField.stringValue = ""
        smtpHostField.stringValue = ""
        smtpPortField.stringValue = ""
        startTlsCheck.state = .off
        statusLabel.stringValue = ""
        addButton.isEnabled = true
        updateIMAPFields()
    }
}

private extension NSBox {
    /// A thin horizontal divider for stacking sections.
    static func horizontalSeparator(width: CGFloat) -> NSBox {
        let box = NSBox()
        box.boxType = .separator
        box.translatesAutoresizingMaskIntoConstraints = false
        box.widthAnchor.constraint(equalToConstant: width).isActive = true
        return box
    }
}
