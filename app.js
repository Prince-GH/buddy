const robot = document.getElementById('robot'),
  eyes = document.getElementById('eyes'),
  screenEl = document.getElementById('screen')
const errorEl = document.getElementById('error')
let micStream,
  audioContext,
  analyser,
  sourceNode,
  raf,
  listening = false,
  starting = false,
  lastExpression = 'curious',
  expressionTimer = null,
  gazeTimer = null,
  petTimer = null,
  lastKeywordAt = 0,
  analysisTimer = null,
  sampleTimer = null
let latestFeatures = null,
  featureHistory = [],
  featureSamples = [],
  lastVoiceState = 'quiet',
  analysisBusy = false,
  noiseFloor = 0.0035,
  voiceBaseline = 0.025,
  voiceActive = false,
  lastPointerAt = 0
const expressions = [
  'rectangle',
  'brows',
  'small',
  'angry',
  'curious',
  'downc',
  'red',
  'sparkle',
  'sleepy',
  'happy'
]
function setExpression (name) {
  if (!expressions.includes(name) || name === lastExpression) return
  lastExpression = name
  for (const expr of expressions) eyes.classList.remove(`expression-${expr}`)
  eyes.classList.add(`expression-${name}`)
}
function randomBetween (min, max) {
  return min + Math.random() * (max - min)
}
function idleGaze () {
  if (gazeTimer) clearTimeout(gazeTimer)
  const move = () => {
    if (
      Date.now() - lastKeywordAt > 2300 &&
      Date.now() - lastPointerAt > 1800 &&
      !robot.classList.contains('petted')
    ) {
      eyes.style.setProperty('--gaze-x', `${randomBetween(-6, 6)}px`)
      eyes.style.setProperty('--gaze-y', `${randomBetween(-4, 4)}px`)
      robot.style.setProperty('--tilt', `${randomBetween(-1.1, 1.1)}deg`)
    }
    gazeTimer = setTimeout(move, randomBetween(1500, 2800))
  }
  move()
}
function idleExpressionLoop () {
  if (expressionTimer) clearTimeout(expressionTimer)
  const cycle = () => {
    if (
      !listening &&
      Date.now() - lastKeywordAt > 2500 &&
      !robot.classList.contains('petted')
    ) {
      setExpression(
        Math.random() < 0.78
          ? 'curious'
          : Math.random() < 0.5
          ? 'brows'
          : 'sleepy'
      )
    }
    expressionTimer = setTimeout(cycle, randomBetween(3200, 4900))
  }
  cycle()
}
function setLevel (level) {
  robot.classList.remove(
    'level-silent',
    'level-soft',
    'level-normal',
    'level-loud',
    'level-veryloud'
  )
  robot.classList.add(`level-${level}`)
}
function rmsOf (data) {
  let sum = 0,
    peak = 0
  for (const x of data) {
    const v = (x - 128) / 128
    sum += v * v
    peak = Math.max(peak, Math.abs(v))
  }
  return { rms: Math.sqrt(sum / data.length), peak }
}
function estimatePitch (samples, sampleRate) {
  // Lightweight autocorrelation pitch estimate; returns Hz or null for unvoiced/noisy windows.
  const minLag = Math.floor(sampleRate / 350),
    maxLag = Math.min(Math.floor(sampleRate / 70), samples.length - 2)
  let bestLag = -1,
    best = -1
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let corr = 0,
      energyA = 0,
      energyB = 0
    for (let i = 0; i < samples.length - lag; i += 2) {
      const a = samples[i],
        b = samples[i + lag]
      corr += a * b
      energyA += a * a
      energyB += b * b
    }
    const norm = corr / Math.sqrt(energyA * energyB || 1)
    if (norm > best) {
      best = norm
      bestLag = lag
    }
  }
  if (bestLag < 0 || best < 0.35) return null
  const hz = sampleRate / bestLag
  return hz >= 65 && hz <= 400 ? hz : null
}
function calculateFeatures () {
  if (!analyser || !audioContext) return null
  const timeData = new Uint8Array(analyser.fftSize)
  const floatData = new Float32Array(analyser.fftSize)
  const freqData = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteTimeDomainData(timeData)
  analyser.getFloatTimeDomainData(floatData)
  analyser.getByteFrequencyData(freqData)
  const { rms, peak } = rmsOf(timeData)
  let zc = 0
  for (let i = 1; i < floatData.length; i++) {
    if (
      (floatData[i - 1] >= 0 && floatData[i] < 0) ||
      (floatData[i - 1] < 0 && floatData[i] >= 0)
    )
      zc++
  }
  let weighted = 0,
    total = 0,
    centroid = 0,
    dominantIndex = 0,
    dominantValue = 0
  for (let i = 0; i < freqData.length; i++) {
    const magnitude = freqData[i] / 255
    const hz = (i * audioContext.sampleRate) / analyser.fftSize
    weighted += hz * magnitude
    total += magnitude
    if (freqData[i] > dominantValue) {
      dominantValue = freqData[i]
      dominantIndex = i
    }
  }
  centroid = total ? weighted / total : 0
  const pitch = estimatePitch(floatData, audioContext.sampleRate)
  return {
    timestamp: new Date().toISOString(),
    rms: Number(rms.toFixed(4)),
    peak: Number(peak.toFixed(4)),
    loudnessDbFS: Number((20 * Math.log10(Math.max(rms, 0.00001))).toFixed(1)),
    pitchHz: pitch ? Number(pitch.toFixed(1)) : null,
    zeroCrossingRate: Number((zc / floatData.length).toFixed(3)),
    spectralCentroidHz: Number(centroid.toFixed(1)),
    dominantFrequencyHz: Number(
      ((dominantIndex * audioContext.sampleRate) / analyser.fftSize).toFixed(1)
    ),
    spectralEnergy: Number((total / freqData.length).toFixed(4))
  }
}
function classifyVoice (features) {
  const f = features
  const rms = Number(f.rms) || 0
  const peak = Number(f.peak) || 0
  const centroid = Number(f.centroidHz ?? f.spectralCentroidHz) || 0
  const pitch = Number.isFinite(f.pitchHz) ? f.pitchHz : null
  const noise = Number(f.noiseFloor) || 0
  const baseline = Number(f.baseline) || noise || 0.006
  const ratio = Number(f.ratio) || rms / Math.max(noise, 0.002)

  // Avoid classifying background hiss as speech, but accept quiet close-mic speech.
  const speechLike = rms >= Math.max(0.0028, noise * 1.05) || peak >= 0.022
  if (!speechLike) {
    return {
      state: 'quiet',
      expression: 'curious',
      confidence: 0.7,
      reason: 'signal near noise floor'
    }
  }

  // Strong emphasis: thresholds are intentionally lower and combine multiple cues.
  // These detect an expressive vocal style, not a person's actual emotional state.
  if (
    (rms >= 0.01 &&
      peak >= 0.045 &&
      (centroid >= 1000 || (pitch !== null && pitch >= 145))) ||
    (rms >= 0.016 && ratio >= 1.25 && centroid >= 950) ||
    (rms >= 0.022 && pitch !== null && pitch >= 195)
  ) {
    return {
      state: 'intense',
      expression: 'angry',
      confidence: 0.62,
      reason: 'elevated energy with emphasis/brightness/pitch cue'
    }
  }

  if (rms >= 0.04 || (rms >= 0.022 && peak >= 0.1 && ratio >= 1.5)) {
    return {
      state: 'high-energy',
      expression: 'red',
      confidence: 0.58,
      reason: 'high relative voice energy'
    }
  }

  if (rms >= 0.009 && pitch !== null && pitch >= 165 && centroid >= 950) {
    return {
      state: 'animated',
      expression: 'sparkle',
      confidence: 0.54,
      reason: 'higher pitch and brighter spectrum'
    }
  }

  if (rms < 0.008 || (ratio < 1.2 && rms < 0.012)) {
    return {
      state: 'soft',
      expression: 'small',
      confidence: 0.5,
      reason: 'low energy relative to noise floor'
    }
  }

  if (pitch !== null && pitch < 115 && rms >= 0.018) {
    return {
      state: 'low-pitched',
      expression: 'downc',
      confidence: 0.4,
      reason: 'lower estimated pitch; ambiguous cue'
    }
  }

  return {
    state: 'conversational',
    expression: 'curious',
    confidence: 0.5,
    reason: 'no strong acoustic cue'
  }
}

