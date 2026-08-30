// Locate adb and pick which device to talk to.
//
// An emulator running alongside the phone makes every unqualified adb call ambiguous, so
// commands fail with no useful output. Physical devices win by default — this project's
// scripts are always about a real phone — and ANDROID_SERIAL or --device overrides that.
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';

const ADB_CANDIDATES = [
  () => process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe'),
  () => process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  () => process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
  () => process.env.HOME && join(process.env.HOME, 'Android', 'Sdk', 'platform-tools', 'adb'),
];

export function findAdb() {
  for (const candidate of ADB_CANDIDATES) {
    const path = candidate();
    if (path && existsSync(path)) return path;
  }
  return 'adb';
}

const ADB = findAdb();

/** Run adb against a specific device. `encoding: 'buffer'` keeps binary payloads intact. */
export function adb(args, serial) {
  const full = serial ? ['-s', serial, ...args] : args;
  return spawnSync(ADB, full, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
}

function listDevices() {
  const result = adb(['devices', '-l']);
  if (result.error) return null;
  return result.stdout.toString().split('\n').slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => ({ serial: line.split(/\s+/)[0], state: line.split(/\s+/)[1], line }))
    .filter(d => d.state === 'device');
}

function explicitSerial() {
  const flag = process.argv.indexOf('--device');
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1];
  return process.env.ANDROID_SERIAL || null;
}

/**
 * Resolve the device to use, or exit with guidance. Prefers a physical device over an
 * emulator; only genuine ambiguity (two phones) is an error worth stopping for.
 */
export function selectDevice() {
  const devices = listDevices();
  if (devices === null) {
    console.error(`Could not run adb at ${ADB}\nSet ANDROID_HOME, or add platform-tools to PATH.`);
    process.exit(1);
  }

  const wanted = explicitSerial();
  if (wanted) {
    if (devices.some(d => d.serial === wanted)) return wanted;
    console.error(`Device "${wanted}" is not connected.\nConnected: ${devices.map(d => d.serial).join(', ') || 'none'}`);
    process.exit(1);
  }

  if (!devices.length) {
    console.error(
      'No device connected.\n\n' +
      '  1. On the phone: Settings > About phone > tap "Build number" 7 times\n' +
      '  2. Settings > System > Developer options > enable "USB debugging"\n' +
      '  3. Connect by USB and accept the "Allow USB debugging?" prompt'
    );
    process.exit(1);
  }

  const physical = devices.filter(d => !d.serial.startsWith('emulator-'));
  if (physical.length === 1) {
    if (devices.length > 1) console.log(`Using phone ${physical[0].serial} (ignoring ${devices.length - 1} emulator(s))`);
    return physical[0].serial;
  }
  if (physical.length > 1) {
    console.error(
      'More than one phone is connected — say which one:\n' +
      physical.map(d => `  ${d.serial}`).join('\n') +
      '\n\nRe-run with --device <serial>, or set ANDROID_SERIAL.'
    );
    process.exit(1);
  }

  // Emulators only: usable, but worth saying so — the app records from a real microphone.
  console.log(`No phone connected; using ${devices[0].serial}`);
  return devices[0].serial;
}
