# Derived Engine State

Publishes `propulsion.<instance>.state` (`started` / `stopped`) for a boat that
has no NMEA 2000 engine data, by inferring engine-on from the **alternator
temperature** and the **house battery charge current**.

Plugins that want an engine signal, the anchor-alarm engine check, autostate's
`motoring`/`sailing` derivation, hour meters, can then read a standard path
without a real RPM sender.

## How it decides

Layered, most to least confident:

0. **Speed through the water clearly above true wind (STW − TWS ≥ 1 kn), in
   light-to-moderate wind (TWS < 8 kn) → ON.** A displacement keelboat never
   sails faster than the wind in light air, so this combination can only be the
   engine. Relative rather than an absolute TWS threshold, so it doesn't have to
   be re-tuned as the light wind wanders. Uses only the boat's own wind and speed
   instruments, so it keeps working when the battery/alternator feed drops out —
   checked first for that reason. Window means, tolerant of instrument jitter.
1. **Charge current > 5 A and boat moving → ON.** Under way, only the
   engine-driven alternator pushes that much into the house bank; solar minus
   the boat's 3–4 A idle draw never nets above ~1 A. The speed gate keeps shore
   power (charging hard at the dock, SOG ~0) from reading as an engine; a
   stationary engine (warming up, charging at anchor) is caught by the
   temperature slope in step 3 instead. Movement counts for `movingGraceSec`
   (default 120) after she last made way, so rounding up to drop sails — where
   she stops for a minute with the engine running — does not drop the state.
2. **Charge current ≤ 1 A and SoC < full → OFF.** A running alternator with room
   to charge would be pushing current.
3. **Otherwise the alternator temperature slope** over the last 10 minutes:
   rising = on, falling = cooling down (off), flat-and-hot = running.

Current/SoC samples older than `maxSampleAgeSec` (default 120 s) are treated as
unknown, so a single stale reading cannot pin the state. When nothing is known
the state is left unchanged rather than forced to `stopped`. A changed state
must persist for `changeHoldSec` (default 30 s) before it is published, so a
brief dip past a threshold does not flap the output.

## Requirements

- Signal K Server (Node ≥ 18)
- Source paths on the bus (defaults, all configurable):
  - `electrical.batteries.House.current` (A, positive = charging)
  - `electrical.batteries.House.capacity.stateOfCharge` (0..1)
  - `environment.alternator.temperature` (K or °C)

## Install (onboard, as a linked local plugin)

```bash
cd signalk-derived-engine-state && npm install && npm link
cd ~/.signalk && npm link signalk-derived-engine-state
# then restart signalk-server
```

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `propulsionInstance` | `0` | Published as `propulsion.<instance>.state` |
| `currentPath` | `electrical.batteries.House.current` | Charge current source |
| `socPath` | `electrical.batteries.House.capacity.stateOfCharge` | State of charge source |
| `alternatorPath` | `environment.alternator.temperature` | Alternator temperature source |
| `speedPath` | `navigation.speedOverGround` | Boat speed (SOG) for the movement gate |
| `stwPath` | `navigation.speedThroughWater` | Speed through water (wind rule) |
| `twsPath` | `environment.wind.speedTrue` | True wind speed (wind rule) |
| `twaPath` | `environment.wind.angleTrueWater` | True wind angle (close-hauled gate) |
| `onCurrentA` | `5` | Current that means engine ON |
| `offCurrentA` | `1` | Current at/below which the engine is OFF when not full |
| `fullSoc` | `0.995` | SoC treated as full |
| `hotC` | `30` | Temperature that counts as hot/running (°C) |
| `riseSlopeCPerMin` | `0.03` | Rise above which the engine is ON |
| `coolSlopeCPerMin` | `0.02` | Fall below which the engine is cooling (OFF) |
| `slopeWindowSec` | `600` | Window for the temperature slope |
| `maxSampleAgeSec` | `120` | Ignore current/SoC samples older than this |
| `tempMaxAgeSec` | `600` | Ignore alternator temperature older than this (looser; it updates slowly) |
| `changeHoldSec` | `30` | A new state must persist this long before publishing |
| `flipGraceSec` | `10` | Tolerate a contrary decision shorter than this without restarting the timer |
| `windStwOverTwsKnots` | `1` | STW this much above TWS (in light wind) = engine ON; `0` disables the wind rule |
| `windTwsCapKnots` | `8` | Only apply the wind rule below this true wind |
| `windMinStwKnots` | `3` | And speed through water at least this |
| `windMaxTwaDeg` | `60` | Only apply the wind rule close-hauled, within this \|TWA\|; `0` disables the gate |
| `windSustainSec` | `180` | The wind rule must hold this long (averaged) before it means ON |
| `minMovingKnots` | `1` | Boat must move faster than this for charge current to mean ON |
| `movingHoldSec` | `15` | Movement must be sustained this long to count |
| `movingGraceSec` | `120` | Charge current still counts as the alternator this long after she last made way, so a round-up does not drop the state |
| `publishMeta` | `true` | Publish metadata (description) for the state path |
| `writeToInflux` | `true` | Also write transitions straight to InfluxDB (for the logbook/Grafana and backfill) |
| `influxHost`/`influxPort`/`influxDatabase` | `localhost`/`8086`/`libelle` | InfluxDB target |
| `influxUsername`/`influxPassword` | — | InfluxDB auth (optional, blank if disabled) |

## Persistence & backfill

With `writeToInflux` on, each transition is written to InfluxDB as the string
measurement `propulsion.<instance>.state` (in addition to the Signal K delta), so
consumers that read history (the sailing logbook, Grafana) get it regardless of
whether `signalk-to-influxdb` stores string paths.

To reconstruct history, replay recorded sensor data through the same detector:

```bash
# one-shot CLI (runs against InfluxDB directly, no Signal K auth)
node backfill-run.js 2026-05-01T00:00:00Z 2026-06-01T00:00:00Z   # add --dry to preview
# or the admin route:
# POST /plugins/signalk-derived-engine-state/backfill  { "from": <ms>, "to": <ms> }
```

Backfill is idempotent (it clears the range before writing). Run it in monthly
chunks over long spans to stay under the InfluxDB query timeout.

## License

MIT
