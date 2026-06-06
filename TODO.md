# ZeroX — Tasks & Issues List

This file tracks the outstanding setup tasks and notes for the `zero-x.live` platform.

---

## 📅 Immediate Tasks (To be completed today)

- [ ] **Image Promotion social media, from Kumaravel**
  - *Priority:* High
  - *Context:* Run image promotion/marketing campaigns across social media channels today.

---

## 🔮 Future Setup Tasks

### 1. Configure Custom Clerk Subdomain (`clerk.zero-x.live`)
- [ ] Add `clerk.zero-x.live` under **Domains** in the Clerk Dashboard.
- [ ] Log in to **Cloudflare** for `zero-x.live` and add a CNAME record:
  - **Type:** `CNAME`
  - **Name:** `clerk`
  - **Target:** *(The CNAME target provided by Clerk)*
  - **Proxy Status:** **DNS Only** (Grey cloud)
- [ ] Click **Verify** in Clerk Dashboard to complete SSL propagation.

### 2. Configure Custom Google OAuth Client (Production)
- [ ] Log in to [Google Cloud Console](https://console.cloud.google.com/) using the corporate workspace account.
- [ ] Create or select the `ZeroX` corporate project.
- [ ] Configure the **OAuth Consent Screen** (User type: *External*, Domain: *zero-x.live*, App name: *ZeroX*).
- [ ] Create a **Web Application OAuth Client ID** under **Credentials**:
  - **Authorized Redirect URI:** `https://clerk.zero-x.live/v1/oauth_callback`
- [ ] Input the resulting **Client ID** and **Client Secret** into the Google Social Connection settings in Clerk.
- [ ] Submit for Google verification to remove developer warning screen if necessary.

### 3. Configure Custom GitHub OAuth Client (Production)
- [ ] Go to the **ZeroX GitHub Organization settings** > **Developer Settings** > **OAuth Apps**.
- [ ] Click **New OAuth App** and register with:
  - **Application Name:** `ZeroX`
  - **Homepage URL:** `https://www.zero-x.live`
  - **Authorization callback URL:** `https://clerk.zero-x.live/v1/oauth_callback`
- [ ] Copy the **Client ID** and generate a new **Client Secret**.
- [ ] Paste both credentials into the GitHub Social Connection settings in Clerk.
