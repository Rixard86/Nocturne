import { S } from './state.js';

/* ============================================================
   HOW LOUD WAS THAT, REALLY

   The stored `lvl` is a display level that reaches 100 at 14x the room floor and stops.
   Measured on a real night, 14.7% of confirmed snores sat at exactly 100 while the true
   spread ran to 350x - so the loudest events were not merely mis-scaled, they were
   indistinguishable from each other, and any list "sorted by loudest" was arbitrary among
   them. Every event now carries the true amplitude ratio, so ranking and display can use it.

   Nights recorded before that was stored have no ratio and keep their old level.
   ============================================================ */

/** Scaled to the night's own range, plus the absolute dB that does not move between nights. */
function eventLoudness(ev){
  const night = S.current;
  const peak = (night && night.peakRatio) || 0;
  const ratio = (ev && ev.ratio) || 0;
  if (ratio <= 1 || peak <= 1) return { level: (ev && ev.lvl) || 0, db: null };
  const scaled = Math.log(Math.min(ratio, peak)) / Math.log(peak) * 100;
  return { level: Math.max(0, Math.min(100, Math.round(scaled))), db: 20 * Math.log10(ratio) };
}

/** Sort key that separates events the clamped level renders identical. */
function loudnessRank(ev){
  return (ev && ev.ratio) || (ev && ev.lvl) || 0;
}

/** The night's loudest moment over the room floor, in dB. Null when not recorded. */
function nightPeakDb(night){
  const peak = (night && night.peakRatio) || 0;
  return peak > 1 ? 20 * Math.log10(peak) : null;
}

export { eventLoudness, loudnessRank, nightPeakDb };
