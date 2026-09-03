/* ============================================================
   THE WEARABLE'S VIEW OF THE NIGHT

   Nocturne hears the night; a watch measures it. Both sides now carry absolute epoch
   milliseconds - the session log opens with the night's real startMs - so lining them up is
   plain arithmetic with no timezone in it.

   Everything here is read-only and degrades to null. A night with no watch, no permission or
   no overlapping session simply keeps the acoustic estimate.
   ============================================================ */

const PROBE_DAYS = 2;
const BIN_SEC = 300;             // matches the acoustic hypnogram's 5-minute bins
const MIN_OVERLAP_MIN = 30;      // below this the two nights are not the same night

function plugin() {
  const C = window.Capacitor;
  return (C && C.isNativePlatform && C.isNativePlatform() && C.Plugins && C.Plugins.Health)
    ? C.Plugins.Health : null;
}

function looksLikePermissionLoss(result) {
  const error = result && result.sleep && result.sleep.error;
  return typeof error === 'string' && error.indexOf('SecurityException') >= 0;
}

/**
 * Probe once, and if Health Connect refuses the read, re-request and try again.
 *
 * Reinstalling the app silently revokes read access while BOTH the OS and Health Connect
 * still report every permission as granted, so there is nothing to check beforehand - the
 * failed read is the only signal. One requestHealthPermissions() resolves it without showing
 * the user anything, because the permissions genuinely are granted.
 */
async function probeWithRecovery(health) {
  let result = await health.probe({ days: PROBE_DAYS }).catch(() => null);
  if (!result || !looksLikePermissionLoss(result)) return result;
  await health.requestHealthPermissions().catch(() => null);
  return health.probe({ days: PROBE_DAYS }).catch(() => null);
}

function overlapMinutes(session, night) {
  const nightEnd = night.startMs + (night.durationSec || 0) * 1000;
  return (Math.min(session.endMs, nightEnd) - Math.max(session.startMs, night.startMs)) / 60000;
}

/** The wearable session covering this night, or null. */
export async function wearableNight(night) {
  const health = plugin();
  if (!health || !night || !night.startMs) return null;
  const result = await probeWithRecovery(health);
  const sessions = (result && result.sleep && result.sleep.sessions) || [];
  let best = null, bestOverlap = MIN_OVERLAP_MIN;
  for (const session of sessions) {
    const overlap = overlapMinutes(session, night);
    if (overlap > bestOverlap) { best = session; bestOverlap = overlap; }
  }
  if (!best) return null;
  return { session: best, overlapMin: Math.round(bestOverlap), source: best.source };
}

/** The wearable's stages as the bins drawHypnogram already draws. */
export function stagesAsHypnogram(session, night) {
  const spans = (session && session.stageSpans) || [];
  if (!spans.length) return [];
  const bins = [];
  const total = (night.durationSec || 0);
  for (let t = 0; t < total; t += BIN_SEC) {
    const at = night.startMs + (t + BIN_SEC / 2) * 1000;
    const span = spans.find(s => at >= s.startMs && at < s.endMs);
    if (span) bins.push({ t, stage: span.stage === 'sleeping' ? 'light' : span.stage });
  }
  return bins;
}

/** Snores per hour in each stage, which is the thing neither device can say alone. */
export function snoresByStage(session, night) {
  const spans = (session && session.stageSpans) || [];
  if (!spans.length) return [];
  const minutes = {}, counts = {};
  for (const s of spans) {
    const stage = s.stage === 'sleeping' ? 'light' : s.stage;
    minutes[stage] = (minutes[stage] || 0) + (s.endMs - s.startMs) / 60000;
  }
  for (const ev of (night.events || [])) {
    const at = night.startMs + ev.t * 1000;
    const span = spans.find(s => at >= s.startMs && at < s.endMs);
    if (!span) continue;
    const stage = span.stage === 'sleeping' ? 'light' : span.stage;
    counts[stage] = (counts[stage] || 0) + 1;
  }
  return Object.keys(minutes)
    .filter(stage => minutes[stage] >= 1)
    .map(stage => ({ stage, minutes: Math.round(minutes[stage]), snores: counts[stage] || 0,
                     perHour: (counts[stage] || 0) / (minutes[stage] / 60) }))
    .sort((a, b) => b.perHour - a.perHour);
}
