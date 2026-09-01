# Nocturne — Snore & Breathing Monitor

On-device snoring and breathing-pause screening, packaged as an Android app with
**Capacitor**. The web app runs in a WebView; a native Kotlin foreground service does the
audio capture so recording survives screen-off. Every push to `main` builds an APK in
**GitHub Actions** and publishes it as a release.

> Nocturne is a screening aid, not a medical device. It estimates a relative snoring
> **sound level** from the microphone and flags acoustic patterns (loud snoring followed
> by extended silence). It cannot measure airflow, blood oxygen, or true decibels (dB SPL),
> and cannot diagnose sleep apnea. Persistent flags warrant a professional sleep evaluation.

## What the app does

- **Live monitoring** with a microphone-driven "breath halo" that expands with sound level.
- **Automatic room calibration**: the first few seconds of each recording measure the
  ambient floor, so detection adapts to your room and device instead of fixed thresholds.
- **Adjustable sensitivity** — Auto by default (classifier-driven); triple-tap the
  "Detection" label to reveal the manual Low/Medium/High override.
- **Snore Score, timeline, and event playback**, a breathing-stability index, and
  flagging of breathing-pause patterns that can accompany obstructive sleep apnea.
- **Lifestyle/remedy logging** and **night-over-night trends**.
- A **sample night** that exercises every screen with no microphone needed.

---

## Repository layout

```
www/                     The web app (what ships inside the APK)
  index.html             Markup only
  css/app.css            Styles
  js/                    ES modules, loaded via <script type="module">
native/                  Kotlin foreground service + Capacitor plugin
android-icons/           Launcher icon set (mipmap densities + adaptive descriptors)
scripts/                 Build tooling (Node, cross-platform)
debug.keystore           Stable signing key, so new APKs update installed ones in place
.github/workflows/       CI that builds and releases the APK
```

The `android/` native project is **not** committed. Capacitor regenerates it, and
`scripts/prepare-android.mjs` re-applies everything on top: the Kotlin sources, the
launcher icon, the manifest permissions, the Gradle/Kotlin configuration, and the signing
config. CI and local builds run that same script, so they cannot drift apart.

### The web app modules

`www/js/main.js` is the entry point. State lives in `state.js`; everything else is grouped
by concern — `recorder.js` and `native-bridge.js` (capture), `halo.js` and `charts.js`
(canvas drawing), `finalize.js` and `stages.js` (analysis), `report.js`, `player.js`,
`trends.js`, `export.js` (presentation), with `storage.js` and `ui.js` as shared utilities.

---

## Local development

### Prerequisites

- **Node.js 20+**
- **Android Studio** (supplies the Android SDK and a JDK)
- `JAVA_HOME` pointing at a JDK, and `ANDROID_HOME` at the SDK

Android Studio's bundled JDK works. On Windows:

```powershell
$env:JAVA_HOME  = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
```

Set them permanently via **System Properties → Environment Variables** so every new
terminal picks them up.

### Install

```bash
npm install
```

### Work on the UI in a browser

```bash
npm run dev        # http://localhost:5173
```

The app loads ES modules, which browsers refuse over `file://` — so open it through this
server, not by double-clicking `index.html`. The native bridge is absent in the browser, so
recording falls back to the WebAudio path and the **sample night** button exercises every
screen without a microphone.

### Build an APK

```bash
npm run build:android
```

That regenerates and patches `android/`, then runs `assembleDebug`. The APK lands at
`android/app/build/outputs/apk/debug/app-debug.apk`.

| Script | Does |
|--------|------|
| `npm run dev` | Static server for `www/` on port 5173 |
| `npm run deploy` | Prepare, build, and install to the phone — the usual one |
| `npm run pull:night` | Pull last night's diagnostic log and summarise it (`-- --audio` also pulls the raw recording) |
| `npm run replay` | Replay a recorded night through the detector off-device |
| `npm run record:reference` | Record a PC microphone in sync with the phone's session |
| `npm run prepare:android` | Generate + patch the native project (no compile) |
| `npm run build:android` | Prepare, then build the debug APK |
| `npm run install:android` | Install the built APK |
| `npm run clean:android` | Gradle clean |
| `npm run open:android` | Open the project in Android Studio |
| `npm run sync` | Copy web assets + plugins into `android/` |

The device scripts prefer a physically connected phone and ignore emulators. Pass
`--device <serial>` or set `ANDROID_SERIAL` when more than one phone is attached.

### Diagnosing a night

The detector writes a JSON-lines log beside the normal session events: one `epi` record
per episode with its full feature vector and the gate that rejected it, one `rhythm`
record per confirmation decision, and one `cfg` record naming the capture path actually
in use. `npm run pull:night` fetches it and prints the reject histograms.

The log is archived to `events-last.jsonl` once the app finalizes a night, so pulling the
morning after works — but starting a **new recording** deletes the live log, so pull
before recording again.

Editing anything under `www/` only needs `npm run sync` before rebuilding — a full
`prepare:android` is only required after changing `native/`, the icons, or the config.

### Replaying a night off-device

`npm run replay -- <night.jsonl>` pushes a recorded night back through the detector on the
desktop and reports what it decided, so a threshold change can be measured against real
data instead of guessed at. It compiles the *same* Kotlin the app builds from — the
Android-free detector sources — so the phone and the harness can never drift apart. It
exits non-zero when the replay diverges from the recording, which makes it usable as a
regression gate. Baselines live in `fixtures/`; see `fixtures/README.md` before trusting a
divergence.

The compiler comes from the copy bundled with Android Studio, so no Gradle and no network
are involved. Set `KOTLIN_COMPILER_JAR` to override it.

An event log replays the decision layer. To replay from **audio** — which is what makes
changes to feature extraction measurable — arm raw capture first:

