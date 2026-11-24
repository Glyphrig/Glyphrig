# Setting Up a GitHub OAuth App for Glyphrig (Device Flow)

Glyphrig supports two ways to authenticate with GitHub in the browser extension:

1. **Scoped Personal Access Token (PAT)** — Works immediately with no setup; paste a fine-grained PAT (`Contents: Read and write`).
2. **GitHub OAuth Device Flow ("Sign in with GitHub")** — One-click browser login that issues a user token without needing a backend server or client secret.

To enable **GitHub OAuth Device Flow**, you register a free **GitHub OAuth App** and supply its **Client ID** via `VITE_GITHUB_OAUTH_CLIENT_ID` (or directly in the extension's Options page).

---

## Step 1: Create the GitHub OAuth App

1. Sign in to GitHub and open **Developer Settings**:
   - **Organization-owned (recommended for `Glyphrig`):** Go to `https://github.com/organizations/Glyphrig/settings/applications` (or **Your Org -> Settings -> Developer settings -> OAuth Apps**).
   - **Personal account:** Go to `https://github.com/settings/developers` (**Settings -> Developer settings -> OAuth Apps**).
2. Click **New OAuth App** (or **Register a new application**).
3. Fill out the form:
   - **Application name:** `Glyphrig` (or `Glyphrig Bookmark Sync`)
   - **Homepage URL:** `https://github.com/Glyphrig/Glyphrig`
   - **Application description:** `Two-way bookmark folder sync with Git repositories.`
   - **Authorization callback URL:** `https://github.com/Glyphrig/Glyphrig`
     *(Required by GitHub's creation form, though Device Flow does not redirect to it.)*
4. **Check the box labeled `Enable Device Flow`**.
   > **Important:** Device Flow will fail with `unauthorized_client` or `device_flow_disabled` if this checkbox is not enabled!
5. Click **Register application**.

---

## Step 2: Copy the Client ID (No Client Secret Needed)

On the newly created OAuth App page:

1. Copy the **Client ID** (it looks like `Ov23li...`).
2. **Do NOT generate or embed a Client Secret.** GitHub OAuth Device Flow for public/browser clients intentionally authenticates using only the public Client ID.

---

## Step 3: Wire the Client ID into Glyphrig

You have three ways to configure the Client ID depending on whether you are developing locally, publishing releases in CI, or configuring an already-built extension:

### Option A: Local Extension Builds (`apps/extension/.env.local`)

Create `/home/djehauti/git/Glyphrig/apps/extension/.env.local` (already gitignored):

```dotenv
VITE_GITHUB_OAUTH_CLIENT_ID=Ov23liYourClientIdHere
```

Then build or run dev mode:

```bash
pnpm dev:ext:chrome
# or production builds:
pnpm --filter @glyphrig/extension build
pnpm --filter @glyphrig/extension build:firefox
```

WXT embeds `import.meta.env.VITE_GITHUB_OAUTH_CLIENT_ID` at build time.

### Option B: GitHub Actions Releases (`.github/workflows/release.yml`)

In the `Glyphrig/Glyphrig` repository on GitHub:

1. Open **Settings -> Secrets and variables -> Actions -> Variables** (or **Secrets** — Client IDs are public identifiers, so an Actions Variable works well).
2. Add a variable named **`VITE_GITHUB_OAUTH_CLIENT_ID`** with your Client ID (`Ov23li...`).
3. The release workflow (`.github/workflows/release.yml`) automatically passes `VITE_GITHUB_OAUTH_CLIENT_ID: ${{ vars.VITE_GITHUB_OAUTH_CLIENT_ID || secrets.VITE_GITHUB_OAUTH_CLIENT_ID }}` when building Chrome and Firefox extension bundles.

### Option C: Runtime Override Inside the Extension Options Page

Even without rebuilding the extension, you can paste a Client ID directly in the extension UI:

1. Open Glyphrig **Options -> About / OAuth Setup** (or expand **Custom GitHub OAuth Client ID** in the Profile GitHub Device Flow panel).
2. Paste your Client ID (`Ov23li...`) and click **Save Client ID**.
3. The runtime override takes precedence over `VITE_GITHUB_OAUTH_CLIENT_ID` and is stored locally in `browser.storage.local`.

---

## Verifying Device Flow Works

1. Open Glyphrig **Options -> Profiles**.
2. Create or edit a profile with Forge set to **GitHub**.
3. Click **Sign in with GitHub**.
4. Glyphrig opens a pop-out modal displaying an 8-character code (e.g., `ABCD-1234`), copies it to your clipboard automatically (with a **Copy Code** button), and lets you click **Open GitHub Authorization Page** when ready.
5. Paste the code and authorize the app — Glyphrig automatically detects authorization, saves the token (and refresh token metadata if your app issues expiring 8-hour tokens) as a **Shared GitHub Account** in `browser.storage.local`, and lets you reuse that single sign-in across as many sync profiles as you want.

## Token Lifetimes & Troubleshooting

- **Shared Accounts Across Profiles:** Each GitHub Device Flow sign-in is stored as a shared account (`@username`) that automatically defaults onto new GitHub profiles. Re-authorizing or rotating a refresh token updates every linked profile at once without hitting GitHub's 10-token cap.

- **Expiring vs. Non-Expiring Tokens:** Classic GitHub OAuth Apps normally issue non-expiring `gho_` tokens unless *Expire user authorization tokens* is enabled (typically **8-hour** access tokens paired with **6-month** rotating `refresh_token`s). Glyphrig automatically refreshes expiring tokens before syncs and on `401` errors whenever GitHub returns a `refresh_token`.
- **10-Token Limit per User & OAuth App:** GitHub only retains up to **10** active OAuth tokens per user per OAuth App. Authorizing the same Client ID more than 10 times across separate browsers or profiles silently revokes the oldest token—reuse your token via **Export/Import Backup** or issue a fine-grained PAT (`Contents: Read and write`) for additional devices.
- **Organization SAML SSO:** If you sync a repository belonging to a SAML SSO organization, click **Authorize** next to the organization in GitHub **Settings → Applications → Authorized OAuth Apps**.
