'use strict'

const assert = require('node:assert/strict')
const { createEngineDetector, createDebouncer } = require('../lib/detector')

const KNOT = 0.514444
const DEG = Math.PI / 180
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

  it('stays on through a round-up, when she was making way just before', function () {
    // 2026-08-02: rounding up to drop sails took her to 0.2-0.6 kn for twenty
    // seconds with the alternator pushing 16 A. The gate is there to tell the
    // alternator from shore power, and shore power does not arrive mid-manoeuvre.
    const d = createEngineDetector({ minMovingSpeedMs: 1 * KNOT })
    for (let s = 0; s <= 60; s += 5) {
      d.setSpeed(at(s), 3)
      d.setCurrent(at(s), 25)
    }
    assert.equal(d.evaluate(at(60)), true)
    for (let s = 65; s <= 85; s += 5) {
      d.setSpeed(at(s), 0.2)
      d.setCurrent(at(s), 16)
    }
    assert.equal(d.evaluate(at(85)), true, 'twenty seconds stopped is a round-up')
  })

  it('but lets go once she has been stopped long enough to be alongside', function () {
    // The grace has to expire, or a shore lead plugged in after a passage would
    // read as the engine for as long as it stayed plugged in.
    const d = createEngineDetector({ minMovingSpeedMs: 1 * KNOT, movingGraceSec: 120 })
    for (let s = 0; s <= 60; s += 5) {
      d.setSpeed(at(s), 3)
      d.setCurrent(at(s), 25)
    }
    for (let s = 65; s <= 300; s += 5) {
      d.setSpeed(at(s), 0)
      d.setCurrent(at(s), 25) // shore power, indistinguishable by current alone
    }
    assert.equal(d.evaluate(at(150)), true, 'still inside the grace')
    assert.equal(d.evaluate(at(300)), null, 'past it the gate closes again')
  })

  it('refreshes the grace whenever she makes way again', function () {
    const d = createEngineDetector({ minMovingSpeedMs: 1 * KNOT, movingGraceSec: 60 })
    for (let s = 0; s <= 60; s += 5) {
      d.setSpeed(at(s), 3)
      d.setCurrent(at(s), 25)
    }
    // Stop, go, stop again: each spell under way resets the clock, so the gate
    // never latches on and never times out mid-passage.
    for (let s = 65; s <= 100; s += 5) { d.setSpeed(at(s), 0); d.setCurrent(at(s), 25) }
    for (let s = 105; s <= 160; s += 5) { d.setSpeed(at(s), 3); d.setCurrent(at(s), 25) }
    assert.equal(d.evaluate(at(160)), true)
    for (let s = 165; s <= 200; s += 5) { d.setSpeed(at(s), 0); d.setCurrent(at(s), 25) }
    assert.equal(d.evaluate(at(200)), true, 'the grace runs from the later spell')
  })

  it('does not grant grace to a clock that has stepped backwards', function () {
    // A Pi without an RTC boots on a stale clock and jumps when NTP lands. The
    // moment she last made way is then in the future, and must not read as
    // "recently" for however long the step was.
    const d = createEngineDetector({ minMovingSpeedMs: 1 * KNOT, movingGraceSec: 120 })
    for (let s = 3600; s <= 3660; s += 5) {
      d.setSpeed(at(s), 3)
      d.setCurrent(at(s), 25)
    }
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

  it('wind rule: fast through water in light wind (close-hauled) = on', function () {
    const d = createEngineDetector({ windStwOverTwsMs: 1 * KNOT, windTwsCapMs: 8 * KNOT, windMinStwMs: 3 * KNOT, windSustainSec: 20 })
    for (let s = 0; s <= 30; s += 5) {
      d.setTws(at(s), 3 * KNOT)
      d.setStw(at(s), 5.3 * KNOT)
      d.setTwa(at(s), 35 * DEG)
    }
    assert.equal(d.evaluate(at(30)), true)
  })

  it('wind rule does not fire when the wind explains the speed', function () {
    const d = createEngineDetector({ windStwOverTwsMs: 1 * KNOT, windTwsCapMs: 8 * KNOT, windMinStwMs: 3 * KNOT, windSustainSec: 20 })
    for (let s = 0; s <= 30; s += 5) {
      d.setTws(at(s), 8 * KNOT)
      d.setStw(at(s), 4 * KNOT)
      d.setTwa(at(s), 35 * DEG)
    }
    assert.equal(d.evaluate(at(30)), null)
  })

  it('wind rule is blocked on a reach even when STW stays above TWS (the Flakfortet→Rungsted case)', function () {
    const d = createEngineDetector({ windStwOverTwsMs: 1 * KNOT, windTwsCapMs: 8 * KNOT, windMinStwMs: 3 * KNOT, windSustainSec: 20 })
    // Sustained STW well above TWS, which upwind would mean engine — but on a
    // broad reach a keelboat can out-run a light true wind under sail, so the
    // point-of-sail gate must keep it OFF.
    for (let s = 0; s <= 40; s += 5) {
      d.setTws(at(s), 3.7 * KNOT)
      d.setStw(at(s), 5.6 * KNOT)
      d.setTwa(at(s), 115 * DEG)
    }
    assert.equal(d.evaluate(at(40)), null)
  })

  it('wind rule stays silent without a true wind angle (cannot confirm close-hauled)', function () {
    const d = createEngineDetector({ windStwOverTwsMs: 1 * KNOT, windTwsCapMs: 8 * KNOT, windMinStwMs: 3 * KNOT, windSustainSec: 20 })
    for (let s = 0; s <= 40; s += 5) {
      d.setTws(at(s), 3 * KNOT)
      d.setStw(at(s), 5.3 * KNOT)
      // no setTwa
    }
    assert.equal(d.evaluate(at(40)), null)
  })

  it('wind rule ignores a transient lull-carry (sailing, not engine)', function () {
    const d = createEngineDetector({ windStwOverTwsMs: 1 * KNOT, windTwsCapMs: 8 * KNOT, windMinStwMs: 3 * KNOT })
    // Close-hauled throughout (gate open), sailing slower than the wind for three
    // minutes...
    for (let s = 0; s <= 180; s += 5) {
      d.setTws(at(s), 8 * KNOT)
      d.setStw(at(s), 5.5 * KNOT)
      d.setTwa(at(s), 35 * DEG)
    }
    // ...then the wind drops for a minute while the boat carries its way, so STW
    // briefly exceeds TWS. Averaged over the sustain window it is still sailing.
    for (let s = 185; s <= 240; s += 5) {
      d.setTws(at(s), 3.5 * KNOT)
      d.setStw(at(s), 5.5 * KNOT)
      d.setTwa(at(s), 35 * DEG)
    }
    assert.equal(d.evaluate(at(240)), null)
  })

  it('wind rule fires when the speed excess is sustained close-hauled (engine)', function () {
    const d = createEngineDetector({ windStwOverTwsMs: 1 * KNOT, windTwsCapMs: 8 * KNOT, windMinStwMs: 3 * KNOT })
    // STW a steady 2 kn above the light true wind, close-hauled, for over three
    // minutes: upwind only an engine holds that.
    for (let s = 0; s <= 200; s += 5) {
      d.setTws(at(s), 3.5 * KNOT)
      d.setStw(at(s), 5.5 * KNOT)
      d.setTwa(at(s), 35 * DEG)
    }
    assert.equal(d.evaluate(at(200)), true)
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
