# Nocturne — Snore &amp; Breathing Monitor (Android build)

On-device snoring and breathing-pause screening, packaged as an Android app with
**Capacitor**. APKs are built automatically by **GitHub Actions** — no computer, no
Android Studio, no local tooling. You manage everything from your phone.

> Nocturne is a screening aid, not a medical device. It estimates snoring intensity and
> flags acoustic patterns from the microphone. It cannot measure airflow or blood oxygen
> and cannot diagnose sleep apnea. Persistent flags warrant a professional sleep evaluation.

---

## What's in this repo

| Path | Purpose |
|------|---------|
| `www/index.html` | The entire app (UI + on-device audio analysis) |
| `package.json` | Capacitor dependencies (pinned) |
| `capacitor.config.json` | App id, name, and plugin config |
| `.github/workflows/build-apk.yml` | Builds the APK automatically |
| `.gitignore` | Keeps the repo light; the native project is generated in CI |

The `android/` native project is **not** committed. The workflow generates it on the
build runner, injects the microphone permission, and compiles the APK. This is what makes
the project fully manageable from a phone — you only ever touch the files above.

---

## Build an APK (100% from mobile)

### 1. Put these files in your repo
Upload every file from this project to your GitHub repo, preserving the folder structure
(`www/`, `.github/workflows/`). On mobile you can do this with the **GitHub web UI**
("Add file" → "Upload files"), or an app like **Working Copy** (iOS) /
**MGit** (Android), or a **GitHub Codespace** in the mobile browser.

> The folder structure matters. `build-apk.yml` must end up at
> `.github/workflows/build-apk.yml`, and the app at `www/index.html`.

### 2. The build starts itself
Every push to the `main` (or `master`) branch triggers a build. You can also start one
by hand: repo → **Actions** tab → **Build Android APK** → **Run workflow**.

### 3. Download the APK
When the run finishes (green check, ~5–8 min):

- **Quick install:** repo → **Actions** → open the latest run → scroll to **Artifacts**
  → tap **nocturne-debug-apk** to download the `.apk` to your phone.
- **Or tag a release:** push a tag like `v1.0.0` and the workflow also publishes a
  **GitHub Release** with the APK attached (repo → **Releases**).

### 4. Install it
Open the downloaded `.apk` from your Downloads. Android will ask you to allow
**"Install unknown apps"** for your browser/file manager — enable it, then install.
Launch Nocturne and tap **Record**; grant the microphone permission when asked.

---

## Making changes later

Edit `www/index.html` directly on GitHub (pencil icon), commit, and a fresh APK builds
automatically. That's the whole loop — no rebuild commands to run yourself.

---

## Signed release builds (optional, later)

The workflow produces a **debug** APK, which installs fine for personal use and testing.
To publish on the Play Store you'd need a **signed release** APK/AAB. That requires
generating a keystore and adding it plus its passwords as repo **Secrets**, then switching
the Gradle task to `assembleRelease` (or `bundleRelease`) with a signing config. Ask and
this can be wired in — it's a few extra steps and four secrets.

---

## Troubleshooting

- **Build fails at "Add Android platform":** make sure `package.json` and
  `capacitor.config.json` are at the repo root, not inside a subfolder.
- **App opens but Record does nothing:** confirm you granted the microphone permission;
  if you denied it, enable it under Android **Settings → Apps → Nocturne → Permissions**.
  The **sample night** button works without the microphone and exercises every analysis
  screen.
- **"App not installed":** uninstall any previous Nocturne first (debug signatures change
  between unrelated builds), then reinstall.
