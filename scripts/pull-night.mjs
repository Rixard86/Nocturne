// Pull the last night's diagnostic log off the phone and summarise it.
//
// The session log is DELETED when the next recording starts, so pull before recording
// again. Requires USB debugging enabled and the debug build installed (run-as only works
// on a debuggable package).
import { closeSync, openSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { adb, findAdb, selectDevice } from './adb-device.mjs';

const PACKAGE = 'com.nocturne.app';
// The live log is moved aside once the app finalizes the night, so fall back to the
// archive — which is the usual case when pulling the morning after.
const REMOTE_LOGS = [
  'files/nocturne_session/events.jsonl',
  'files/nocturne_session/events-last.jsonl',
];
const OUT_FILE = process.argv.find(a => !a.startsWith('--') && a.endsWith('.jsonl')) ?? 'night.jsonl';
// The raw recording is only written when capture was armed from the debug readout, and it
// is hundreds of megabytes, so it is pulled on request rather than every time.
const WANT_AUDIO = process.argv.includes('--audio');
const RECORDING_FILES = ['night.wav', 'night.chunks'];
const SESSION_DIR = 'files/nocturne_session';

const DEVICE = selectDevice();

function readRemote(path) {
  // exec-out, not shell: it streams raw bytes without the pty's newline translation.
  const result = adb(['exec-out', 'run-as', PACKAGE, 'cat', path], DEVICE);
  const text = result.stdout.toString('utf8');
  const missing = !text.trim() || text.includes('No such file') || text.includes('is unknown');
  return { text, missing, stderr: result.stderr };
}

function pullLog() {
  let last = { stderr: Buffer.alloc(0) };
  for (const path of REMOTE_LOGS) {
    const result = readRemote(path);
    last = result;
    if (!result.missing) {
      console.log(`Reading ${path}`);
      return result.text;
    }
  }
  console.error(
    `No log found in ${REMOTE_LOGS.join(' or ')}.\n\n` +
    'Likely causes:\n' +
    '  - a new recording was started, which deletes the previous log\n' +
    '  - the app was reinstalled since the recording\n' +
    '  - this is a release build (run-as needs a debuggable package)\n' +
    (last.stderr.length ? `\nadb said: ${last.stderr.toString().trim()}` : '')
  );
  process.exit(1);
}

/** Stream a binary file straight to disk — a night of audio must not go through a buffer. */
function pullBinary(name) {
  const handle = openSync(name, 'w');
  const args = ['-s', DEVICE, 'exec-out', 'run-as', PACKAGE, 'cat', `${SESSION_DIR}/${name}`];
  const result = spawnSync(findAdb(), args, { stdio: ['ignore', handle, 'pipe'] });
  closeSync(handle);
  const size = statSync(name).size;
  if (size > 0) return size;
  unlinkSync(name);
  const said = result.stderr ? result.stderr.toString().trim() : '';
  console.error(`  ${name}: not on the device${said ? ` (adb said: ${said})` : ''}`);
  return 0;
}

function pullRecording() {
  console.log('\nPulling raw recording');
  const sizes = RECORDING_FILES.map(name => pullBinary(name));
  if (sizes.some(size => size === 0)) {
    console.error(
      '  No recording found. It is written only when raw capture was armed before the\n' +
      '  recording started (triple-tap "sound level", then tap the debug readout), and a\n' +
      '  new recording deletes the previous one.'
    );
    return;
  }
  for (const [i, name] of RECORDING_FILES.entries()) {
    console.log(`  ${name}  ${(sizes[i] / 1e6).toFixed(1)} MB`);
  }
  console.log(`\nReplay it with:  npm run replay -- ${RECORDING_FILES[0]}`);
}

/**
 * How far the confirmed snores stood above the room floor.
 *
 * The level scale is logarithmic over a 14x span, so a peak level converts straight to dB:
 * level/100 * 20*log10(14). This is the number that decides whether a night is worth
 * analysing at all - below ~6 dB the snore is buried and no classifier change will help.
 */
function reportSignal(lines) {
  const peaks = [];
  for (const line of lines) {
    if (!line.includes('"e":"snore"')) continue;
    const found = /"lvl":([0-9]+)/.exec(line);
    if (found) peaks.push(Number(found[1]));
  }
  if (!peaks.length) {
    console.log('\nSignal: no confirmed snores to measure');
    return;
  }
  peaks.sort((a, b) => a - b);
  const dbPerLevel = (20 * Math.log10(14)) / 100;
  const median = peaks[Math.floor(peaks.length / 2)] * dbPerLevel;
  const best = peaks[peaks.length - 1] * dbPerLevel;
  const verdict = median < 6 ? 'buried - fix placement before tuning anything'
    : median < 12 ? 'weak' : 'workable';
  console.log(
    '\nSignal: median confirmed snore ' +
    median.toFixed(1) + ' dB above the room floor (best ' + best.toFixed(1) +
    ' dB, n=' + peaks.length + ') - ' + verdict
  );
}

function tally(lines, event, field) {
  const counts = new Map();
  const matcher = new RegExp(`"${field}":"([^"]*)"`);
  for (const line of lines) {
    if (!line.includes(`"e":"${event}"`)) continue;
    const found = matcher.exec(line);
    const key = found ? found[1] : '(none)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function printTally(title, rows) {
  console.log(`\n${title}`);
  if (!rows.length) { console.log('  (none)'); return; }
  const width = Math.max(...rows.map(r => String(r[1]).length));
  for (const [key, count] of rows) {
    console.log(`  ${String(count).padStart(width)}  ${key}`);
  }
}

function main() {
  const text = pullLog();
  writeFileSync(OUT_FILE, text);
  const lines = text.split('\n').filter(Boolean);

  console.log(`Saved ${lines.length} events to ${OUT_FILE}`);

  const config = lines.find(line => line.includes('"e":"cfg"'));
  console.log('\nCapture configuration');
  console.log(config ? `  ${config}` : '  (none — this log predates config logging)');

  printTally('Rhythm gate outcomes  (did snores get confirmed?)', tally(lines, 'rhythm', 'out'));
  printTally('Episode reject reasons  (which gate ate them?)', tally(lines, 'epi', 'reject'));
  printTally('Episode classifications', tally(lines, 'epi', 'kind'));

  const snores = lines.filter(line => line.includes('"e":"snore"')).length;
  const pauses = lines.filter(line => line.includes('"e":"pause"')).length;
  const samples = lines.filter(line => line.includes('"e":"sample"')).length;
  console.log(
    `\nEmitted: ${snores} snores, ${pauses} pauses` +
    `\nDuration: ~${(samples / 60).toFixed(0)} min of samples`
  );

  reportSignal(lines);

  if (WANT_AUDIO) pullRecording();
  else console.log('\nPass --audio to also pull the raw recording, when one was captured.');
}

main();
