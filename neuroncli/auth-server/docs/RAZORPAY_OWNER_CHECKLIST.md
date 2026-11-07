# Razorpay: owner checklist (test mode, then live)

Everything here is done by the owner in the Razorpay dashboard, GitHub and the database. Nothing in
this repository holds or prints a key. Reference: `GATEWAY_SETUP.md` ("Billing (Razorpay)", launch
step 3, "Refunds and disputes"), `docs/PLATFORM_CONTRACT.md` section 3.5 and 16, runbook section 5c.

## 0. Read this first: production is wired to a live key id

`wrangler.toml` sets `RAZORPAY_KEY_ID = "rzp_live_..."` (a public id, not a secret) and the deploy
pushes `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` from the GitHub `production` environment.
Razorpay test and live are separate worlds: a test key id with a live secret (or the reverse) makes
every Razorpay call answer 401. So test mode cannot be run on `zero-x.live` without swapping all
three values, which also turns real checkout off for the duration. Pick one:

- **A. Rehearse locally (recommended, no production change).** Section 5 below. The local server
  and the PGlite database use `rzp_test_` keys from a gitignored `.dev.vars`. The webhook needs a
  public URL, so use a tunnel (any HTTPS tunnel to `localhost`) and register that URL as a second
  test-mode webhook; or skip webhooks locally and rely on the verify call that checkout makes.
- **B. Swap production to test keys for a short window.** Change `RAZORPAY_KEY_ID` in `wrangler.toml`
  to the `rzp_test_` id, replace the two secrets with the test-mode values, deploy, run section 6,
  then restore all three to live (section 8). No real customer can pay in that window.

Do not commit test or live secrets anywhere. Only the key id lives in the repo.

## 1. Prices to match (from `PLAN_CATALOG`)

| Plan | INR (paise) | USD (cents) | Credits granted each month |
|---|---|---|---|
| Pro | 89900 (Rs 899) | 1000 ($10) | $16 |
| Max | 349900 (Rs 3499) | 4000 ($40) | $35 |

Top-up packs (orders, not plans): `credits_5` Rs 449 / $5, `credits_20` Rs 1749 / $20.

## 2. Create the four plans

Preferred: let the script create them, dry run first (dashboard in **Test mode**, keys `rzp_test_`).

1. In `neuroncli/auth-server`, put `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` (test) in `.dev.vars`.
2. Dry run, creates nothing:
   `node --env-file=.dev.vars scripts/razorpay-bootstrap.mjs`
   Expect four rows `would_create` (pro INR 89900, pro USD 1000, max INR 349900, max USD 4000), or
   `existing` for plans a previous run made.
3. Create the missing plans: `node --env-file=.dev.vars scripts/razorpay-bootstrap.mjs --apply`.
   Re-running is safe: plans with the same period, interval, currency, amount and `zerox_plan` note
   are reused. If a price was changed, that row is created again (the old plan is not edited).
4. The script prints two `UPDATE public.zerox_plan_policy ...` statements. Run them against the
   Supabase database yourself (SQL editor or `psql`); the script never writes to a remote database.
5. Check: the operator `/health` shows `plans_configured` `{inr: true, usd: true, missing: []}`.

By hand instead (dashboard, Subscriptions, Plans, Create): period monthly, interval 1, item name
`Neuron Pro (monthly)` or `Neuron Max (monthly)`, the amounts above in the matching currency, and
the notes `zerox_plan` = `pro` or `max`, `zerox_currency` = `INR` or `USD`. USD plans need
international payments enabled on the account (Settings, Payment methods / International). Then
write the four ids into `zerox_plan_policy.razorpay_plan_id_inr/usd` with the same UPDATE shape.

Plan ids are per mode. The live plans are created again in section 8; the database holds one set at
a time, so swapping modes means swapping these four ids too.

## 3. Webhook

Dashboard, Settings, Webhooks, Add (in the mode you are testing):

