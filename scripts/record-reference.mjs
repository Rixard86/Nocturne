// Record a reference microphone on this PC for exactly as long as the phone records.
//
// The phone already persists its own session state for overnight re-attach, so this polls
// that rather than needing anything new on the device: when `active` flips true the mic
// starts, when it flips false the mic stops.
//
// The phone belongs next to your face, not on a USB cable, so this normally talks to it
// over wireless adb. Enable that once while it is plugged in:
//
//     adb tcpip 5555
//
// then run this with the phone's address, e.g.
//
//     npm run record:reference -- --connect 192.168.1.42:5555
//
// Alignment is measured, not assumed. The phone's clock is read alongside this machine's at
// both ends, so events logged in phone time convert to an offset into the audio even if the
// two clocks disagree or drift.
import { spawn, spawnSync } from 'child_process';
import { createServer } from 'http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import { adb, findAdb, selectDevice } from './adb-device.mjs';

const PACKAGE = 'com.nocturne.app';
const SESSION_META = 'files/nocturne_session/session.json';
const POLL_MS = 5000;
// A wireless adb link goes idle and drops on its own - observed within an hour of sitting
// still. While recording we therefore keep going and keep retrying for a long time: stopping
// early loses the rest of the night irrecoverably, whereas over-recording only costs disk.
const MAX_ADB_FAILURES = 1440;      // ~2 hours of failed polls before giving up
const SAMPLE_RATE = 44100;          // match the phone, so the analysis rate divides evenly
const OUT_DIR = resolve('reference');
const STOP_GRACE_MS = 10000;
const NO_SESSION = Symbol('no-session');
const INDICATOR_PORT = 4321;

// ffmpeg's dshow parser splits on ':', and "Elgato Wave:3" contains one — so devices are
// always addressed by their alternative name (a GUID) rather than their friendly name.
const WAVE_NAME = /elgato wave/i;
const RAW_INPUT = /^mic in/i;       // the hardware input, not Elgato's Wave Link virtuals

const FFMPEG_CANDIDATES = [
  () => process.env.FFMPEG,
  () => 'C:/Program Files/audiamus/AAX Audio Converter/ffmpeg.exe',
  () => 'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
];

function findFfmpeg() {
  for (const candidate of FFMPEG_CANDIDATES) {
    const path = candidate();
    if (path && existsSync(path)) return path;
  }
  return spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).error ? null : 'ffmpeg';
}

/** Enumerate DirectShow audio inputs as { name, alternative }. */
function listAudioDevices(ffmpeg) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
    { encoding: 'utf8' });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const devices = [];
  let pending = null;
  for (const line of text.split('\n')) {
    const quoted = /"([^"]+)"/.exec(line);
    if (!quoted) continue;
    if (/Alternative name/i.test(line)) {
      if (pending) devices.push({ name: pending, alternative: quoted[1] });
      pending = null;
    } else {
      pending = quoted[1];
    }
  }
  return devices;
}

function pickMicrophone(devices) {
  const wave = devices.filter(d => WAVE_NAME.test(d.name));
  return wave.find(d => RAW_INPUT.test(d.name)) ?? wave[0] ?? null;
}

let recordingFile = '';
let recordingSince = 0;
let activeStop = null;
let statusDetail = 'starting';

/** What the microphone is doing right now, as the indicator page sees it. */
function currentStatus() {
  return {
    state: recordingSince ? 'recording' : 'idle',
    detail: statusDetail,
    file: recordingFile ? basename(recordingFile) : '',
    elapsedSec: recordingSince ? (Date.now() - recordingSince) / 1000 : 0,
  };
}

function publishStatus(state, detail) {
  statusDetail = detail;
}

/**
 * Serve the indicator page.
 *
 * The recorder serves its own status, so if this process dies the page stops loading and
 * shows "recorder not running". An unreachable server can never be mistaken for "the mic is
 * safely off", which a status file left behind on disk could be.
 */
