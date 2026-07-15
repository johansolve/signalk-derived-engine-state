/*
 * InfluxDB 1.x access for the backfill and for persisting live transitions.
 *
 * Reads the same raw history the boat already stores (alternator temperature,
 * house current, state of charge, true wind, speed through water, speed over
 * ground) so the backfill can replay it through the detector, and writes the
 * resulting propulsion.<n>.state transitions back as a string measurement so the
 * logbook (and Grafana) can read them without re-deriving anything.
 */

const DEFAULT_PATHS = {
  alternator: 'environment.alternator.temperature',
  current: 'electrical.batteries.House.current',
  soc: 'electrical.batteries.House.capacity.stateOfCharge',
  tws: 'environment.wind.speedTrue',
  stw: 'navigation.speedThroughWater',
  sog: 'navigation.speedOverGround'
}

function quoteMeasurement (m) {
  return m.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Escape a measurement name for line protocol (commas and spaces).
function escapeMeasurement (m) {
  return m.replace(/,/g, '\\,').replace(/ /g, '\\ ')
}

function makeInflux (config) {
  const paths = Object.assign({}, DEFAULT_PATHS, config.paths || {})
  const base = `http://${config.host}:${config.port}`
  const auth = config.username
    ? { u: config.username, p: config.password || '' }
    : null

  async function query (statements) {
    const params = new URLSearchParams({
      db: config.database,
      epoch: 'ms',
      q: Array.isArray(statements) ? statements.join('; ') : statements
    })
    if (auth) {
      params.set('u', auth.u)
      params.set('p', auth.p)
    }
    const resp = await fetch(`${base}/query?${params.toString()}`, {
      signal: AbortSignal.timeout(config.timeoutMs || 60000)
    })
    if (!resp.ok) {
      throw new Error(`InfluxDB HTTP ${resp.status}`)
    }
    const body = await resp.json()
    if (body.error) {
      throw new Error(body.error)
    }
    return (body.results || []).map((r) => {
      if (r.error) {
        throw new Error(r.error)
      }
      const serie = r.series && r.series[0]
      return serie ? serie.values : []
    })
  }

  function windowClause (startMs, stopMs) {
    const lo = Math.trunc(Number(startMs))
    const hi = Math.trunc(Number(stopMs))
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error('window bounds must be numeric epoch-ms')
    }
    return `time >= ${lo}ms AND time <= ${hi}ms`
  }

  // Downsampled [[t, v], ...] mean series. kelvin=true converts K to °C.
  async function series (measurement, startMs, stopMs, stepSec, kelvin) {
    const m = quoteMeasurement(measurement)
    const [rows] = await query(
      `SELECT mean("value") AS v FROM "${m}" ` +
        `WHERE ${windowClause(startMs, stopMs)} ` +
        `GROUP BY time(${Math.max(1, Math.trunc(stepSec))}s) fill(none)`
    )
    return rows
      .map((r) => [r[0], r[1] == null ? null : kelvin && r[1] > 200 ? r[1] - 273.15 : r[1]])
      .filter((p) => p[1] != null)
  }

  return {
    alternatorSeries: (a, b, step) => series(paths.alternator, a, b, step || 60, true),
    currentSeries: (a, b, step) => series(paths.current, a, b, step || 60, false),
    socSeries: (a, b, step) => series(paths.soc, a, b, step || 60, false),
    twsSeries: (a, b, step) => series(paths.tws, a, b, step || 10, false),
    stwSeries: (a, b, step) => series(paths.stw, a, b, step || 10, false),
    sogSeries: (a, b, step) => series(paths.sog, a, b, step || 10, false),

    // Delete any existing state points in [startMs, stopMs] so a re-run of the
    // backfill replaces rather than layers on top.
    async clearState (measurement, startMs, stopMs) {
      const m = quoteMeasurement(measurement)
      await query(`DELETE FROM "${m}" WHERE ${windowClause(startMs, stopMs)}`)
    },

    // Write state transitions. points = [[timeMs, 'started'|'stopped'], ...].
    async writeState (measurement, points) {
      if (!points.length) {
        return 0
      }
      const name = escapeMeasurement(measurement)
      const lines = points.map(([t, state]) => `${name} value="${state}" ${Math.trunc(t)}`)
      const params = new URLSearchParams({ db: config.database, precision: 'ms' })
      if (auth) {
        params.set('u', auth.u)
        params.set('p', auth.p)
      }
      const resp = await fetch(`${base}/write?${params.toString()}`, {
        method: 'POST',
        body: lines.join('\n'),
        signal: AbortSignal.timeout(config.timeoutMs || 60000)
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`InfluxDB write HTTP ${resp.status} ${text}`.trim())
      }
      return points.length
    }
  }
}

module.exports = { makeInflux, DEFAULT_PATHS }
