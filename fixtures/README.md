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
