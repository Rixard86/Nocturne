# Replay fixtures

Recorded nights kept as regression baselines for `npm run replay`.

## night-2026-08-30-baseline.jsonl

The first night detection worked: 7h05m, 8,471 episodes, **114 confirmed snores**.
Pulled with `npm run pull:night` on 2026-08-30.

**This fixture predates the 4 s `MAX_SNORE_DUR_SEC` cap.** It contains no `dur>max`
rejects and has episodes up to 19 s classified as `snore`, which the current detector
cannot produce. Replaying it against current code therefore reports a divergence — that
is the cap being measured, not a defect:

| | logged (pre-cap) | current code |
|---|---|---|
| snore verdicts | 196 | 193 |
| confirmed snores | 114 | 116 |

The cap is not purely subtractive: removing three long episodes changes which candidates
pair in the rhythm gate, and nets *two more* confirmed snores.

With `MAX_SNORE_DUR_SEC` temporarily raised out of range, the replay reproduces this night
exactly — 114/114 confirmed snores, 196/196 snore verdicts, 1354/1355 verdicts, and all 12
remaining divergences sit on a logged rounding edge (features are logged to three decimals,
F0 to one, so a value exactly on a threshold scores differently than the unrounded value
did on the phone). That run is what verified the extraction of `SnoreVerdict` and
`SnoreConfirmer` out of `AudioCaptureService`.

Re-record a fixture with current code to get a baseline that passes clean.

## quiet-room-2026-08-30/

A short recording made with current code to verify the audio replay path end to end:
171 s, 1708 reads, 20 episodes, 11 of which reached the classifier. A quiet room, so it
detects almost nothing (10 `other`, 1 unconfirmed `snore`) — its value is fidelity, not
content.

Replaying it both ways gives the same answer:

```
npm run replay -- fixtures/quiet-room-2026-08-30/events.jsonl   # decision layer, from logged features
npm run replay -- fixtures/quiet-room-2026-08-30/night.wav      # from audio, through the real segmenter
```

All 11 classified episodes match on onset, duration and verdict, which is the proof that a
recording replays as the phone actually ran. The log replay reports 2 divergences, both on
a logged rounding edge.

`night.wav` and `night.chunks` must stay together and keep those names — the reader looks
for the sidecar beside the audio.

## Current-code baselines (measured 2026-09-01 at d38ef05)

Re-measured because every number below the fixture descriptions had gone stale: the
spectral-flatness fix changed feature *extraction*, and the confirmer's `certainScore` path
changed which candidates confirm. Both landed after these fixtures were recorded. Run the
same commands and compare against this table — a difference from these numbers is a real
change, a difference from the prose above is not.

| fixture | classified | verdict reproduced | snore | confirmed (replayed vs logged) |
|---|---|---|---|---|
| night-2026-08-30-baseline.jsonl | 1355 | 1339 | 193 | 116 vs 114 |
| night-2026-09-01-baseline.jsonl | 1079 | 1073 | 663 | 545 vs 541 |
| quiet-room-2026-08-30/events.jsonl | 11 | 11 | 1 | 0 vs 0 |
| quiet-room-2026-08-30/night.wav | 11 | — | 4 | 1 |

The two night logs report DIVERGED, and both are expected: each was recorded before a
detector change that is now shipped, so their *logged* verdicts come from code that no
longer exists. Only the quiet-room log replay passes clean.

### The cross-path check cannot currently be run

The quiet-room fixture used to prove that a recording replays as the phone actually ran:
replaying its log and its audio gave the same answer. They now disagree — 1 snore / 0
confirmed from the log, 4 snore / 1 confirmed from the audio.

That is not a fidelity regression. The log replay reads *logged* features, which were
computed before the flatness fix, while the audio replay recomputes them from the samples
with the corrected code. The two paths are being fed different numbers, so they cannot
agree, and no existing fixture can restore the comparison.

**Restoring it needs one night recorded with current code and raw capture armed.** Until
then the audio path is exercised but unverified against a known-good reference, which
matters because feature-level detector changes can only be measured through it.
