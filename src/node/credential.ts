// How a provider proves it is the account's owner.
//
// Two shapes, and the split is the whole of SPEC-287 phase 5: an App Password
// read from the OS credential store at connect time, or a short-lived bearer
// token produced on demand by an OAuth `TokenSource`. Deliberately structural
// (no import from `oauth/`), so a provider can consume a credential without
// depending on the flow that produced it.
//
// The bearer branch is also the seam a *hosted-style* provider would use
// unchanged: Gmail REST and Microsoft Graph want exactly this — "give me a
// bearer token for this account, refreshing if you must" — and would put it in
// an Authorization header where the IMAP/SMTP providers put it in XOAUTH2.
export type MailCredential =
  | { kind: "app-password" }
  | { kind: "oauth"; getAccessToken(): Promise<string> };

/** The default for every account configured before OAuth existed. */
export const APP_PASSWORD: MailCredential = { kind: "app-password" };