function collectFeatureSample () {
  if (!listening || !analyser) return
  const sample = calculateFeatures()
  if (sample) featureSamples.push(sample)
}
function averageOf (samples, key) {
  const values = samples.map(s => s[key]).filter(v => Number.isFinite(v))
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null
}
function medianOf (values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

let lastAcousticExpression = 'curious'
let acousticExpressionStreak = 0
let lastAcousticChangeAt = 0
function applyAcousticExpression (classification) {
  const target = classification.expression || 'curious'
  if (target === lastAcousticExpression) acousticExpressionStreak++
  else {
    lastAcousticExpression = target
    acousticExpressionStreak = 1
  }

  const strong = target === 'angry' || target === 'red'
  // One strong window can trigger; less dramatic expressions need two consecutive windows.
  if (strong || acousticExpressionStreak >= 2 || target === 'curious') {
    const now = Date.now()
    if (strong || now - lastAcousticChangeAt > 650 || target === 'curious') {
      setExpression(target)
      lastAcousticChangeAt = now
    }
  }
}

function analyzeTwoSecondWindow () {
  if (!listening || analysisBusy) return
  analysisBusy = true
  try {
    const samples = featureSamples.splice(0)
    if (!samples.length) return
    // Aggregate samples collected throughout the complete 2-second window.
    const meanRms = averageOf(samples, 'rms') || 0
    const pitch = medianOf(samples.map(s => s.pitchHz))
    const features = {
      timestamp: new Date().toISOString(),
      windowSeconds: 2,
      sampleCount: samples.length,
      rms: Number(meanRms.toFixed(4)),
      peak: Number(Math.max(...samples.map(s => s.peak)).toFixed(4)),
      loudnessDbFS: Number(
        (20 * Math.log10(Math.max(meanRms, 0.00001))).toFixed(1)
      ),
      pitchHz: pitch === null ? null : Number(pitch.toFixed(1)),
      zeroCrossingRate: Number(
        (averageOf(samples, 'zeroCrossingRate') || 0).toFixed(3)
      ),
      spectralCentroidHz: Number(
        (averageOf(samples, 'spectralCentroidHz') || 0).toFixed(1)
      ),
      dominantFrequencyHz: Number(
        (averageOf(samples, 'dominantFrequencyHz') || 0).toFixed(1)
      ),
      spectralEnergy: Number(
        (averageOf(samples, 'spectralEnergy') || 0).toFixed(4)
      )
    }
    // Estimate background floor from low-energy windows, adapting to room/mic noise.
    if (features.rms < Math.max(0.018, noiseFloor * 3.0)) {
      noiseFloor = noiseFloor * 0.88 + features.rms * 0.12
      noiseFloor = Math.max(0.0015, Math.min(noiseFloor, 0.018))
    }
    const classification = classifyVoice(features)
    latestFeatures = {
      ...features,
      ...classification,
      noiseFloor: Number(noiseFloor.toFixed(4)),
      voiceBaseline: Number(voiceBaseline.toFixed(4))
    }
    console.log('[Buddy] 2s analysis', {
      rms: latestFeatures.rms,
      peak: latestFeatures.peak,
      dbFS: latestFeatures.loudnessDbFS,
      pitchHz: latestFeatures.pitchHz,
      centroidHz: latestFeatures.spectralCentroidHz,
      zcr: latestFeatures.zeroCrossingRate,
      noiseFloor: latestFeatures.noiseFloor,
      baseline: latestFeatures.voiceBaseline,
      ratio: Number(
        (latestFeatures.rms / Math.max(noiseFloor, 0.0015)).toFixed(2)
      ),
      state: latestFeatures.state,
      expression: latestFeatures.expression,
      confidence: latestFeatures.confidence,
      reason: latestFeatures.reason,
      samples: latestFeatures.sampleCount
    })
    featureHistory.push(latestFeatures)
    if (featureHistory.length > 30) featureHistory.shift()
    const loud = features.rms
    if (loud < 0.012) setLevel('silent')
    else if (loud < 0.035) setLevel('soft')
    else if (loud < 0.085) setLevel('normal')
    else if (loud < 0.17) setLevel('loud')
    else setLevel('veryloud')
    if (
      Date.now() - lastKeywordAt > 2200 &&
      !robot.classList.contains('petted')
    ) {
      const previous =
        featureHistory.length > 1
          ? featureHistory[featureHistory.length - 2]
          : null
      // Let strong expressive cues show immediately; require two windows only for subtle changes.
      const strongCue = ['angry', 'red', 'sparkle', 'rectangle'].includes(
        classification.expression
      )
      if (
        strongCue ||
        classification.expression === 'curious' ||
        classification.expression === 'small' ||
        classification.expression === 'downc' ||
        (previous && previous.expression === classification.expression)
      ) {
        applyAcousticExpression(classification)
        lastVoiceState = classification.state
      }
    }
    window.BuddyVoiceAnalysis = {
      latest: latestFeatures,
      history: featureHistory.slice()
    }
  } finally {
    analysisBusy = false
  }
}
async function startListening () {
  // Prevent repeated startup attempts while permission is pending or audio is initializing.
  if (listening || starting) return
  starting = true
  const setError = message => {
    if (errorEl) errorEl.textContent = message
  }
  setError('')
  const statusEl = document.getElementById('status')
  if (statusEl) statusEl.textContent = 'Requesting microphone access…'
  if (!navigator.mediaDevices?.getUserMedia) {
    setError('Open Buddy over HTTPS or localhost to use the microphone.')
    starting = false
    return
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false
      }
    })
    // Microphone audio is analysed live only. Audio is analysed live only; no audio file is created or saved.
    audioContext = new (window.AudioContext || window.webkitAudioContext)()
    if (audioContext.state === 'suspended') await audioContext.resume()
    console.info(
      '[Buddy] AudioContext',
      audioContext.state,
      'sampleRate',
      audioContext.sampleRate
    )
    console.info(
      '[Buddy] Mic settings',
      micStream.getAudioTracks()[0]?.getSettings?.() || 'unavailable'
    )
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.05
    sourceNode = audioContext.createMediaStreamSource(micStream)
    // Stream B: analysis taps the same mic stream; it is not a second mic permission/listening.
    sourceNode.connect(analyser)
    listening = true
    starting = false
    if (statusEl)
      statusEl.textContent =
        ''
    if (expressionTimer) clearTimeout(expressionTimer)
    featureSamples = []
    collectFeatureSample()
    sampleTimer = setInterval(collectFeatureSample, 200)
    analysisTimer = setInterval(analyzeTwoSecondWindow, 2000)
    // Keep volume responsiveness between 2-second feature snapshots.
    const fastData = new Uint8Array(analyser.fftSize)
    let smoothRms = 0
    const fastTick = () => {
      if (!listening || !analyser) return
      analyser.getByteTimeDomainData(fastData)
      const { rms } = rmsOf(fastData)
      smoothRms = smoothRms * 0.8 + rms * 0.2
      if (smoothRms < 0.012) setLevel('silent')
      else if (smoothRms < 0.035) setLevel('soft')
      else if (smoothRms < 0.085) setLevel('normal')
      else if (smoothRms < 0.17) setLevel('loud')
      else setLevel('veryloud')
      raf = requestAnimationFrame(fastTick)
    }
    raf = requestAnimationFrame(fastTick)
  } catch (err) {
    listening = false
    starting = false
    if (statusEl) statusEl.textContent = 'Buddy needs microphone permission.'
    setError(
      err.name === 'NotAllowedError'
        ? "Microphone access was blocked. Allow it in your browser's site settings, then tap Buddy to retry."
        : "Couldn't start listening. Check microphone access, then tap Buddy to retry."
    )
  }
}
function stopListening () {
  if (!listening) return
  listening = false
  if (raf) cancelAnimationFrame(raf)
  raf = null
  if (analysisTimer) clearInterval(analysisTimer)
  analysisTimer = null
  if (sampleTimer) clearInterval(sampleTimer)
  sampleTimer = null
  if (audioContext) {
    audioContext.close().catch(() => {})
    audioContext = null
  }
  analyser = null
  sourceNode = null
  if (micStream) micStream.getTracks().forEach(t => t.stop())
  micStream = null
  const statusEl = document.getElementById('status')
  if (statusEl) statusEl.textContent = ''
  setLevel('silent')
  setExpression('curious')
  idleExpressionLoop()
}
function petBuddy (event) {
  if (
    event &&
    event.type === 'pointerdown' &&
    event.button !== 0 &&
    event.pointerType === 'mouse'
  )
    return
  if (!listening) {
    if (!starting) startListening()
    return
  }
  lastKeywordAt = Date.now()
  robot.classList.remove('petted')
  void robot.offsetWidth
  robot.classList.add('petted')
  setExpression('happy')
  robot.style.setProperty('--tilt', `${randomBetween(-2, 2)}deg`)
  if (event && Number.isFinite(event.clientX)) updateGazeFromPointer(event)
  else {
    eyes.style.setProperty('--gaze-x', '0px')
    eyes.style.setProperty('--gaze-y', '-3px')
  }
  if (petTimer) clearTimeout(petTimer)
  petTimer = setTimeout(() => {
    robot.classList.remove('petted')
    setExpression('curious')
    lastKeywordAt = 0
  }, 2200)
}
window.BuddyDebug = {
  status () {
    const result = {
      listening,
      audioContext: audioContext?.state || 'closed',
      sampleRate: audioContext?.sampleRate || null,
      analyserReady: Boolean(analyser),
      samplesInWindow: featureSamples.length,
      latest: latestFeatures,
      currentExpression: lastExpression,
      noiseFloor: Number(noiseFloor.toFixed(4)),
      voiceBaseline: Number(voiceBaseline.toFixed(4))
    }
    console.log('[Buddy] status', result)
    return result
  },
  dump () {
    const rows = featureHistory
      .slice(-12)
      .map(x => ({
        time: x.timestamp,
        rms: x.rms,
        peak: x.peak,
        dbFS: x.loudnessDbFS,
        pitchHz: x.pitchHz,
        centroidHz: x.spectralCentroidHz,
        zcr: x.zeroCrossingRate,
        noiseFloor: x.noiseFloor,
        baseline: x.voiceBaseline,
        state: x.state,
        expression: x.expression,
        reason: x.reason
      }))
    console.table(rows)
    return rows
  },
  test (expression = 'angry') {
    if (!expressions.includes(expression)) {
      console.warn('Valid expressions:', expressions)
      return false
    }
    setExpression(expression)
    console.info('[Buddy] visual-only expression test:', expression)
    return true
  },
  classify (sample = {}) {
    const f = {
      rms: sample.rms ?? 0.05,
      peak: sample.peak ?? 0.12,
      spectralCentroidHz: sample.spectralCentroidHz ?? 1700,
      zeroCrossingRate: sample.zeroCrossingRate ?? 0.12,
      pitchHz: sample.pitchHz ?? 190
    }
    const result = classifyVoice(f)
    console.table([{ ...f, ...result, noiseFloor, voiceBaseline }])
    return result
  },
  help () {
    console.log(`Buddy troubleshooting:
1) Open Buddy and allow microphone access; it starts automatically. Speak for 5-10 seconds, then run BuddyDebug.status()
2) Run BuddyDebug.dump() and copy the table.
3) Test eye CSS separately: BuddyDebug.test("angry")
4) Test classifier: BuddyDebug.classify({rms:0.05,peak:0.12,spectralCentroidHz:1700,pitchHz:190})
5) If RMS stays below 0.01 while speaking, check microphone permission/input device.
6) If expression says angry but eyes do not change, check CSS has .expression-angry.
Send me the [Buddy] 2s analysis logs and BuddyDebug.dump() output. Do not send private listenings.`)
  }
}
console.info(
  '[Buddy] Diagnostics ready. Run BuddyDebug.help() in DevTools Console.'
)

