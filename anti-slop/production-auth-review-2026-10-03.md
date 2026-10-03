# Auth review — 3 October 2026

The Google account chooser displays the actual Supabase callback host. Live Google configuration uses app name **ZeroX NeuCockpit** and the matching web client. Its audience remains Testing; branding has no logo, home page, privacy policy or terms links. Supabase is on the Free plan.

To display verified name/logo, complete Google's brand verification with actual published policies and verified domain ownership. Replacing the callback hostname with `auth.zero-x.live` requires Supabase's paid custom domain add-on and provider callback/DNS changes. No purchase, unverified policy submission, or credential change was made.

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

- Google public publishing and brand verification.
- Real public-user email delivery using custom SMTP.
- Microsoft and SMS provider setup if offered publicly.
- OpenRouter CLI session handoff: currently the server exchanges authorization but has no verified mechanism to deliver the resulting session to the user's local CLI. Do not advertise that flow as production ready.
- Anonymous legacy sessions remain supported for existing clients. Per-session quotas do not prevent anonymous callers from obtaining additional sessions. Enforce authenticated accounts or a shared abuse limit before exposing a metered gateway publicly.
- Usage increments are persisted, but concurrent quota reservation and streamed token accounting need a separate gateway/database change before promising strict billing limits.

Sources: [Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google), [custom domains](https://supabase.com/docs/guides/platform/custom-domains).
