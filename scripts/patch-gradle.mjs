import { readFileSync, writeFileSync } from 'fs';

const KOTLIN_PLUGIN_VERSION = '1.9.25';
const CORE_KTX_VERSION = '1.13.1';
// Health Connect, for reading sleep stages and overnight vitals from a wearable.
//
// This is the newest release that still builds against this toolchain. 1.1.0-beta01 and
// later demand compileSdk 36 and AGP 8.9.1; the alpha08..alpha12 range demands compileSdk
// 35. Moving to stable therefore means moving the whole Android toolchain, which is a
// separate job from reading a sleep record.
const HEALTH_CONNECT_VERSION = '1.1.0-alpha07';

// Health Connect requires API 26. Capacitor's template defaults to 22, which this app has
// never actually been able to run on anyway: a microphone foreground service is API 29+.
const MIN_SDK = 26;
const ANDROID_APPLICATION_PLUGIN = "apply plugin: 'com.android.application'";

// Capacitor's template ships Gradle 8.2.1, which refuses to run on JDK 21. Android
// Studio bundles JDK 21, so the wrapper is raised to a version that accepts both it
// and the JDK 17 used on CI.
const GRADLE_WRAPPER_VERSION = '8.9';

// The JDK running Gradle also sets Kotlin's default jvmTarget, while AGP pins Java to
// 17. On JDK 21 those disagree and Kotlin modules fail to compile, so every module's
// Kotlin target is pinned to match Java.
const JVM_TARGET = '17';

const KOTLIN_TARGET_BLOCK = `
subprojects {
    tasks.withType(org.jetbrains.kotlin.gradle.tasks.KotlinCompile).configureEach {
        kotlinOptions.jvmTarget = "${JVM_TARGET}"
    }
}
`;

const SIGNING_BLOCK = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
`;

function addKotlinClasspath(text) {
  if (text.includes('kotlin-gradle-plugin')) return text;
  const dependency = `        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_PLUGIN_VERSION}"\n`;
  return text.replace(/(dependencies\s*\{)/, `$1\n${dependency}`);
}

function pinKotlinJvmTarget(text) {
  if (text.includes('kotlinOptions.jvmTarget')) return text;
  return text + KOTLIN_TARGET_BLOCK;
}

function applyKotlinPlugin(text) {
  if (text.includes('kotlin-android')) return text;
  if (text.includes(ANDROID_APPLICATION_PLUGIN)) {
    return text.replace(
      ANDROID_APPLICATION_PLUGIN,
      `${ANDROID_APPLICATION_PLUGIN}\napply plugin: 'kotlin-android'`
    );
  }
  return `apply plugin: 'kotlin-android'\n${text}`;
}

function addCoreKtx(text) {
  if (text.includes('androidx.core:core-ktx')) return text;
  const dependency = `    implementation "androidx.core:core-ktx:${CORE_KTX_VERSION}"\n`;
  return text.replace(/(dependencies\s*\{)/, `$1\n${dependency}`);
}

function addHealthConnect(text) {
  if (text.includes('androidx.health.connect')) return text;
  const dependency = '    implementation "androidx.health.connect:connect-client:' + HEALTH_CONNECT_VERSION + '"' + String.fromCharCode(10);
  return text.replace(/(dependencies\s*\{)/, '$1' + String.fromCharCode(10) + dependency);
}

function findBlockEnd(text, start) {
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i + 1;
  }
  return open;
}

function replaceSigningConfigs(text) {
  if (!/signingConfigs\s*\{/.test(text)) {
    return text.replace(/(android\s*\{)/, `$1\n${SIGNING_BLOCK}`);
  }
  const start = text.indexOf('signingConfigs');
  const end = findBlockEnd(text, start);
  const lineStart = text.lastIndexOf('\n', start) + 1;
  return text.slice(0, lineStart) + SIGNING_BLOCK + text.slice(end);
}

function useDebugSigning(text) {
  if (text.includes('signingConfig signingConfigs.debug')) return text;
  if (!/buildTypes\s*\{/.test(text)) return text;
  if (/buildTypes\s*\{[\s\S]*?debug\s*\{/.test(text)) {
    return text.replace(
      /(buildTypes\s*\{[\s\S]*?debug\s*\{)/,
      '$1\n            signingConfig signingConfigs.debug'
    );
  }
  return text.replace(
    /(buildTypes\s*\{)/,
    '$1\n        debug {\n            signingConfig signingConfigs.debug\n        }'
  );
}

function setVersion(text, version) {
  const { code, name } = version;
  let out = /versionCode\s+\d+/.test(text)
    ? text.replace(/versionCode\s+\d+/, `versionCode ${code}`)
    : text.replace(/(defaultConfig\s*\{)/, `$1\n        versionCode ${code}`);
  return /versionName\s+"[^"]*"/.test(out)
    ? out.replace(/versionName\s+"[^"]*"/, `versionName "${name}"`)
    : out.replace(/(defaultConfig\s*\{)/, `$1\n        versionName "${name}"`);
}

function patchAppGradle(path, version) {
  let text = readFileSync(path, 'utf8');
  text = applyKotlinPlugin(text);
  text = addCoreKtx(text);
  text = addHealthConnect(text);
  text = setVersion(text, version);
  text = replaceSigningConfigs(text);
  text = useDebugSigning(text);
  writeFileSync(path, text);
}

function patchVariables(path) {
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, text.replace(/minSdkVersion\s*=\s*\d+/, `minSdkVersion = ${MIN_SDK}`));
}

function patchRootGradle(path) {
  let text = readFileSync(path, 'utf8');
  text = addKotlinClasspath(text);
  text = pinKotlinJvmTarget(text);
  writeFileSync(path, text);
}

function setWrapperVersion(path) {
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, text.replace(/gradle-[\d.]+-all\.zip/, `gradle-${GRADLE_WRAPPER_VERSION}-all.zip`));
}

export function patchGradle(paths, version) {
  patchRootGradle(paths.root);
  patchVariables(paths.variables);
  setWrapperVersion(paths.wrapper);
  patchAppGradle(paths.app, version);
  return `wrapper ${GRADLE_WRAPPER_VERSION}, kotlin jvmTarget ${JVM_TARGET}, minSdk ${MIN_SDK}, versionCode ${version.code}, versionName ${version.name}`;
}