- URL: `https://zero-x.live/webhooks/razorpay`
- Secret: generate a long random value in a password manager (do not paste it into chat or a file in the repo).
- Active events: `subscription.authenticated`, `subscription.activated`, `subscription.charged`,
  `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`,
  `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, and the
  `payment.dispute.*` events (created, won, lost, closed, under_review, action_required).

Store the same secret as the GitHub `production` environment secret `RAZORPAY_WEBHOOK_SECRET`
(`gh secret set RAZORPAY_WEBHOOK_SECRET --env production`, the value is read from the prompt), then
re-run the deploy. Check `/health` (operator view) shows `webhook_configured: true` and
`billing_configured: true`. The handler verifies HMAC-SHA256 of the exact raw body, so a proxy that
rewrites the body breaks it. Max body 256 KiB. Razorpay retries on 5xx; the gateway acknowledges
unknown events with 200.

## 4. What the fake-server check proves (run before any real payment)

`npm run check:billing-details` (includes `node check-billing.mjs`) shows, against a fake Razorpay
server: a wrong, empty, prefixed, key-secret-signed or altered-body signature gives 400
`invalid_signature`; a repeated event id gives `{received:true, duplicate:true}`; a new event id for
the same payment is processed but grants credits once per payment; a failed handler gives 503 so
Razorpay retries, and a lease expires after 120 seconds; the plan comes from the Razorpay plan id
(either currency), with the `zerox_plan` note only as a fallback, and `free` or an unknown plan
entitles nothing; the bootstrap dry run creates nothing, apply is idempotent, live keys need
`--allow-live`, and a changed price is not reused.

## 5. Local test-mode rehearsal (option A)

1. `npm run db:dev` prepares the local PGlite database. Stop any local server on it.
2. `node --env-file=.dev.vars scripts/razorpay-bootstrap.mjs --apply --store-pglite <dir>` stores the
   four test plan ids in that database (refuses live keys, even with `--allow-live`).
3. Start the local server, open `/pricing` and `/dashboard`, and run section 6.

## 6. Test checkout, under the enforced CSP

`wrangler.toml` has `CSP_ENFORCE = "true"`; only `/pricing` and `/dashboard` may load
`https://checkout.razorpay.com` and frame `https://api.razorpay.com` and `https://checkout.razorpay.com`.

1. Sign in on a fresh browser profile. Open DevTools, Console and Network, tick "Preserve log".
2. Save billing details, accept the agreements, choose Pro (INR), start checkout.
3. Pass criteria: the Razorpay modal opens; no console line starting "Refused to ..." or
   "Content Security Policy"; no blocked request in Network. Any such line is a CSP bug: copy it into
   an issue, do not switch `CSP_ENFORCE` off in production.
4. Pay with the test cards below. Then confirm: the plan on `/dashboard` becomes Pro, the credit
   balance is $16, the webhook delivery shows 200 in Razorpay (Webhooks, the endpoint, Logs), and
   re-sending the same delivery from Razorpay changes nothing.
5. Repeat for Max USD, a top-up (`credits_5`), a card decline, and a cancellation (the plan stays until
   the cycle ends, then drops to Free on `subscription.cancelled`).

Test cards (Razorpay test mode; any future expiry, any CVV, any name):

| Case | Card |
|---|---|
| Domestic success | 5267 3181 8797 5449 (Mastercard) or 4111 1111 1111 1111 (Visa) |
| International (for USD plans) | 4012 8888 8888 1881 (Visa) |
| Failure | use the "Failure" button on the test-mode bank page, or a card from Razorpay's current test-card page |

Subscriptions also need the OTP/mandate step; on the test bank page choose Success. Card numbers and
failure options change; confirm on Razorpay's "Test cards" page if one is refused.

## 7. Refunds (test the flow once in test mode)

1. Dashboard, Transactions, Payments, open the test payment, Refund. Full refund first.
2. Expect `refund.processed` 200. The payment shows refunded in Billing; credits granted with it are
   taken back (never below zero); a full refund of a subscription payment ends that subscription at
   once. For a goodwill refund that keeps the plan, refund part of the payment.
3. Disputes (`payment.dispute.*`) are only logged ("Razorpay dispute needs operator review"). If one
   is lost, run the three SQL statements in `GATEWAY_SETUP.md` "Disputes and chargebacks", then cancel
   in the dashboard.
4. Before live: confirm the refund windows in `refund.html` and remove its owner-review note
   (launch step 6).

## 8. Switch to live keys

Only after sections 2 to 7 passed in test mode.

1. Razorpay account activation complete; International payments on for USD.
2. Live mode, create the four plans: `node --env-file=.dev.vars scripts/razorpay-bootstrap.mjs` (dry
   run, with `rzp_live_` keys in `.dev.vars`; it refuses without `--allow-live`, so add that flag to
   the dry run too), then with `--apply --allow-live`. Run the printed UPDATE statements (live ids replace
   the test ids).
3. Live mode, create the webhook again (live webhooks are separate) with a new secret and the same
   events. Store it as `RAZORPAY_WEBHOOK_SECRET`. Store the live `RAZORPAY_KEY_SECRET`.
4. Set `RAZORPAY_KEY_ID` in `wrangler.toml` to the `rzp_live_` id (it already is, unless you used
   option B) and deploy.
5. `/health` (operator): `billing_configured`, `webhook_configured`, `csp_enforced` true,
   `plans_configured.missing` empty.
6. Make one real Rs 449 top-up with your own card, check the credits and webhook 200, refund it from
   the dashboard, confirm the credits come back out.
7. Keep the test-mode webhook and plans; they are harmless. Rotate any key that ever left the
   password manager.
