/*
 * Live engine-on detection, layered from most to least confident. This is the
 * incremental sibling of the sailing-logbook's engine.js: instead of scanning a
 * whole InfluxDB window it is fed one sample at a time and asked for the current
 * state.
 *
 *  0. Speed through the water clearly above the true wind speed (STW − TWS >=
 *     windStwOverTws), in light-to-moderate wind (TWS < windTwsCap), SUSTAINED
 *     over windSustain, and CLOSE-HAULED (mean |TWA| < windMaxTwa) -> engine ON.
 *     A keelboat cannot out-run the true wind going upwind, so STW > TWS there
 *     can only be the engine — but on a reach or run it can briefly out-run a
 *     light wind under sail, so the rule is gated to close-hauled angles and
 *     averaged over the window (a transient lull-carry is outweighed by the
 *     surrounding sail-slower-than-wind samples). Uses only the boat's own
 *     wind/speed instruments, so it keeps working when the battery/alternator
 *     feed drops out (checked first for that reason).
 *  1. House charge current > onCurrent (5 A) AND boat moving (or moving within
 *     movingGraceSec) -> engine ON. Under way the only thing that pushes that
 *     much into the house bank is the engine-driven alternator; solar minus the
 *     boat's 3-4 A idle draw never nets above ~1 A. The speed gate keeps shore
 *     power (charging hard at the dock, SOG ~0) from reading as an engine; a
 *     stationary engine (warming up, charging at anchor) is instead caught by the
 *     temperature slope in step 3. The grace period is what lets the rule survive
 *     a round-up, where the boat stops for a minute with the engine running.
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
  // How long after last making way the speed gate still accepts charge current
  // as the alternator's (see movingRecently).
  const movingGraceMs = (opts.movingGraceSec != null ? opts.movingGraceSec : 120) * 1000
  // Wind-vs-speed rule: in light-to-moderate wind a displacement keelboat never
  // sails faster than the true wind, so speed through the water clearly above the
  // true wind speed can only be the engine. Relative (STW − TWS) rather than an
  // absolute TWS threshold, so it doesn't have to be chased as the light wind
  // wanders. Independent of the (flaky) battery/alternator feed. All in m/s;
  // windStwOverTws <= 0 disables the rule.
  const windTwsCap = opts.windTwsCapMs != null ? opts.windTwsCapMs : 0 // only apply below this TWS
  const windMinStw = opts.windMinStwMs != null ? opts.windMinStwMs : 0 // and STW at least this
  const windStwOverTws = opts.windStwOverTwsMs != null ? opts.windStwOverTwsMs : 0 // STW − TWS margin
  // The wind rule must hold across this whole window, not just an instant: a boat
  // carrying way through a lull can briefly make more speed than the (now light)
  // true wind, but only a running engine keeps it up for minutes. In ms.
  const windSustainMs = (opts.windSustainSec != null ? opts.windSustainSec : 180) * 1000
  // The wind rule only holds close-hauled: a keelboat cannot sail faster than the
  // true wind going upwind, but ON A REACH OR RUN it can briefly out-run a light
  // true wind, so STW > TWS there is not proof of an engine. Gate the rule to a
  // mean |TWA| below this (radians); beyond it the boat is reaching and the rule
  // is disabled. Requires TWA — with none, the rule can't confirm close-hauled
  // and stays silent (conservative). <= 0 disables the gate (rule applies at any
  // angle, the old behaviour).
  const windMaxTwa = opts.windMaxTwaRad != null ? opts.windMaxTwaRad : (60 * Math.PI) / 180

  let current = null // { t, v }
  let soc = null // { t, v }
  const speedBuf = [] // [ [t, v], ... ] SOG in m/s, trimmed to the moving window
  let lastMovingAt = null // when the boat was last making way (see movingRecently)
  const twsBuf = [] // [ [t, v], ... ] true wind speed m/s
  const stwBuf = [] // [ [t, v], ... ] speed through water m/s
  const twaBuf = [] // [ [t, |v|], ... ] |true wind angle| rad, for the point-of-sail gate
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

  function pushBuf (buf, t, v, keepMs) {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      return
    }
    buf.push([t, v])
    const cutoff = t - keepMs
    while (buf.length && buf[0][0] < cutoff) {
      buf.shift()
    }
  }

  function setSpeed (t, v) {
    pushBuf(speedBuf, t, v, movingHoldMs * 2)
    // Remember when she was last making way here, not inside evaluate(): the
    // rules there short-circuit, so a spell carried by the wind rule would
    // otherwise leave this frozen at whenever the charge rule last ran — hours,
    // upwind in light air. Recording it with the sample also keeps evaluate() a
    // function of the buffers and `now`, so live and a replay agree however
    // often either calls it.
    if (sustained(speedBuf, t, (p) => p[1] >= minMovingSpeed)) {
      lastMovingAt = t
    }
  }

  // The wind buffers must reach back over the whole sustain window (plus slack),
  // since the wind rule takes a mean across it.
  function setTws (t, v) {
    pushBuf(twsBuf, t, v, windSustainMs + movingHoldMs)
  }

  function setStw (t, v) {
    pushBuf(stwBuf, t, v, windSustainMs + movingHoldMs)
  }

  // Point of sail for the wind gate: store |TWA| so the mean is the mean angle
  // off the wind, regardless of tack.
  function setTwa (t, v) {
    if (typeof v === 'number' && !Number.isNaN(v)) {
      pushBuf(twaBuf, t, Math.abs(v), windSustainMs + movingHoldMs)
    }
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

  // The speed gate exists to tell the alternator from shore power, and shore
  // power does not arrive the moment the boat slows. Rounding up to drop sails,
  // holding station, or lying alongside another boat takes her under the
  // threshold for a minute or two with the engine plainly running: on 2026-08-02
  // the speed fell to 0.2-0.6 kn for twenty seconds through a round-up, which
  // dropped the engine state exactly where a logbook needed it to reject a false
  // tack. So movement only has to be recent, not current — a window far shorter
  // than any stay alongside and far longer than any round-up. Making way again
  // refreshes it; the gate never latches on for good.
  function movingRecently (now) {
    if (minMovingSpeed <= 0) {
      return true
    }
    if (movingAt(now)) {
      return true
    }
    return lastMovingAt != null && now >= lastMovingAt && now - lastMovingAt <= movingGraceMs
  }

  // Mean over the last spanMs, or null unless the buffer spans a fresh window of
  // that length. Used where neither a single noisy sample nor a transient should
  // decide (wind speed jitter, a lull-carry): the value must hold across the
  // whole span. Unlike sustained()'s all-or-nothing, this averages.
  function spanMean (buf, now, spanMs) {
    if (!buf.length) {
      return null
    }
    const latest = buf[buf.length - 1]
    if (now - latest[0] > maxAgeMs) {
      return null
    }
    const from = now - spanMs
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
    // Point-of-sail gate: only trust STW > TWS close-hauled, where a keelboat
    // truly cannot out-run the wind. On a reach or run it can, so a mean |TWA|
    // above the cap disables the rule. No TWA -> can't confirm close-hauled ->
    // stay silent.
    if (windMaxTwa > 0) {
      const twa = spanMean(twaBuf, now, windSustainMs)
      if (twa == null || twa >= windMaxTwa) {
        return false
      }
    }
    // Means over the whole sustain window: a lull-carry (boat briefly faster than
    // the dropped wind) is outweighed by the surrounding sail-slower-than-wind
    // samples, so only a sustained excess — an engine — fires.
    const tws = spanMean(twsBuf, now, windSustainMs)
    const stw = spanMean(stwBuf, now, windSustainMs)
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
    if (c != null && c > onCurrent && movingRecently(now)) {
      return true
    }
    if (c != null && c <= offCurrent && s != null && s < fullSoc) {
      return false
    }
    return tempSlopeState(now)
  }

  return { setCurrent, setSoc, setSpeed, setTws, setStw, setTwa, pushTemp, evaluate }
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
