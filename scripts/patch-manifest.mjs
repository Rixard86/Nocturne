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
  // Health Connect, for correlating a night against a wearable. Read-only.
  //
  // READ_HEALTH_DATA_HISTORY must be declared from the start. Without it an app can only
  // ever see 30 days back from the moment permission is first granted, and reinstalling
  // resets that window - silently orphaning everything older with no error to notice.
  'android.permission.health.READ_SLEEP',
  'android.permission.health.READ_HEART_RATE',
  'android.permission.health.READ_HEART_RATE_VARIABILITY',
  'android.permission.health.READ_RESPIRATORY_RATE',
  'android.permission.health.READ_HEALTH_DATA_HISTORY',
];

const MICROPHONE_FEATURE =
  '<uses-feature android:name="android.hardware.microphone" android:required="false" />';

const AUDIO_SERVICE = `        <service
            android:name=".AudioCaptureService"
            android:exported="false"
            android:foregroundServiceType="microphone" />
`;

function missingDeclarations(text) {
  // Matched on the whole attribute, not the bare name: READ_HEART_RATE is a prefix of
  // READ_HEART_RATE_VARIABILITY, and a substring test would silently skip one of them.
  const lines = PERMISSIONS.filter(name => !text.includes(`android:name="${name}"`)).map(
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

// Health Connect will not grant read access without somewhere to send a user who asks why
// the app wants their health data. Android 14+ reaches it through this alias; older
// releases send the SHOW_PERMISSIONS_RATIONALE action to the activity directly, so both
// routes are declared and both land on the app's one activity.
const RATIONALE_ACTION = 'androidx.health.connect.action.SHOW_PERMISSIONS_RATIONALE';

const RATIONALE_FILTER = `
            <intent-filter>
                <action android:name="${RATIONALE_ACTION}" />
            </intent-filter>
`;

const RATIONALE_ALIAS = `        <activity-alias
            android:name="ViewPermissionUsageActivity"
            android:exported="true"
            android:targetActivity=".MainActivity"
            android:permission="android.permission.START_VIEW_PERMISSION_USAGE">
            <intent-filter>
                <action android:name="android.intent.action.VIEW_PERMISSION_USAGE" />
                <category android:name="android.intent.category.HEALTH_PERMISSIONS" />
            </intent-filter>
        </activity-alias>
`;

function addRationaleFilter(text) {
  if (text.includes(RATIONALE_ACTION)) return text;
  return text.replace('        </activity>', `${RATIONALE_FILTER}        </activity>`);
}

function addRationaleAlias(text) {
  if (text.includes('ViewPermissionUsageActivity')) return text;
  return text.replace('</application>', `${RATIONALE_ALIAS}</application>`);
}

export function patchManifest(path) {
  let text = readFileSync(path, 'utf8');
  text = addDeclarations(text);
  text = registerService(text);
  text = addRationaleFilter(text);
  text = addRationaleAlias(text);
  writeFileSync(path, text);
  return 'audio + health permissions, foreground service, health rationale';
}
