# Nocturne — Snore &amp; Breathing Monitor (Android build)

On-device snoring and breathing-pause screening, packaged as an Android app with
**Capacitor**. APKs are built automatically by **GitHub Actions** — no computer, no
Android Studio, no local tooling. You manage everything from your phone.

> Nocturne is a screening aid, not a medical device. It estimates a relative snoring
> **sound level** from the microphone and flags acoustic patterns (loud snoring followed
> by extended silence). It cannot measure airflow, blood oxygen, or true decibels (dB SPL),
> and cannot diagnose sleep apnea. Persistent flags warrant a professional sleep evaluation.

## What the app does

- **Live monitoring** with a microphone-driven "breath halo" that expands with sound level.
- **Automatic room calibration**: the first few seconds of each recording measure the
  ambient floor, so detection adapts to your room and device instead of fixed thresholds.
- **Adjustable sensitivity** (Low / Medium / High) for how readily snoring is flagged —
  changeable any time, even mid-recording.
- **Snore Score, timeline, and event playback**, a breathing-stability index, and
  flagging of breathing-pause patterns that can accompany obstructive sleep apnea.
- **Lifestyle/remedy logging** and **night-over-night trends**.
- A **sample night** that exercises every screen with no microphone needed.

---

## What's in this repo

The project ships as a single zip plus the workflow. You commit just two things:

| Path | Purpose |
|------|---------|
| `nocturne-src.zip` | The app source: `www/`, `package.json`, `capacitor.config.json`, the `android-icons/` set, and this README — all at the zip's top level |
| `.github/workflows/build-apk.yml` | Extracts the zip, generates the native project, installs the icon, builds the APK, and bundles the output |

The `android/` native project is **not** committed — the workflow generates it on the
build runner each time, injects the microphone permissions, installs the custom launcher
icon, and compiles the APK. This is what makes the project fully manageable from a phone.

> **Why a zip?** GitHub's mobile web UI can't upload a folder tree reliably, and uploading
> the raw `.zip` keeps everything in one file. The workflow unpacks it on the runner. The
> zip deliberately contains **no** `.github/` folder, so it can never overwrite your
> workflow file.

---

## Build an APK (100% from mobile)

### 1. Put the two files in your repo
Upload `nocturne-src.zip` and `build-apk.yml` to your GitHub repo using the **GitHub web
UI** ("Add file" → "Upload files"):

- `nocturne-src.zip` goes at the **repo root**.
- `build-apk.yml` must end up at **`.github/workflows/build-apk.yml`**.

> If you're replacing an older copy, delete the previous `nocturne-src.zip` first, then
> upload the new one.

### 2. The build starts itself
Every push to the `main` (or `master`) branch triggers a build. You can also start one
by hand: repo → **Actions** tab → **Build Android APK** → **Run workflow**.

### 3. Download the bundle
When the run finishes (green check, ~3–6 min after the first run, which is slower while it
populates the build caches):

- **Quick install:** repo → **Actions** → open the **newest** run at the top of the list →
  scroll to **Artifacts** → tap **nocturne-bundle** to download the zip to your phone.
  (Older failed runs stay in the list — always open the most recent one.)
- **Or tag a release:** push a tag like `v1.0.0` and the workflow also publishes a
  **GitHub Release** with the zip and the raw APK attached (repo → **Releases**).

The bundle zip (`nocturne-bundle.zip`, or `nocturne-<tag>.zip` on a release) contains:

| Inside the zip | What it is |
|----------------|------------|
| `nocturne-debug.apk` | The installable app |
| `INSTALL.txt` | Install steps, generated at build time |
| `www/` | The full app source, for reference |
| `README.md` | This file |

### 4. Install it
Unzip the bundle and open `nocturne-debug.apk` from your Downloads. Android will ask you
to allow **"Install unknown apps"** for your browser/file manager — enable it, then
install. Launch Nocturne and tap **Record**; grant the microphone permission when asked.

> **Reinstalling after an update:** uninstall the existing Nocturne first, then install the
> new APK. Debug builds aren't signed with a stable key, so Android treats each new APK as a
> separate app — and a clean install also refreshes the cached launcher icon.

---

## Using it

1. Place the phone face-down on the mattress or nightstand, within arm's reach, plugged in.
2. Pick a **sensitivity** (start on **High** if you want to be sure snoring is caught; drop
   to **Medium** if it over-counts).
3. Tap **Record**. Hold still and quiet for the first few seconds while Nocturne measures
   the room — detection starts automatically after that.
4. Tap stop when you wake to see the report.

> Start calibration when the room is at its real sleeping-state quiet. If a fan or AC is
> running at the start, the measured baseline rises and detection becomes less sensitive.

---

## Making changes later

The app lives in `www/index.html` **inside** `nocturne-src.zip`, so to change it you edit
that file and re-zip, then replace `nocturne-src.zip` in the repo. The commit triggers a
fresh APK automatically. The `build-apk.yml` workflow only needs changing if the build
process itself changes.

---

## Signed release builds (optional, later)

The workflow produces a **debug** APK, which installs fine for personal use and testing.
Two consequences: it can't be published to the Play Store, and because the debug key isn't
stable, a new APK won't **update** an installed copy in place — you uninstall and reinstall.

To get true in-place updates (and Play Store eligibility), the build would sign every APK
with one stable key you control and auto-increment the `versionCode`. That means generating
a keystore once and storing it plus its passwords as repo **Secrets**, then switching the
Gradle task to `assembleRelease` / `bundleRelease` with a signing config. It's a few extra
steps and four secrets — ask and it can be wired in.

---

## Troubleshooting

- **Build fails at "Install dependencies" with `ENOENT ... package.json`:** the repo is
  missing the source. Make sure `nocturne-src.zip` is uploaded at the repo root (not the
  bundle output, and not left zipped inside another folder).
- **You edited the workflow but the build behaves the same:** GitHub only runs the file at
  `.github/workflows/build-apk.yml` in the repo. Editing the copy inside any zip has no
  effect. Also confirm you're reading the **newest** run, not an older failed one.
- **App opens but Record shows "Microphone access is needed":** grant the mic permission
  when prompted. The app needs both the OS permission **and** the in-app WebView grant;
  the build declares `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS` to satisfy both. If you
  denied it, enable it under Android **Settings → Apps → Nocturne → Permissions**, then
  fully reopen the app. The **sample night** button works without the microphone.
- **Snore/pause counts stay low even with noise:** raise the **sensitivity** to High. Also
  make sure the room was quiet during the first few seconds of calibration — a noisy start
  raises the baseline and reduces sensitivity. Stop and re-record to re-calibrate.
- **The custom icon didn't change after an update:** uninstall the old app, then reinstall.
  Android caches launcher icons, and debug builds aren't signed with a stable key.
- **"App not installed":** uninstall any previous Nocturne first, then reinstall.
