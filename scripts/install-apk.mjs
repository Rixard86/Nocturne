// Install the debug APK on the connected phone, choosing the device the same way
// pull-night does so a running emulator can't make the command ambiguous.
import { existsSync } from 'fs';
import { adb, selectDevice } from './adb-device.mjs';

const APK = 'android/app/build/outputs/apk/debug/app-debug.apk';

function main() {
  if (!existsSync(APK)) {
    console.error(`No APK at ${APK}\nRun 'npm run build:android' first.`);
    process.exit(1);
  }

  const device = selectDevice();
  const result = adb(['install', '-r', APK], device);
  const out = `${result.stdout}${result.stderr}`.trim();

  if (!out.includes('Success')) {
    console.error(out || 'Install failed with no output.');
    // The one failure worth explaining: a CI build already on the device outranks a
    // local one only if versionCode regressed, which the build script now prevents.
    if (out.includes('VERSION_DOWNGRADE')) {
      console.error('\nThe installed build has a higher versionCode. Rebuild to restamp it.');
    }
    process.exit(1);
  }

  const version = adb(['shell', 'dumpsys', 'package', 'com.nocturne.app'], device)
    .stdout.toString().match(/versionCode=(\d+)/);
  console.log(`Installed on ${device}${version ? ` — versionCode ${version[1]}` : ''}`);
}

main();
