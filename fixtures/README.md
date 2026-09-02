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

## night-2026-09-02-baseline.jsonl

**The first night recorded with current code, and the first with raw audio.** 4.94 h,
177,932 reads, 3,944 episodes, 1,067 confirmed snores, 0 breathing pauses. Anchored:
the log opens with `{"e":"start","startMs":...}`, so every event has an absolute time.

The raw `night.wav` is 313 MB and is NOT in the repo. It is what makes the audio replay
below reproducible, so keep a copy if you want to re-run it.

### The audio replay reproduces the phone exactly

    npm run replay -- night.wav

    reads 177932 | episodes 3944 | classified 1288
    confirmed snores 1067   (phone recorded 1067)
    verdicts: snore 1187, other 101   (phone: snore 1187, other 101)

Every figure matches what the phone produced. This is the fidelity check the quiet-room
fixture used to provide and could no longer: a recording replays as the phone actually ran.

### The log replay does not, and that is expected

    npm run replay -- fixtures/night-2026-09-02-baseline.jsonl
    verdict reproduced 1286/1288, confirmed 998 replayed vs 1067 logged

Only 11 episodes diverge, but they cost 69 confirmations: features are logged to three
decimals and F0 to one, and the rhythm gate pairs candidates, so a handful of episodes
landing on the other side of a threshold changes which candidates pair up and cascades.
Prefer the audio replay when the number has to be exact.

### Pause coverage

The harness now drives `PauseDetector`, the same class the service uses, and prints why
silences were turned down. On this night:

    breathing pauses 0
      shorter than min    16742
      longer than max         0
      no snore before         0
      snore too far back     31
      snore too short         0

31 silences cleared the 9 s bar and every one was rejected because no confirmed snore ended
within 20 s of it. That is the difference between "this night had no pauses" and "a gate
turned them all down", which a bare zero cannot tell you.

## Pause baselines changed 2026-09-02 (SILENCE_FACTOR 1.2 -> 1.4)

Raising the silence threshold above the floor's own noise changed what the pause path
finds. Snore figures are unaffected everywhere.

| fixture | pauses before | pauses after |
|---|---|---|
| night-2026-09-02 (night.wav) | 0 | **10**, including the human-confirmed one at 4482s |
| quiet-room-2026-08-30/night.wav | 0 | **1** |

**The quiet-room pause is a false positive, and a useful one to keep.** That fixture is 171
seconds of a deliberately near-silent room containing one snore-ish event, so a "pause" in it
is an artefact of there being nothing to hear rather than of breathing stopping. It is a
standing reminder that the pause gates cannot distinguish "stopped breathing" from "was never
audible in the first place" - the reason placement matters so much, and the reason a pause
count from a night with a weak signal should not be trusted.
