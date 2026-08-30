import { readFileSync, writeFileSync } from 'fs';

// Capacitor's generated activity theme inherits windowBackground from
// Theme.AppCompat.DayNight, which is light grey in light mode. That colour is what shows
// between the launch splash ending and the WebView's first paint — a grey flash on every
// cold start, worst after a long recording. Painting the window in the app's own
// background means any such frame is indistinguishable from the app.
const WINDOW_BACKGROUND = '#0B1120';

const ACTIVITY_THEME = '<style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">';

export function patchTheme(stylesPath) {
  const text = readFileSync(stylesPath, 'utf8');
  if (text.includes('android:windowBackground')) return 'already set';
  if (!text.includes(ACTIVITY_THEME)) return 'activity theme not found — skipped';

  const patched = text.replace(
    ACTIVITY_THEME,
    `${ACTIVITY_THEME}\n        <item name="android:windowBackground">${WINDOW_BACKGROUND}</item>`
  );
  writeFileSync(stylesPath, patched);
  return `windowBackground ${WINDOW_BACKGROUND}`;
}
