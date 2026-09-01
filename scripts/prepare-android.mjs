// Generate and patch the native Android project.
//
// android/ is not committed — Capacitor regenerates it, and this script re-applies
// everything the app needs on top: the Kotlin audio service, the launcher icon, the
// manifest permissions, and a stable signing config. Safe to re-run; every step is
// idempotent. CI and local builds run this exact script.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { patchGradle } from './patch-gradle.mjs';
import { patchManifest } from './patch-manifest.mjs';
import { patchTheme } from './patch-theme.mjs';

const PACKAGE_DIR = 'android/app/src/main/java/com/nocturne/app';
const RES_DIR = 'android/app/src/main/res';
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const ICONS_DIR = 'android-icons';

const step = message => console.log(`==> ${message}`);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`\nFailed: ${command} ${args.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

function generateNativeProject() {
  step('Generating native project');
  if (!existsSync('android')) run('npx', ['cap', 'add', 'android']);
  run('npx', ['cap', 'sync', 'android']);
}

function installNativeSources() {
  step('Installing native audio service');
  mkdirSync(PACKAGE_DIR, { recursive: true });
  for (const file of readdirSync('native')) {
    cpSync(`native/${file}`, `${PACKAGE_DIR}/${file}`);
  }
}

function installLauncherIcon() {
  step('Installing launcher icon');
  for (const dir of readdirSync(RES_DIR)) {
    const path = `${RES_DIR}/${dir}`;
    if (!dir.startsWith('mipmap')) continue;
    for (const file of readdirSync(path)) {
      if (file.startsWith('ic_launcher')) rmSync(`${path}/${file}`);
    }
  }
  rmSync(`${RES_DIR}/values/ic_launcher_background.xml`, { force: true });
  cpSync(ICONS_DIR, RES_DIR, { recursive: true });
}

// versionCode counts minutes since this epoch, so it rises with build time on CI and
// locally alike. Deriving it from the CI run number instead meant local builds were
// always versionCode 1 and Android refused to install them over a CI build.
const VERSION_EPOCH_MS = Date.UTC(2025, 0, 1);
const MINUTE_MS = 60000;

function version() {
  const run = process.env.GITHUB_RUN_NUMBER;
  const code = Math.floor((Date.now() - VERSION_EPOCH_MS) / MINUTE_MS);
  return { code: String(code), name: run ? `1.0.${run}` : '1.0.0-dev' };
}

function main() {
  if (!existsSync('node_modules')) {
    console.error("node_modules missing; run 'npm install' first");
    process.exit(1);
  }
  generateNativeProject();
  installNativeSources();

  step('Patching Gradle');
  console.log(
    patchGradle(
      {
        root: 'android/build.gradle',
        app: 'android/app/build.gradle',
        variables: 'android/variables.gradle',
        wrapper: 'android/gradle/wrapper/gradle-wrapper.properties',
      },
      version()
    )
  );

  step('Patching manifest');
  console.log(patchManifest(MANIFEST));

  step('Patching theme');
  console.log(patchTheme(`${RES_DIR}/values/styles.xml`));

  installLauncherIcon();

  step('Installing signing keystore');
  cpSync('debug.keystore', 'android/app/debug.keystore');

  step('Android project ready');
}

main();