1. Triple-tap "sound level" to reveal the debug readout.
2. Tap the readout. It shows `REC` once armed. This is per-recording and is deliberately
   not persisted: a night costs ~500 MB.
3. Record as usual, then `npm run pull:night -- --audio`.
4. `npm run replay -- night.wav`.

The recording is the decimated analysis stream the classifier actually consumes, plus a
small `night.chunks` sidecar holding the amplitude and timing the phone measured for each
read. The sidecar is what makes the replay faithful: amplitude drives the quiet floor and
every episode boundary, and it cannot be recovered from decimated audio. Both files must
be pulled together, and a new recording deletes them.

If the service is restarted mid-session (a process kill, which `START_STICKY` recovers
from), the log and the recording are appended to rather than truncated, and the night keeps
its original start — a `resume` event marks the seam. One caveat for such a night: the
phone re-calibrates its quiet floor over the 4 s after a restart and reports nothing during
it, while a replay carries its floor straight across, so episodes straddling the seam can
differ. Everything outside that window replays exactly.

### Recording a reference microphone

A second microphone in the room gives what the phone alone cannot: ground truth. The phone's
log only shows what it *confirmed* — it says nothing about what it missed.

`npm run record:reference -- --connect <phone-ip>:5555` watches the phone's own session file
and runs a PC microphone for exactly as long as the phone records, starting and stopping with
it. The phone stays by your face on a wall charger; the link is wireless adb, enabled once
with `adb tcpip 5555` while it is plugged in.

Alignment is measured rather than assumed: the phone's clock is read alongside the PC's at
both ends of the recording and written to a `.json` beside the audio, so events logged in
phone time convert to an offset into the reference audio even if the clocks disagree.

It serves a status page at `http://localhost:4321/` and opens it automatically: solid green
when the microphone is off, solid red with a running timer while it records. The recorder
serves that page itself, so if it dies the page stops loading and says so — an unreachable
server can never be mistaken for "the microphone is safely off". Leave the recorder running;
it keeps watching after each recording rather than exiting.

Two gotchas worth knowing:

- ffmpeg's DirectShow parser splits on `:`, and "Elgato Wave:3" contains one — devices must
  be addressed by their alternative-name GUID, which the script does automatically.
- The app deletes `session.json` when it finalizes a night, so the script treats a missing
  session file as "finished" and an unreachable phone as "keep recording".

`npm run replay` accepts such a recording directly. It has no `night.chunks` sidecar, but it
does not need one: the sidecar exists only because the phone stores decimated audio that has
lost its amplitude, and a full-rate reference recording still carries it.

---

## CI builds

Every push to `main`, every version tag (`v*`), and any manual **Run workflow** builds the
APK. Pull requests build too, but don't publish a release.

Download it from the repo's **Actions** tab → newest run → **Artifacts**
(`nocturne-debug-apk`, or `nocturne-bundle` for the APK plus source and install notes).
Pushes to `main` also publish a **Release** tagged `v1.0.<run number>` with both attached.

The build stamps `versionCode` with the number of minutes since a fixed epoch, so it rises
with build time on CI and locally alike, and signs with the committed `debug.keystore`.
Because the key is stable and the version always rises, a new APK **updates an installed
copy in place** — no uninstall needed, and a local build can install over a CI one.

### Install on a phone

Open the APK on the device; Android will ask you to allow **"Install unknown apps"** for
your browser or file manager. Launch Nocturne, tap **Record**, and grant the microphone
permission when asked.

---

## Using it

1. Place the phone face-down on the mattress or nightstand, within arm's reach, plugged in.
2. Leave detection on **Auto** unless it's clearly over- or under-counting.
3. Tap **Record**. Hold still and quiet for the first few seconds while Nocturne measures
   the room — detection starts automatically after that.
4. Tap stop when you wake to see the report.

> Start calibration when the room is at its real sleeping-state quiet. If a fan or AC is
> running at the start, the measured baseline rises and detection becomes less sensitive.

---

## Signed release builds (optional, later)

The workflow produces a **debug** APK. It installs and updates fine for personal use, but
it can't go to the Play Store. Publishing there means generating a release keystore, storing
it and its passwords as repo **Secrets**, and switching the Gradle task to `bundleRelease`
with a release signing config.

---

## Troubleshooting

- **Gradle fails with "Unsupported class file major version":** the JDK is newer than
  Gradle supports. The build pins the wrapper to Gradle 8.9 and Kotlin's `jvmTarget` to 17
  so JDK 17 and 21 both work; if you're on something newer still, raise
  `GRADLE_WRAPPER_VERSION` in `scripts/patch-gradle.mjs` and re-run `prepare:android`.
- **"Inconsistent JVM-target compatibility":** Kotlin and Java disagree on target level.
  Delete `android/` and re-run `npm run prepare:android` to reapply the pin.
- **`SDK location not found`:** set `ANDROID_HOME`, or create `android/local.properties`
  with `sdk.dir=/path/to/Android/Sdk`.
- **Blank screen in the browser, module errors in the console:** you opened `index.html`
  over `file://`. Use `npm run dev`.
- **App opens but Record shows "Microphone access is needed":** grant the mic permission
  when prompted. The app needs both the OS permission **and** the in-app WebView grant;
  the build declares `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS` to satisfy both. If you
  denied it, enable it under Android **Settings → Apps → Nocturne → Permissions**, then
  fully reopen the app. The **sample night** button works without the microphone.
- **Snore/pause counts stay low even with noise:** make sure the room was quiet during the
  first few seconds of calibration — a noisy start raises the baseline and reduces
  sensitivity. Stop and re-record to re-calibrate.
- **Changes to `www/` don't show up in the APK:** run `npm run sync` (or
  `npm run build:android`, which syncs for you) before rebuilding.
