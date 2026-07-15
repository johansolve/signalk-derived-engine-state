/*
 * Backfill: reconstruct historical propulsion state by replaying the boat's
 * recorded sensor history through the exact same detector and debouncer the live
 * plugin uses. The output is the list of state transitions, which the caller
 * writes back to InfluxDB. Running the same code over history and over the live
 * stream is the whole point: there is one detection implementation, not two.
 */

const { createEngineDetector, createDebouncer } = require('./detector')

// Replay [startMs, stopMs] and return [[timeMs, 'started'|'stopped'], ...].
async function replay (opts) {
  const { influx, detectorOpts, debouncerOpts, startMs, stopMs } = opts
  const steps = opts.steps || {}
  const tickMs = (opts.tickSec || 60) * 1000

  const [temp, current, soc, tws, stw, sog] = await Promise.all([
    influx.alternatorSeries(startMs, stopMs, steps.electrical),
    influx.currentSeries(startMs, stopMs, steps.electrical),
    influx.socSeries(startMs, stopMs, steps.electrical),
    influx.twsSeries(startMs, stopMs, steps.wind),
    influx.stwSeries(startMs, stopMs, steps.wind),
    influx.sogSeries(startMs, stopMs, steps.wind)
  ])

  // Merge all samples into one time-ordered stream, plus periodic ticks so a
  // state can decay (cool-down, stale current) between sparse samples exactly as
  // the live 15s timer lets it.
  const events = []
  const add = (arr, kind) => {
    for (const [t, v] of arr) {
      events.push([t, kind, v])
    }
  }
  add(temp, 'temp')
  add(current, 'current')
  add(soc, 'soc')
  add(tws, 'tws')
  add(stw, 'stw')
  add(sog, 'sog')
  for (let t = Math.trunc(startMs); t <= stopMs; t += tickMs) {
    events.push([t, 'tick', null])
  }
  events.sort((a, b) => a[0] - b[0])

  const detector = createEngineDetector(detectorOpts)
  const debouncer = createDebouncer(debouncerOpts)
  const points = []

  for (const [t, kind, v] of events) {
    switch (kind) {
      case 'temp': detector.pushTemp(t, v); break
      case 'current': detector.setCurrent(t, v); break
      case 'soc': detector.setSoc(t, v); break
      case 'tws': detector.setTws(t, v); break
      case 'stw': detector.setStw(t, v); break
      case 'sog': detector.setSpeed(t, v); break
      default: break // tick: just re-evaluate
    }
    const transition = debouncer.step(t, detector.evaluate(t))
    if (transition) {
      points.push([t, transition])
    }
  }

  return { points, samples: events.length - Math.floor((stopMs - startMs) / tickMs) }
}

module.exports = { replay }
