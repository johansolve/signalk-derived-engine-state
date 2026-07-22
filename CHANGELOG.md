# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
