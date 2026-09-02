// Replay a recorded night through the shipping detector, off-device.
//
// Only the Android-free detector sources are compiled — the same files the app builds
// from, not a copy. If a threshold moves in SnoreVerdict.kt, this harness and the phone
// move together, which is the whole point: a tuning change can be measured against a real
// night before it ships. Adding an Android import to those files breaks this build loudly.
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const OUT_DIR = resolve('tools', 'replay', 'build');
const OUT_JAR = join(OUT_DIR, 'replay.jar');
const HARNESS_DIR = join('tools', 'replay');
const DETECTOR_SOURCES = [
  join('native', 'AcousticFeatures.kt'),
  join('native', 'SnoreVerdict.kt'),
  join('native', 'SnoreConfirmer.kt'),
  join('native', 'EpisodeSegmenter.kt'),
  join('native', 'PauseDetector.kt'),
  join('native', 'RawCapture.kt'),
];

const COMPILER_MAIN = 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler';
const STUDIO_KOTLINC = 'C:/Program Files/Android/Android Studio/plugins/Kotlin/kotlinc/lib/kotlin-compiler.jar';
const STUDIO_JBR = 'C:/Program Files/Android/Android Studio/jbr/bin/java.exe';
const FFMPEG_FALLBACK = 'C:/Program Files/audiamus/AAX Audio Converter/ffmpeg.exe';

function javaExe() {
  const home = process.env.JAVA_HOME;
  if (home && existsSync(join(home, 'bin', 'java.exe'))) return join(home, 'bin', 'java.exe');
  if (home && existsSync(join(home, 'bin', 'java'))) return join(home, 'bin', 'java');
  if (existsSync(STUDIO_JBR)) return STUDIO_JBR;
  return 'java';
}

function compilerJar() {
  if (process.env.KOTLIN_COMPILER_JAR) return process.env.KOTLIN_COMPILER_JAR;
  if (existsSync(STUDIO_KOTLINC)) return STUDIO_KOTLINC;
  return null;
}

function sourceFiles() {
  const harness = readdirSync(HARNESS_DIR)
    .filter((name) => name.endsWith('.kt'))
    .map((name) => join(HARNESS_DIR, name));
  return [...DETECTOR_SOURCES, ...harness];
}

function isStale(files) {
  if (!existsSync(OUT_JAR)) return true;
  const builtAt = statSync(OUT_JAR).mtimeMs;
  return files.some((file) => statSync(file).mtimeMs > builtAt);
}

function compile(files) {
  const jar = compilerJar();
  if (!jar) {
    console.error(
      'No Kotlin compiler found.\n\n' +
      'Set KOTLIN_COMPILER_JAR to a kotlin-compiler.jar, or install Android Studio\n' +
      `(its bundled copy is expected at ${STUDIO_KOTLINC}).`,
    );
    process.exit(2);
  }
  console.log('Compiling detector + harness');
  const args = ['-cp', jar, COMPILER_MAIN, ...files, '-include-runtime', '-d', OUT_JAR];
  const result = spawnSync(javaExe(), args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// A reference recording is FLAC to keep a whole night under a couple of gigabytes; the
// harness reads WAV, so decode it once into the build directory first.
function decodeFlac(input) {
  const ffmpeg = process.env.FFMPEG ?? FFMPEG_FALLBACK;
  if (!existsSync(ffmpeg)) {
    console.error(`Cannot decode ${input}: no ffmpeg. Set FFMPEG to an ffmpeg.exe.`);
    process.exit(2);
  }
  const wav = join(OUT_DIR, 'decoded.wav');
  if (existsSync(wav) && statSync(wav).mtimeMs > statSync(input).mtimeMs) return wav;
  console.log('Decoding FLAC to WAV');
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, wav],
    { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return wav;
}

mkdirSync(OUT_DIR, { recursive: true });
const files = sourceFiles();
if (isStale(files)) compile(files);

const args = process.argv.slice(2).map(arg =>
  arg.toLowerCase().endsWith('.flac') ? decodeFlac(arg) : arg);
const result = spawnSync(javaExe(), ['-jar', OUT_JAR, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