function startIndicator() {
  const page = join(process.cwd(), 'scripts', 'indicator.html');
  const server = createServer((request, response) => {
    if (request.url === '/status') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(currentStatus()));
      return;
    }
    try {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(readFileSync(page));
    } catch {
      response.writeHead(500).end('indicator.html missing');
    }
  });
  server.on('error', error => console.error(`Indicator server: ${error.message}`));
  server.listen(INDICATOR_PORT, '127.0.0.1');
  return `http://localhost:${INDICATOR_PORT}/`;
}

/** Open the indicator in the default browser, so it is visible without hunting for a URL. */
function openBrowser(url) {
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // harmless - the URL is printed anyway
  }
}
const WIRELESS_SERIAL = /^[\d.]+:\d+$/;

/** Re-attach a dropped Wi-Fi link. A no-op for a USB serial, and harmless if still connected. */
function reconnect(serial) {
  if (!WIRELESS_SERIAL.test(serial)) return;
  try { spawnSync(findAdb(), ['connect', serial], { encoding: 'utf8' }); } catch {}
}

/** Attach to a phone over Wi-Fi so it can sit by the bed rather than on a cable. */
function connectWireless(address) {
  const result = spawnSync(findAdb(), ['connect', address], { encoding: 'utf8' });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  console.log(`adb connect ${address}: ${text.split('\n').pop()}`);
  return /connected/i.test(text);
}

/**
 * The phone's own view of its session.
 *
 * Three outcomes, and they must stay distinct: the session itself, NO_SESSION when the
 * phone answered but has no session file (the app deletes it once a night is finalized,
 * so this means "finished", not "unreachable"), and null when the phone could not be
 * reached at all — which over Wi-Fi is routine and must not end the recording.
 */
function phoneSession(serial) {
  const result = adb(['exec-out', 'run-as', PACKAGE, 'cat', SESSION_META], serial);
  const text = result.stdout.toString('utf8').trim();
  const problem = result.stderr.toString('utf8');
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return /No such file|not found in package|is unknown/i.test(problem) ? NO_SESSION : null;
}

/** Epoch milliseconds according to the phone, for measuring clock offset. */
function phoneClockMs(serial) {
  const result = adb(['shell', 'date', '+%s%3N'], serial);
  const value = Number(result.stdout.toString('utf8').trim());
  return Number.isFinite(value) ? value : null;
}

function startRecording(ffmpeg, target) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'dshow', '-i', `audio=${target.device.alternative}`,
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'flac',
    '-y', target.path,
  ];
  return spawn(ffmpeg, args, { stdio: ['pipe', 'inherit', 'inherit'] });
}

