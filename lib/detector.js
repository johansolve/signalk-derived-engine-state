/*
 * Live engine-on detection, layered from most to least confident. This is the
 * incremental sibling of the sailing-logbook's engine.js: instead of scanning a
 * whole InfluxDB window it is fed one sample at a time and asked for the current
 * state.
 *
 *  0. Speed through the water clearly above the true wind speed (STW − TWS >=
 *     windStwOverTws), in light-to-moderate wind (TWS < windTwsCap) -> engine ON.
 *     A displacement keelboat never sails faster than the wind in light air. This
 *     rule uses only the boat's own wind/speed instruments, so it keeps working
 *     when the battery/alternator feed drops out (checked first for that reason).
 *  1. House charge current > onCurrent (5 A) AND boat moving -> engine ON. Under
 *     way the only thing that pushes that much into the house bank is the
 *     engine-driven alternator; solar minus the boat's 3-4 A idle draw never
 *     nets above ~1 A. The speed gate keeps shore power (charging hard at the
 *     dock, SOG ~0) from reading as an engine; a stationary engine (warming up,
 *     charging at anchor) is instead caught by the temperature slope in step 3.
 *  2. Charge current <= offCurrent (1 A) and SoC < full -> engine OFF. A running
 *     alternator with room to charge would be pushing current.
 *  3. Otherwise the alternator-temperature slope over the last windowMs:
 *     rising = on, falling = cooling down (off), flat-and-hot = running.
 *
 * Robustness (over the batch version): current/SoC samples older than maxAgeMs
 * are treated as unknown, so a single stale reading can no longer pin the state
 * for hours. When nothing is known, evaluate() returns null (unknown) rather
 * than asserting "stopped" on no evidence.
 */

