# Zero-X sign-in setup

Project: `norrtosjwcossxrhhtvd` (zero-x.live). The project is running. The Worker uses its public publishable key; private credentials belong in Supabase, not this repository or chat.

## Settings already applied

- Site URL: `https://www.zero-x.live`.
- Exact return URLs for home, product, and dashboard on the four existing Zero-X hosts are allowed.
- Email confirmation remains required. Email magic links, Google OAuth, Microsoft OAuth, and phone/SMS verification are implemented in the shared sign-in dialog.
- `/auth/config` checks Supabase's enabled providers. Disabled methods are hidden. Microsoft uses Supabase's `azure` provider and requests the `email` scope.

## Google

Google Cloud currently refuses a new project because the account has reached its project limit. Choose an existing project dedicated to Zero-X, or request a limit increase. Do not change another application's OAuth configuration without checking its users.

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) in the selected project. Configure branding as **ZeroX NeuCockpit**, using the owner's support/developer email. Use External audience for users outside your organization. During testing, add the actual testers' Google addresses.
2. Use only `openid`, email, and profile scopes.
3. Create an OAuth client with application type **Web application** and name **ZeroX website**. The owner must complete credential creation.
4. Authorized JavaScript origins:

   ```text
   https://www.zero-x.live
   https://zero-x.live
   https://neuron.zero-x.live
   https://dashboard.zero-x.live
   ```

5. Authorized redirect URI:

   ```text
   https://norrtosjwcossxrhhtvd.supabase.co/auth/v1/callback
   ```

6. Copy Client ID and Client Secret directly into Google at [Supabase providers](https://supabase.com/dashboard/project/norrtosjwcossxrhhtvd/auth/providers). Enable Google and save. Do not paste the secret into chat.
7. Test a permitted account from the live site. Before public launch, configure audience publishing and any branding/domain verification Google requires. Do not submit invented privacy or terms URLs; these documents need the owner's actual policies.

Source: [Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google).

## Microsoft

1. Open [Microsoft Entra app registrations](https://entra.microsoft.com/). Use the owner's existing tenant; do not create a paid Azure resource.
2. Register **ZeroX NeuCockpit**. To accept both work/school and personal Microsoft accounts, select **Accounts in any organizational directory and personal Microsoft accounts**.
3. Add a **Web** redirect URI matching the Supabase callback above.
4. The owner creates a client secret, copies its **Value** (not Secret ID), and enters it directly in Supabase's Azure provider with the Application (client) ID. Use `https://login.microsoftonline.com/common` for the Azure tenant URL when that account audience is intended. Enable and save.
5. Test one personal and one work/school account if both are advertised. Some organizations require administrator approval.

Source: [Supabase Microsoft setup](https://supabase.com/docs/guides/auth/social-login/auth-azure).

## Email

1. In Supabase Authentication email settings, configure a custom SMTP host, port, username, password, and approved From address. The owner enters the password directly.
2. Use a transactional provider/account authorized to send for the From domain. Composio's Zoho Mail connection does not itself supply an SMTP password.
3. Verify the sending domain with the provider's actual DNS records. Do not invent SPF/DKIM values.
4. Send a magic link to a controlled inbox, open it in the browser that requested it, check the signed-in profile, then sign out.

Without custom SMTP, Supabase's default mailer only delivers to project-team addresses and is not a public-user email service. Email being enabled does not prove delivery or a completed login.

Source: [Supabase SMTP requirements](https://supabase.com/docs/guides/auth/auth-smtp).

## Phone

1. Choose an SMS provider supported by Supabase and available for the intended countries. Check its actual charges and sender-registration requirements before funding or upgrading an account.
2. The owner enters the provider credentials in Supabase, enables phone authentication, and saves. A trial may only allow verified recipients; that does not establish public-user readiness.
3. Test a real controlled number in international form (for example, a number beginning `+91`), receive the SMS, verify the code, inspect the session, and sign out. No test OTP bypass is enabled.

Source: [Supabase phone setup](https://supabase.com/docs/guides/auth/phone-login).

## Local checks

```powershell
cd neuroncli/auth-server
node check-worker.mjs
node check-dashboard.mjs
npm audit --omit=dev
```

Rebuild the checked-in marketing CSS from the repository root after changing Tailwind classes:

```powershell
npx --yes tailwindcss@3.4.17 -c tailwind.config.cjs -i site.css -o site.min.css --minify
```

Owner/team email delivery, callback, signed-in profile, and cross-subdomain dashboard access were verified. Full public sign-in verification remains pending until the owner completes SMTP and provider credential setup and real SMS/OAuth sessions succeed.
