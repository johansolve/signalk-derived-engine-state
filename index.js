/*
 * signalk-derived-engine-state
 *
 * Publishes propulsion.<instance>.state ("started"/"stopped") for a boat with no
 * NMEA 2000 engine data, by inferring engine-on from the alternator temperature
 * and the house battery charge current. This gives plugins that want an engine
 * signal (anchor alarm engine-check, autostate's motoring/sailing, hour meters)
 * something to read without a real RPM sender.
 *
 * State is judged incrementally in lib/detector.js. This file handles the Signal
 * K wiring: subscribing to the source paths, debouncing the decision so a brief
 * dip past a threshold does not flap the state, and emitting the delta only when
 * the state actually changes. Sample time is server receive time (Date.now()),
 * ignoring each delta's own timestamp, because the eMux GPS source aboard
 * sometimes reports a wrong (year-2061) time.
 */

const { createEngineDetector, createDebouncer } = require('./lib/detector')
const { makeInflux } = require('./lib/influx')
const { replay } = require('./lib/backfill')

module.exports = function (app) {
  const plugin = {}
  let unsubscribes = []
  let detector = null
  let debouncer = null
  let influx = null
  let timer = null
  let statePath = 'propulsion.0.state'
  let options = {}

  plugin.id = 'signalk-derived-engine-state'
  plugin.name = 'Derived Engine State'
  plugin.description =
    'Infers propulsion.<instance>.state (started/stopped) from alternator ' +
    'temperature and house charge current when there is no engine RPM source.'

  plugin.schema = {
    type: 'object',
    properties: {
      propulsionInstance: {
        type: 'string',
        title: 'Propulsion instance',
        description: 'Published as propulsion.<instance>.state. "0" matches the NMEA 2000 convention for a single engine.',
        default: '0'
      },
      currentPath: {
        type: 'string',
        title: 'Charge current path (A, positive = charging)',
        default: 'electrical.batteries.House.current'
      },
      socPath: {
        type: 'string',
        title: 'State of charge path (0..1)',
        default: 'electrical.batteries.House.capacity.stateOfCharge'
      },
      alternatorPath: {
        type: 'string',
        title: 'Alternator temperature path (K or °C)',
        default: 'environment.alternator.temperature'
      },
      speedPath: {
        type: 'string',
        title: 'Speed over ground path (m/s)',
        default: 'navigation.speedOverGround'
      },
      minMovingKnots: {
        type: 'number',
        title: 'Boat must move faster than this for charge current to mean ON (kn)',
        description: 'Keeps shore power at the dock from reading as an engine. Set 0 to disable the speed gate.',
        default: 1
      },
      movingHoldSec: {
        type: 'number',
        title: 'Movement must be sustained this long to count (s)',
        description: 'Rejects single SOG spikes from GPS glitches.',
        default: 15
      },
      movingGraceSec: {
        type: 'number',
        title: 'Charge current still counts as the alternator this long after the boat last made way (s)',
        description: 'Rounding up to drop sails, or holding station, takes the boat under the speed threshold for a minute or two with the engine plainly running. Without this the state drops out exactly there. Keep it well short of a stay alongside, where the current becomes shore power.',
        default: 120
      },
      windStwOverTwsKnots: {
        type: 'number',
        title: 'STW this much above TWS (in light wind) = engine ON (kn)',
        description: 'A displacement keelboat never sails faster than the true wind in light air, so STW clearly above TWS can only be the engine. Independent of the battery feed. Set 0 to disable the wind rule.',
        default: 1
      },
      windTwsCapKnots: {
        type: 'number',
        title: 'Only apply the wind rule below this true wind (kn)',
        default: 8
      },
      windMinStwKnots: {
        type: 'number',
        title: 'And speed through water at least this (kn)',
        default: 3
      },
      windSustainSec: {
        type: 'number',
        title: 'The wind rule must hold (on average) this long before it means ON (s)',
        description: 'A boat carrying way through a lull can briefly out-run the light true wind; only a running engine sustains it. Averaged over this window so a transient lull-carry does not trip a false engine-ON.',
        default: 180
      },
      windMaxTwaDeg: {
        type: 'number',
        title: 'Only apply the wind rule close-hauled, within this |TWA| (deg)',
        description: 'A keelboat cannot out-run the true wind upwind, but on a reach or run it can, so STW > TWS there is not proof of an engine. The wind rule is gated to a mean |TWA| below this. Requires a true wind angle; 0 disables the gate.',
        default: 60
      },
      twsPath: {
        type: 'string',
        title: 'True wind speed path (m/s)',
        default: 'environment.wind.speedTrue'
      },
      stwPath: {
        type: 'string',
        title: 'Speed through water path (m/s)',
        default: 'navigation.speedThroughWater'
      },
      twaPath: {
        type: 'string',
        title: 'True wind angle path (rad, for the point-of-sail gate)',
        default: 'environment.wind.angleTrueWater'
      },
      onCurrentA: {
        type: 'number',
        title: 'Charge current that means engine ON (A)',
        default: 5
      },
      offCurrentA: {
        type: 'number',
        title: 'Charge current at/below which the engine is OFF when not full (A)',
        default: 1
      },
      fullSoc: {
        type: 'number',
        title: 'State of charge treated as full (0..1)',
        default: 0.995
      },
      hotC: {
        type: 'number',
        title: 'Alternator temperature that counts as hot/running (°C)',
        default: 30
      },
      riseSlopeCPerMin: {
        type: 'number',
        title: 'Temp rise (°C/min) above which the engine is ON',
        default: 0.03
      },
      coolSlopeCPerMin: {
        type: 'number',
        title: 'Temp fall (°C/min) below which the engine is cooling (OFF)',
        default: 0.02
      },
      slopeWindowSec: {
        type: 'number',
        title: 'Window for the temperature slope (s)',
        default: 600
      },
      maxSampleAgeSec: {
        type: 'number',
        title: 'Ignore current/SoC samples older than this (s)',
        default: 120
      },
      tempMaxAgeSec: {
        type: 'number',
        title: 'Ignore alternator temperature older than this (s)',
        description: 'Looser than the current/SoC bound because temperature updates slowly. Past this the temp layer goes unknown instead of holding stale state.',
        default: 600
      },
      changeHoldSec: {
        type: 'number',
        title: 'A new state must persist this long before it is published (s)',
        default: 30
      },
      flipGraceSec: {
        type: 'number',
        title: 'Tolerate a contrary decision shorter than this without restarting the timer (s)',
        default: 10
      },
      publishMeta: {
        type: 'boolean',
        title: 'Publish metadata (description) for the state path',
        default: true
      },
      writeToInflux: {
        type: 'boolean',
        title: 'Also write state transitions straight to InfluxDB',
        description: 'Guarantees the state lands in InfluxDB (for the logbook and Grafana) regardless of whether signalk-to-influxdb stores string paths. Also required for backfill.',
        default: true
      },
      influxHost: {
        type: 'string',
        title: 'InfluxDB host',
        default: 'localhost'
      },
      influxPort: {
        type: 'number',
        title: 'InfluxDB port',
        default: 8086
      },
      influxDatabase: {
        type: 'string',
        title: 'InfluxDB database',
        default: 'libelle'
      },
      influxUsername: {
        type: 'string',
        title: 'InfluxDB username (optional)',
        default: ''
      },
      influxPassword: {
        type: 'string',
        title: 'InfluxDB password (optional)',
        default: ''
      }
    }
  }

  function publishMeta () {
    app.handleMessage(plugin.id, {
      updates: [
        {
          meta: [
            {
              path: statePath,
              value: {
                description: 'Engine running state, inferred from alternator temperature and house charge current',
                enum: ['started', 'stopped']
              }
            }
          ]
        }
      ]
    })
  }

  function publish (state, timeMs) {
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [{ path: statePath, value: state }]
        }
      ]
    })
    app.setPluginStatus(`${statePath} = ${state}`)
    app.debug(`published ${statePath} = ${state}`)
    // Persist the transition straight to InfluxDB so it's available to the
    // logbook/Grafana even if signalk-to-influxdb doesn't store string paths.
    if (influx) {
      influx.writeState(statePath, [[timeMs != null ? timeMs : Date.now(), state]]).catch((e) =>
        app.error(`influx write failed: ${e.message}`)
      )
    }
  }

  // Feed the current decision through the debouncer; publish on a transition.
  function apply (now) {
    const transition = debouncer.step(now, detector.evaluate(now))
    if (transition) {
      publish(transition, now)
    }
  }

  const KNOT = 0.514444 // m/s

  // Detector options from config, shared by the live loop and the backfill replay
  // so both run identical detection.
  function detectorConfig () {
    const minMovingKnots = options.minMovingKnots != null ? options.minMovingKnots : 1
    return {
      hotC: options.hotC,
      riseSlope: options.riseSlopeCPerMin,
      coolSlope: options.coolSlopeCPerMin,
      slopeWindowSec: options.slopeWindowSec,
      onCurrentA: options.onCurrentA,
      offCurrentA: options.offCurrentA,
      fullSoc: options.fullSoc,
      maxSampleAgeSec: options.maxSampleAgeSec,
      tempMaxAgeSec: options.tempMaxAgeSec,
      minMovingSpeedMs: minMovingKnots * KNOT,
      movingHoldSec: options.movingHoldSec,
      movingGraceSec: options.movingGraceSec,
      windStwOverTwsMs: (options.windStwOverTwsKnots != null ? options.windStwOverTwsKnots : 1) * KNOT,
      windTwsCapMs: (options.windTwsCapKnots != null ? options.windTwsCapKnots : 8) * KNOT,
      windMinStwMs: (options.windMinStwKnots != null ? options.windMinStwKnots : 3) * KNOT,
      windSustainSec: options.windSustainSec,
      windMaxTwaRad: (options.windMaxTwaDeg != null ? options.windMaxTwaDeg : 60) * (Math.PI / 180)
    }
  }

  function debouncerConfig () {
    return {
      holdMs: (options.changeHoldSec != null ? options.changeHoldSec : 30) * 1000,
      flipGraceMs: (options.flipGraceSec != null ? options.flipGraceSec : 10) * 1000
    }
  }

  // Build an InfluxDB client when writing/backfill is enabled, else null.
  function buildInflux () {
    if (options.writeToInflux === false) {
      return null
    }
    return makeInflux({
      host: options.influxHost || 'localhost',
      port: options.influxPort || 8086,
      database: options.influxDatabase || 'libelle',
      username: options.influxUsername || '',
      password: options.influxPassword || ''
    })
  }

  plugin.start = function (opts) {
    options = opts || {}
    const instance = options.propulsionInstance || '0'
    statePath = `propulsion.${instance}.state`

    detector = createEngineDetector(detectorConfig())
    debouncer = createDebouncer(debouncerConfig())
    influx = buildInflux()

    const currentPath = options.currentPath || 'electrical.batteries.House.current'
    const socPath = options.socPath || 'electrical.batteries.House.capacity.stateOfCharge'
    const alternatorPath = options.alternatorPath || 'environment.alternator.temperature'
    const speedPath = options.speedPath || 'navigation.speedOverGround'
    const twsPath = options.twsPath || 'environment.wind.speedTrue'
    const stwPath = options.stwPath || 'navigation.speedThroughWater'
    const twaPath = options.twaPath || 'environment.wind.angleTrueWater'

    if (options.publishMeta !== false) {
      publishMeta()
    }

    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self',
        subscribe: [
          { path: currentPath, period: 1000 },
          { path: socPath, period: 5000 },
          { path: alternatorPath, period: 5000 },
          { path: speedPath, period: 1000 },
          { path: twsPath, period: 1000 },
          { path: stwPath, period: 1000 },
          { path: twaPath, period: 1000 }
        ]
      },
      unsubscribes,
      (err) => app.error('subscription error: ' + err),
      (delta) => {
        const now = Date.now()
        ;(delta.updates || []).forEach((u) => {
          ;(u.values || []).forEach((v) => {
            if (v.path === currentPath) {
              detector.setCurrent(now, v.value)
            } else if (v.path === socPath) {
              detector.setSoc(now, v.value)
            } else if (v.path === speedPath) {
              detector.setSpeed(now, v.value)
            } else if (v.path === twsPath) {
              detector.setTws(now, v.value)
            } else if (v.path === stwPath) {
              detector.setStw(now, v.value)
            } else if (v.path === twaPath) {
              detector.setTwa(now, v.value)
            } else if (v.path === alternatorPath) {
              // Alternator temperature may arrive in Kelvin; normalise to °C.
              const c = typeof v.value === 'number' && v.value > 200 ? v.value - 273.15 : v.value
              detector.pushTemp(now, c)
            }
          })
        })
        apply(now)
      }
    )

    // Re-evaluate on a timer too, so the state can go stale->off (current stops
    // being logged) or cool->off (temperature slope) without a new delta.
    timer = setInterval(() => apply(Date.now()), 15000)

    app.setPluginStatus('Watching for engine on/off')
  }

  plugin.stop = function () {
    unsubscribes.forEach((f) => {
      try {
        f()
      } catch (e) {
        // ignore
      }
    })
    unsubscribes = []
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    detector = null
    debouncer = null
    influx = null
  }

  // Admin-guarded backfill: replay recorded history through the same detector and
  // write the reconstructed transitions to InfluxDB. POST body: { from, to } in ms
  // epoch (to > from). Idempotent: the range is cleared first.
  plugin.registerWithRouter = function (router) {
    router.post('/backfill', async (req, res) => {
      const body = req.body || {}
      const from = parseInt(body.from, 10)
      const to = parseInt(body.to, 10)
      if (!from || !to || to <= from) {
        return res.status(400).json({ error: 'from/to (ms epoch) required, to > from' })
      }
      const inf = buildInflux()
      if (!inf) {
        return res.status(409).json({ error: 'enable writeToInflux to backfill' })
      }
      try {
        const { points } = await replay({
          influx: inf,
          detectorOpts: detectorConfig(),
          debouncerOpts: debouncerConfig(),
          startMs: from,
          stopMs: to
        })
        await inf.clearState(statePath, from, to)
        const written = await inf.writeState(statePath, points)
        app.debug(`backfill ${from}..${to}: ${written} transitions`)
        res.json({ from, to, transitions: written, points })
      } catch (e) {
        app.error(`backfill failed: ${e.message}`)
        res.status(500).json({ error: e.message })
      }
    })
  }

  return plugin
}
