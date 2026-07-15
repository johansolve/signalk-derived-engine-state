'use strict'

const assert = require('node:assert/strict')
const { createEngineDetector, createDebouncer } = require('../lib/detector')

const KNOT = 0.514444
const T = 1700000000000
const at = (s) => T + s * 1000

describe('createEngineDetector', function () {
  it('is unknown with no data', function () {
    const d = createEngineDetector({})
    assert.equal(d.evaluate(at(0)), null)
  })

  it('charge current above threshold while moving = on', function () {
    const d = createEngineDetector({ minMovingSpeedMs: 1 * KNOT })
    for (let s = 0; s <= 30; s += 5) {
      d.setSpeed(at(s), 3)
      d.setCurrent(at(s), 25)
    }
    assert.equal(d.evaluate(at(30)), true)
  })

  it('high charge current but stationary is not on (shore power)', function () {
    const d = createEngineDetector({ minMovingSpeedMs: 1 * KNOT })
    for (let s = 0; s <= 60; s += 5) {
      d.setSpeed(at(s), 0)
      d.setCurrent(at(s), 25)
    }
    assert.equal(d.evaluate(at(60)), null)
  })

  it('a lone SOG spike does not count as moving', function () {
    const d = createEngineDetector({ minMovingSpeedMs: 1 * KNOT })
    for (let s = 0; s <= 60; s += 5) {
      d.setSpeed(at(s), s === 40 ? 3 : 0)
      d.setCurrent(at(s), 25)
    }
    assert.equal(d.evaluate(at(60)), null)
  })

  it('a stale current sample does not pin the state', function () {
    const d = createEngineDetector({ maxSampleAgeSec: 120 })
    d.setCurrent(at(0), 30)
    assert.equal(d.evaluate(at(300)), null)
  })

  it('low current with a not-full battery = off', function () {
    const d = createEngineDetector({})
    d.setCurrent(at(0), 0.5)
    d.setSoc(at(0), 0.8)
    assert.equal(d.evaluate(at(1)), false)
  })

  it('wind rule: fast through water in light wind = on', function () {
    const d = createEngineDetector({ windStwOverTwsMs: 1 * KNOT, windTwsCapMs: 8 * KNOT, windMinStwMs: 3 * KNOT })
    for (let s = 0; s <= 30; s += 5) {
      d.setTws(at(s), 3 * KNOT)
      d.setStw(at(s), 5.3 * KNOT)
    }
    assert.equal(d.evaluate(at(30)), true)
  })

  it('wind rule does not fire when the wind explains the speed', function () {
    const d = createEngineDetector({ windStwOverTwsMs: 1 * KNOT, windTwsCapMs: 8 * KNOT, windMinStwMs: 3 * KNOT })
    for (let s = 0; s <= 30; s += 5) {
      d.setTws(at(s), 8 * KNOT)
      d.setStw(at(s), 4 * KNOT)
    }
    assert.equal(d.evaluate(at(30)), null)
  })

  it('wind rule is disabled only by windStwOverTws <= 0', function () {
    const d = createEngineDetector({ windStwOverTwsMs: 0, windTwsCapMs: 8 * KNOT, windMinStwMs: 3 * KNOT })
    for (let s = 0; s <= 30; s += 5) {
      d.setTws(at(s), 1 * KNOT)
      d.setStw(at(s), 5 * KNOT)
    }
    assert.equal(d.evaluate(at(30)), null)
  })

  it('temperature slope: rising = on, cooling = off, flat-hot = on', function () {
    const rising = createEngineDetector({})
    const cooling = createEngineDetector({})
    const flat = createEngineDetector({})
    for (let s = 0; s <= 300; s += 30) {
      rising.pushTemp(at(s), 20 + s * 0.02)
      cooling.pushTemp(at(s), 50 - s * 0.02)
      flat.pushTemp(at(s), 50)
    }
    assert.equal(rising.evaluate(at(300)), true)
    assert.equal(cooling.evaluate(at(300)), false)
    assert.equal(flat.evaluate(at(300)), true)
  })

  it('stale temperature no longer answers', function () {
    const d = createEngineDetector({ tempMaxAgeSec: 600 })
    for (let s = 0; s <= 120; s += 30) {
      d.pushTemp(at(s), 50)
    }
    assert.equal(d.evaluate(at(820)), null)
  })

  it('least-squares slope shrugs off a single noisy endpoint', function () {
    const d = createEngineDetector({})
    const vals = [50, 50.1, 50.2, 49.9, 50.3, 50.0, 50.1, 50.2, 50.3, 49.7]
    let k = 0
    for (let s = 0; s <= 270; s += 30) {
      d.pushTemp(at(s), vals[k++])
    }
    assert.equal(d.evaluate(at(270)), true)
  })
})

describe('createDebouncer', function () {
  it('emits a transition after the hold', function () {
    const d = createDebouncer({ holdMs: 30000, flipGraceMs: 10000 })
    const out = []
    for (let s = 0; s <= 40; s += 5) {
      const r = d.step(at(s), true)
      if (r) out.push([s, r])
    }
    assert.deepEqual(out, [[30, 'started']])
  })

  it('tolerates a brief contrary blip', function () {
    const d = createDebouncer({ holdMs: 30000, flipGraceMs: 10000 })
    const out = []
    for (let s = 0; s <= 40; s += 5) {
      const r = d.step(at(s), s === 20 ? false : true)
      if (r) out.push([s, r])
    }
    assert.deepEqual(out, [[30, 'started']])
  })

  it('null holds the pending candidate', function () {
    const d = createDebouncer({ holdMs: 30000, flipGraceMs: 10000 })
    const out = []
    for (let s = 0; s <= 40; s += 5) {
      const r = d.step(at(s), s === 20 ? null : true)
      if (r) out.push([s, r])
    }
    assert.deepEqual(out, [[30, 'started']])
  })

  it('switches candidate when the contrary decision persists', function () {
    const d = createDebouncer({ holdMs: 30000, flipGraceMs: 10000 })
    const out = []
    for (let s = 0; s <= 80; s += 5) {
      const r = d.step(at(s), s < 15 ? true : false)
      if (r) out.push([s, r])
    }
    assert.deepEqual(out, [[55, 'stopped']])
  })
})
