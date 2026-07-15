#!/usr/bin/env node
/*
 * One-shot backfill runner. Replays recorded history through the same detector
 * as the live plugin and writes propulsion.<n>.state transitions to InfluxDB.
 * Runs directly against InfluxDB, so it needs no Signal K auth.
 *
 *   node backfill-run.js <fromISO> <toISO> [--instance 0] [--db libelle]
 *                        [--host localhost] [--port 8086] [--dry]
 *
 * --dry prints the transitions without writing.
 */

const { makeInflux } = require('./lib/influx')
const { replay } = require('./lib/backfill')

const KNOT = 0.514444

// Same defaults as the plugin schema, so backfill detects identically to live.
const detectorOpts = {
  hotC: 30,
  riseSlope: 0.03,
  coolSlope: 0.02,
  slopeWindowSec: 600,
  onCurrentA: 5,
  offCurrentA: 1,
  fullSoc: 0.995,
  maxSampleAgeSec: 120,
  tempMaxAgeSec: 600,
  minMovingSpeedMs: 1 * KNOT,
  movingHoldSec: 15,
  windStwOverTwsMs: 1 * KNOT,
  windTwsCapMs: 8 * KNOT,
  windMinStwMs: 3 * KNOT
}
const debouncerOpts = { holdMs: 30000, flipGraceMs: 10000 }

function arg (name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

async function main () {
  const [, , fromStr, toStr] = process.argv
  if (!fromStr || !toStr) {
    console.error('usage: node backfill-run.js <fromISO> <toISO> [--instance 0] [--db libelle] [--host localhost] [--port 8086] [--dry]')
    process.exit(1)
  }
  const from = Date.parse(fromStr)
  const to = Date.parse(toStr)
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) {
    console.error('bad from/to (need parseable dates, to > from)')
    process.exit(1)
  }
  const dry = process.argv.includes('--dry')
  const statePath = `propulsion.${arg('instance', '0')}.state`
  const influx = makeInflux({
    host: arg('host', 'localhost'),
    port: parseInt(arg('port', '8086'), 10),
    database: arg('db', 'libelle')
  })

  const { points, samples } = await replay({ influx, detectorOpts, debouncerOpts, startMs: from, stopMs: to })
  console.log(`replayed ${samples} samples over ${fromStr}..${toStr}`)
  for (const [t, state] of points) {
    console.log(`  ${new Date(t).toISOString()}  ${state}`)
  }
  if (dry) {
    console.log(`[dry] ${points.length} transitions, not written`)
    return
  }
  await influx.clearState(statePath, from, to)
  const written = await influx.writeState(statePath, points)
  console.log(`wrote ${written} transitions to ${statePath}`)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
