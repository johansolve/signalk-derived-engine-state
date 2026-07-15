'use strict'

const assert = require('node:assert/strict')
const { replay } = require('../lib/backfill')

const KNOT = 0.514444
const T = 1700000000000
const at = (s) => T + s * 1000

// Minimal in-memory InfluxDB stand-in: pre-canned series, records writes.
function mockInflux (series) {
  return {
    alternatorSeries: async () => series.temp || [],
    currentSeries: async () => series.current || [],
    socSeries: async () => series.soc || [],
    twsSeries: async () => series.tws || [],
    stwSeries: async () => series.stw || [],
    sogSeries: async () => series.sog || []
  }
}

const detectorOpts = { minMovingSpeedMs: 1 * KNOT }
const debouncerOpts = { holdMs: 30000, flipGraceMs: 10000 }

describe('backfill replay', function () {
  it('reconstructs a start and a stop from recorded history', async function () {
    const temp = []
    const current = []
    const sog = []
    for (let s = 0; s <= 3600; s += 60) {
      temp.push([at(s), s < 1800 ? 30 + s * 0.01 : 48 - (s - 1800) * 0.005])
      current.push([at(s), s < 1800 ? 25 : -1])
    }
    for (let s = 0; s <= 3600; s += 10) {
      sog.push([at(s), s < 1800 ? 3 : 0])
    }
    const { points } = await replay({
      influx: mockInflux({ temp, current, sog }),
      detectorOpts,
      debouncerOpts,
      startMs: T,
      stopMs: at(3600)
    })
    const states = points.map((p) => p[1])
    assert.deepEqual(states, ['started', 'stopped'])
    assert.ok(points[0][0] < at(200), 'starts early')
    assert.ok(points[1][0] > at(1800), 'stops after the engine goes off')
  })

  it('produces nothing from empty history', async function () {
    const { points } = await replay({
      influx: mockInflux({}),
      detectorOpts,
      debouncerOpts,
      startMs: T,
      stopMs: at(600)
    })
    assert.deepEqual(points, [])
  })
})