function createEngineDetector (opts) {
  opts = opts || {}
  const hotC = opts.hotC != null ? opts.hotC : 30
  const riseSlope = opts.riseSlope != null ? opts.riseSlope : 0.03 // °C/min
  const coolSlope = opts.coolSlope != null ? opts.coolSlope : 0.02 // °C/min
  const windowMs = (opts.slopeWindowSec != null ? opts.slopeWindowSec : 600) * 1000
  const onCurrent = opts.onCurrentA != null ? opts.onCurrentA : 5
  const offCurrent = opts.offCurrentA != null ? opts.offCurrentA : 1
  const fullSoc = opts.fullSoc != null ? opts.fullSoc : 0.995
  const maxAgeMs = (opts.maxSampleAgeSec != null ? opts.maxSampleAgeSec : 120) * 1000
  // Alternator temperature updates far more slowly than current (minutes apart on
  // this boat), so it gets its own, looser staleness bound. Past this the last
  // reading no longer speaks for "now" and the temp layer goes unknown, instead
  // of holding the old state for the whole slope window after the source dies.
  const tempMaxAgeMs = (opts.tempMaxAgeSec != null ? opts.tempMaxAgeSec : 600) * 1000
  // Speed gate for the charge-current rule; <= 0 disables it. In m/s.
  const minMovingSpeed = opts.minMovingSpeedMs != null ? opts.minMovingSpeedMs : 0
  // Movement must be sustained this long before it counts, so a single SOG spike
  // (GPS glitch at the dock) can't pair with shore-power current into a false ON.
  const movingHoldMs = (opts.movingHoldSec != null ? opts.movingHoldSec : 15) * 1000
  // Wind-vs-speed rule: in light-to-moderate wind a displacement keelboat never
  // sails faster than the true wind, so speed through the water clearly above the
  // true wind speed can only be the engine. Relative (STW − TWS) rather than an
  // absolute TWS threshold, so it doesn't have to be chased as the light wind
  // wanders. Independent of the (flaky) battery/alternator feed. All in m/s;
  // windStwOverTws <= 0 disables the rule.
  const windTwsCap = opts.windTwsCapMs != null ? opts.windTwsCapMs : 0 // only apply below this TWS
  const windMinStw = opts.windMinStwMs != null ? opts.windMinStwMs : 0 // and STW at least this
  const windStwOverTws = opts.windStwOverTwsMs != null ? opts.windStwOverTwsMs : 0 // STW − TWS margin

  let current = null // { t, v }
  let soc = null // { t, v }
  const speedBuf = [] // [ [t, v], ... ] SOG in m/s, trimmed to the moving window
  const twsBuf = [] // [ [t, v], ... ] true wind speed m/s
  const stwBuf = [] // [ [t, v], ... ] speed through water m/s
  const temp = [] // [ [t, v], ... ], trimmed to roughly the slope window

  function setCurrent (t, v) {
    if (typeof v === 'number' && !Number.isNaN(v)) {
      current = { t, v }
    }
  }

  function setSoc (t, v) {
    if (typeof v === 'number' && !Number.isNaN(v)) {
      soc = { t, v }
    }
  }

  function pushBuf (buf, t, v) {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      return
    }
    buf.push([t, v])
    const cutoff = t - movingHoldMs * 2
    while (buf.length && buf[0][0] < cutoff) {
      buf.shift()
    }
  }

  function setSpeed (t, v) {
    pushBuf(speedBuf, t, v)
  }

  function setTws (t, v) {
    pushBuf(twsBuf, t, v)
  }

  function setStw (t, v) {
    pushBuf(stwBuf, t, v)
  }

  // A condition held over the whole last movingHoldMs. Requires the buffer to
  // span the window (so a lone recent spike doesn't pass) and the latest sample
  // to be fresh. Rejects single-sample glitches in either direction.
  function sustained (buf, now, pred) {
    if (!buf.length) {
      return false
    }
    const latest = buf[buf.length - 1]
    if (now - latest[0] > maxAgeMs) {
      return false
    }
    const from = now - movingHoldMs
    if (buf[0][0] > from) {
      return false
    }
    const win = buf.filter((p) => p[0] >= from)
    return win.length >= 2 && win.every(pred)
  }

  function movingAt (now) {
    if (minMovingSpeed <= 0) {
      return true
    }
    return sustained(speedBuf, now, (p) => p[1] >= minMovingSpeed)
  }

  // Mean over the last movingHoldMs, or null if the buffer doesn't span a fresh
  // window. Used where a single noisy sample shouldn't decide (wind speed jitters
  // across a threshold), unlike sustained()'s all-or-nothing spike rejection.
  function windowMean (buf, now) {
    if (!buf.length) {
      return null
    }
    const latest = buf[buf.length - 1]
    if (now - latest[0] > maxAgeMs) {
      return null
    }
    const from = now - movingHoldMs
    if (buf[0][0] > from) {
      return null
    }
    const win = buf.filter((p) => p[0] >= from)
    if (win.length < 2) {
      return null
    }
    return win.reduce((sum, p) => sum + p[1], 0) / win.length
  }

  // Making meaningfully more speed through the water than the true wind, in
  // light-to-moderate air: only the engine can do that. Uses window means so
  // instrument jitter doesn't flap the result.
  function windMotoringAt (now) {
    // windStwOverTws <= 0 is the single disable switch (see the schema). A zero
    // cap or STW floor just makes their own clause unsatisfiable/trivial, it
    // doesn't silently kill the whole rule.
    if (windStwOverTws <= 0) {
      return false
    }
    const tws = windowMean(twsBuf, now)
    const stw = windowMean(stwBuf, now)
    if (tws == null || stw == null) {
      return false
    }
    return tws < windTwsCap && stw > windMinStw && stw - tws >= windStwOverTws
  }

  function pushTemp (t, v) {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      return
    }
    temp.push([t, v])
    const cutoff = t - windowMs * 2
    while (temp.length && temp[0][0] < cutoff) {
      temp.shift()
    }
  }

  function fresh (s, now) {
    return s && now - s.t <= maxAgeMs ? s.v : null
  }

  // true = rising/hot (on), false = cooling/cold (off), null = not enough
  // recent temperature to judge.
  function tempSlopeState (now) {
    if (!temp.length) {
      return null
    }
    // Don't let a dead source keep answering: if the newest reading is stale the
    // temperature says nothing about "now".
    if (now - temp[temp.length - 1][0] > tempMaxAgeMs) {
      return null
    }
    const from = now - windowMs
    const win = temp.filter((p) => p[0] >= from)
    if (win.length < 2) {
      return null
    }
    // Least-squares slope over the whole window (°C/min), so a single noisy end
    // sample can't swing the rise/cool call the way a two-point difference would.
    const n = win.length
    let st = 0
    let sv = 0
    let stv = 0
    let stt = 0
    for (const [t, v] of win) {
      const tm = t / 60000 // minutes, keeps the slope in °C/min directly
      st += tm
      sv += v
      stv += tm * v
      stt += tm * tm
    }
    const denom = n * stt - st * st
    if (denom === 0) {
      return null
    }
    const slope = (n * stv - st * sv) / denom
    if (slope > riseSlope) {
      return true
    }
    if (slope < -coolSlope) {
      return false
    }
    // Flat: hot means running. Use the window mean, robust to a single outlier.
    return sv / n > hotC
  }

  // Returns true (on), false (off) or null (unknown) at time `now`.
  function evaluate (now) {
    const c = fresh(current, now)
    const s = fresh(soc, now)
    // Wind-vs-speed first: it's the most certain ON signal and needs none of the
    // battery/alternator feed, so it still works when that source drops out.
    if (windMotoringAt(now)) {
      return true
    }
    // The charge-current ON rule only holds when moving: at the dock, high
    // current is shore power, not the alternator. When stationary we defer to
    // the temperature slope, which tells an engine (hot) from a charger (cold).
    if (c != null && c > onCurrent && movingAt(now)) {
      return true
    }
    if (c != null && c <= offCurrent && s != null && s < fullSoc) {
      return false
    }
    return tempSlopeState(now)
  }

  return { setCurrent, setSoc, setSpeed, setTws, setStw, pushTemp, evaluate }
}

// Turns a stream of raw decisions (true/false/null from evaluate) into debounced
// state transitions. A changed state must persist for holdMs before it is
// accepted; a contrary decision shorter than flipGraceMs is tolerated without
// restarting the timer; null (unknown) holds the last state. step() returns the
// new state string on a transition, else null. Shared by the live loop and the
// backfill replay so both debounce identically.
function createDebouncer (opts) {
  opts = opts || {}
  const holdMs = opts.holdMs != null ? opts.holdMs : 30000
  const flipGraceMs = opts.flipGraceMs != null ? opts.flipGraceMs : 10000
  let emitted = opts.initial != null ? opts.initial : null
  let pending = null // { state, since, contrarySince }

  function step (now, decision) {
    if (decision == null) {
      return null
    }
    const state = decision ? 'started' : 'stopped'
    if (state === emitted) {
      pending = null
      return null
    }
    if (pending && pending.state === state) {
      pending.contrarySince = null
      if (now - pending.since >= holdMs) {
        emitted = state
        pending = null
        return state
      }
      return null
    }
    if (pending) {
      if (pending.contrarySince == null) {
        pending.contrarySince = now
      }
      if (now - pending.contrarySince >= flipGraceMs) {
        pending = { state, since: now, contrarySince: null }
      }
      return null
    }
    pending = { state, since: now, contrarySince: null }
    return null
  }

  return {
    step,
    reset () {
      emitted = null
      pending = null
    },
    get emitted () {
      return emitted
    }
  }
}

module.exports = { createEngineDetector, createDebouncer }
