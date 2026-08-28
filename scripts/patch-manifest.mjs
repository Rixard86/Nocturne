import { readFileSync, writeFileSync } from 'fs';

// Capacitor's WebChromeClient only grants getUserMedia after requesting BOTH
// RECORD_AUDIO and MODIFY_AUDIO_SETTINGS, so both must be declared or the in-WebView
// mic request is denied even when the OS permission is granted. The foreground-service
// entries let recording survive screen-off.
const PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.WAKE_LOCK',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
];

const MICROPHONE_FEATURE =
  '<uses-feature android:name="android.hardware.microphone" android:required="false" />';

const AUDIO_SERVICE = `        <service
            android:name=".AudioCaptureService"
            android:exported="false"
            android:foregroundServiceType="microphone" />
`;

function missingDeclarations(text) {
  const lines = PERMISSIONS.filter(name => !text.includes(name)).map(
    name => `<uses-permission android:name="${name}" />`
  );
  if (!text.includes(MICROPHONE_FEATURE)) lines.push(MICROPHONE_FEATURE);
  return lines;
}

function addDeclarations(text) {
  const lines = missingDeclarations(text);
  if (!lines.length) return text;
  return text.replace('<application', `${lines.join('\n    ')}\n\n    <application`);
}

function registerService(text) {
  if (text.includes('AudioCaptureService')) return text;
  return text.replace('</application>', `${AUDIO_SERVICE}</application>`);
}

export function patchManifest(path) {
  let text = readFileSync(path, 'utf8');
  text = addDeclarations(text);
  text = registerService(text);
  writeFileSync(path, text);
  return 'audio permissions + foreground service';
}
