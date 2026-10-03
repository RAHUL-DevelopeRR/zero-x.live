# Auth review — 3 October 2026

At the start of this review, the Google account chooser displayed the Supabase callback host. The app name was already **ZeroX NeuCockpit**, but the audience was Testing and its branding lacked a logo and policy links.

## Google branding completed

- Uploaded the repository's `Assets/zerox-favicon-centered.png` as the app logo.
- Published the owner-approved privacy policy and terms at `https://www.zero-x.live/privacy` and `https://www.zero-x.live/terms`; both are linked from the homepage and product page.
- Saved those URLs and the homepage in Google Branding.
- Confirmed Search Console identifies the current account as a verified owner of `zero-x.live`.
- Changed the app audience to **In production**. Google confirmed that no sensitive or restricted scopes are requested.
- Ran **Verify branding**, received successful verification, then selected **Publish branding**. Google reports: “Your branding has been verified and is being shown to users.”
- Opened a fresh Supabase Google authorization flow. Its account chooser displays **ZeroX NeuCockpit**, the logo and both policy links. No account selection was necessary for this branding check; this was not a fresh end-to-end login test.
- Deployment and the live metadata/sitemap checks passed. Policy pages were verified in the browser.

The callback itself still uses the existing Supabase project hostname. Changing that URL to `auth.zero-x.live` would require the paid custom domain setup; it is unnecessary for the now-verified display name. No purchase or credential change was made.

## Repairs

- Anonymous legacy sessions always receive the free plan and no claimed account identity.
- Invalid fingerprint and malformed model/message inputs are rejected.
- Auth responses use no-store and no-referrer; responses deny framing and MIME sniffing.
- Malformed or incomplete session cookies fail closed; cookie part counts are bounded.
- Opening the sign-in dialog refreshes provider availability after provider settings change.
- CLI callback responses check HTTP success, render text safely, remove credentials from the page URL and avoid automatic anonymous session creation on direct visits.
- OpenRouter state expires after ten minutes. Removed the Worker attempt to contact its own localhost as though it were the user's computer. Callback no longer claims the CLI received a session.
- GitHub deployment runs worker, session, dashboard, SEO, callback and dependency security checks first.

## Release gates still outstanding

- Real public-user email delivery using custom SMTP.
- Microsoft and SMS provider setup if offered publicly.
- OpenRouter CLI session handoff: currently the server exchanges authorization but has no verified mechanism to deliver the resulting session to the user's local CLI. Do not advertise that flow as production ready.
- Anonymous legacy sessions remain supported for existing clients. Per-session quotas do not prevent anonymous callers from obtaining additional sessions. Enforce authenticated accounts or a shared abuse limit before exposing a metered gateway publicly.
- Usage increments are persisted, but concurrent quota reservation and streamed token accounting need a separate gateway/database change before promising strict billing limits.

Sources: [Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google), [custom domains](https://supabase.com/docs/guides/platform/custom-domains).
