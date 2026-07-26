// Open the system browser at the consent screen.
//
// Best-effort by design: the URL is always printed as well, so a failure here —
// a headless box, a locked-down desktop, an SSH session — costs the user a
// copy-paste rather than the flow. Nothing in this file may throw.

import { spawn } from "node:child_process";

/** The launcher for this platform, as argv (never a shell string). */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  // `start` is a cmd builtin, and its first quoted argument is the window title
  // — the empty string is what stops a URL in quotes being swallowed as one.
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/** Returns whether the launcher was spawned; never throws. */
export function openBrowser(url: string): boolean {
  const { command, args } = browserCommand(url);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* no launcher installed — the printed URL is the fallback */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