/** Ask ffmpeg to finish: 'q' on stdin closes the container cleanly. */
function stopRecording(child) {
  return new Promise(done => {
    child.on('exit', done);
    try { child.stdin.write('q'); child.stdin.end(); } catch { child.kill(); }
    setTimeout(() => { try { child.kill(); } catch {} }, STOP_GRACE_MS);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Wait for the phone to begin a session, so the mic only runs while the phone records. */
async function waitForSession(serial) {
  let announced = false;
  for (;;) {
    const session = phoneSession(serial);
    if (session !== null && session !== NO_SESSION && session.active) return session;
    if (session === null) reconnect(serial);
    if (!announced) {
      console.log('Waiting for the phone to start recording... (Ctrl+C to abort)');
      announced = true;
    }
    await sleep(POLL_MS);
  }
}

/** Poll until the phone says the session ended; a dropped Wi-Fi link is not an ending. */
async function waitForStop(serial) {
  let failures = 0;
  for (;;) {
    await sleep(POLL_MS);
    const session = phoneSession(serial);
    if (session === null) {
      reconnect(serial);
      failures++;
      if (failures === 1 || failures % 60 === 0) {
        console.log(`Phone unreachable (${failures} polls) - still recording, retrying.`);
      }
      if (failures >= MAX_ADB_FAILURES) {
        console.log('Lost contact with the phone for two hours - stopping.');
        return null;
      }
      continue;
    }
    if (failures) console.log('Phone reachable again.');
    failures = 0;
    // the session file is deleted once the app finalizes a night, so its absence
    // means finished rather than unreachable
    if (session === NO_SESSION || !session.active) return session;
  }
}

/**
 * Which phone to talk to. An explicit address wins and is used directly: while wireless adb
 * is being set up the same phone is usually still on USB too, and picking between two
 * entries for one device is not a choice worth stopping for.
 */
function resolvePhone() {
  const flag = process.argv.indexOf('--connect');
  const address = flag >= 0 ? process.argv[flag + 1] : process.env.NOCTURNE_PHONE;
  if (address && connectWireless(address)) return address;
  if (address) console.error(`Could not reach ${address}; falling back to a local device.`);
  return selectDevice();
}

/** Record one phone session end to end, then leave the microphone off again. */
async function recordSession(context) {
  const started = await waitForSession(context.serial);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = { device: context.device, path: join(OUT_DIR, `reference-${stamp}.flac`) };
  const metaPath = target.path.replace(/\.flac$/, '.json');
  const meta = {
    audio: target.path,
    device: context.device.name,
    sampleRate: SAMPLE_RATE,
    phoneStartMs: started.startMs,
    pcStartMs: Date.now(),
    phoneClockAtStart: phoneClockMs(context.serial),
  };
  meta.clockOffsetMsAtStart = meta.phoneClockAtStart === null ? null
    : meta.phoneClockAtStart - meta.pcStartMs;

  console.log(`RECORDING -> ${target.path}`);
  if (meta.clockOffsetMsAtStart !== null) {
    console.log(`phone clock runs ${meta.clockOffsetMsAtStart} ms ahead of this PC`);
  }
  const child = startRecording(context.ffmpeg, target);
  recordingFile = target.path;
  recordingSince = Date.now();
  publishStatus('recording', 'phone session active');
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  let stopping = false;
  activeStop = async () => {
    if (stopping) return;
    stopping = true;
    await stopRecording(child);
    meta.pcStopMs = Date.now();
    meta.phoneClockAtStop = phoneClockMs(context.serial);
    meta.clockOffsetMsAtEnd = meta.phoneClockAtStop === null ? null
      : meta.phoneClockAtStop - meta.pcStopMs;
    meta.durationSec = (meta.pcStopMs - meta.pcStartMs) / 1000;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    recordingSince = 0;
    recordingFile = '';
    publishStatus('idle', `finished after ${(meta.durationSec / 60).toFixed(1)} min`);
    console.log('');
    console.log(`Stopped after ${(meta.durationSec / 60).toFixed(1)} min`);
    console.log(`  audio    ${target.path}`);
    console.log(`  metadata ${metaPath}`);
  };

  await waitForStop(context.serial);
  await activeStop();
  activeStop = null;
}

async function main() {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    console.error('No ffmpeg found. Set FFMPEG to an ffmpeg.exe with dshow support.');
    process.exit(2);
  }
  const devices = listAudioDevices(ffmpeg);
  const device = pickMicrophone(devices);
  if (!device) {
    console.error('No Elgato Wave input found. Connected DirectShow inputs:');
    for (const d of devices) console.error(`  ${d.name}`);
    process.exit(2);
  }
  const context = { ffmpeg, device, serial: resolvePhone() };
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Reference mic : ${device.name}`);
  console.log(`ffmpeg        : ${ffmpeg}`);
  console.log(`phone         : ${context.serial}`);
  console.log('The microphone turns on only when the phone starts recording, and off with it.');
  console.log('Leave this running - it keeps watching after each recording. Ctrl+C to stop.');
  console.log('');

  const url = startIndicator();
  console.log(`Indicator     : ${url}`);
  openBrowser(url);
  publishStatus('idle', 'waiting for the phone to start');

  process.on('SIGINT', async () => {
    if (activeStop) await activeStop();
    publishStatus('idle', 'recorder stopped');
    process.exit(0);
  });

  // keep watching: one night is rarely the only recording, and a recorder that quietly
  // exited after the first one is exactly how a session gets missed
  for (;;) await recordSession(context);
}

main();