function updateGazeFromPointer (event) {
  const rect = robot.getBoundingClientRect()
  const cx = rect.left + rect.width / 2,
    cy = rect.top + rect.height * 0.36
  const nx = Math.max(
    -1,
    Math.min(1, (event.clientX - cx) / (window.innerWidth * 0.42))
  )
  const ny = Math.max(
    -1,
    Math.min(1, (event.clientY - cy) / (window.innerHeight * 0.42))
  )
  lastPointerAt = Date.now()
  // Eyes smoothly look toward the pointer; the head gently leans the same way.
  eyes.style.setProperty('--gaze-x', `${(nx * 17).toFixed(1)}px`)
  eyes.style.setProperty('--gaze-y', `${(ny * 12).toFixed(1)}px`)
  robot.style.setProperty('--tilt', `${(nx * -3.2).toFixed(2)}deg`)
  robot.style.setProperty('--lean-y', `${(ny * 3).toFixed(1)}px`)
}
screenEl.addEventListener('pointerdown', petBuddy)
screenEl.addEventListener(
  'pointermove',
  event => {
    if (
      event.pointerType === 'touch' ||
      event.pointerType === 'pen' ||
      event.buttons === 1 ||
      event.pointerType === 'mouse'
    )
      updateGazeFromPointer(event)
  },
  { passive: true }
)
screenEl.addEventListener(
  'pointerup',
  () => {
    setTimeout(() => {
      if (Date.now() - lastPointerAt > 350) {
        robot.style.setProperty('--tilt', '0deg')
        robot.style.setProperty('--lean-y', '0px')
      }
    }, 400)
  },
  { passive: true }
)
screenEl.addEventListener(
  'pointerleave',
  () => {
    if (Date.now() - lastPointerAt > 350) {
      eyes.style.setProperty('--gaze-x', '0px')
      eyes.style.setProperty('--gaze-y', '0px')
      robot.style.setProperty('--tilt', '0deg')
      robot.style.setProperty('--lean-y', '0px')
    }
  },
  { passive: true }
)
idleGaze()
idleExpressionLoop()
setLevel('silent')
if ('serviceWorker' in navigator && location.protocol.startsWith('http'))
  addEventListener('load', () =>
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  )
// Request microphone access automatically on launch. If blocked, tap Buddy after changing site permissions.
window.addEventListener('load', () => {
  startListening().catch(err => console.error('[Buddy] Startup failed', err))
})
