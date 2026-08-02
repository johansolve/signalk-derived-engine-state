# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **The state dropped out through a round-up.** The charge-current rule is gated
  on the boat moving, so a shore lead is not mistaken for the alternator. But
  rounding up to drop sails takes her under the threshold for a minute or two
  with the engine plainly running: on 2026-08-02 the speed fell to 0.2–0.6 kn for
  twenty seconds and the state went to `stopped` mid-manoeuvre, which is exactly
  where a consumer needs it (the sailing logbook uses it to reject false tacks).
  Movement now only has to be *recent*, within `movingGraceSec` (default 120),
  which is far longer than any round-up. That is also how long a shore lead
  plugged in straight after a passage can keep the current rule asserting ON;
  past it the rule falls silent and the temperature slope decides, which on a
  shut engine reads as cooling. The moment is
  recorded when the speed sample arrives rather than inside `evaluate()`, so a
  spell carried by the wind rule cannot leave it stale, and `evaluate()` stays a
  function of the buffers and the time it is asked about — live and a replay
  agree however often either calls it.

## [0.1.0] - 2026-07-22

### Added
- Initial release. Publishes `propulsion.<instance>.state` (`started` / `stopped`)
  for a boat with no NMEA 2000 engine data, inferring engine-on from a layered
  set of signals: speed through the water clearly above the true wind in light
  air (gated to close-hauled and required to hold), house charge current while
  moving, low charge current below full state of charge, and the alternator
  temperature slope.
- Optional write of each transition straight to InfluxDB, so history consumers
  (the sailing logbook, Grafana) get the state regardless of whether
  `signalk-to-influxdb` stores string paths.
- Retrospective backfill through the same detector, as a one-shot CLI
  (`backfill-run.js`) or an admin route.
