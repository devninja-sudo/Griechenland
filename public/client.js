// Client-side player controller
const socket = io();
const player = document.getElementById('player');

// --- Clock sync state ---
let clockOffset = 0; // serverTime - clientTime (ms)
let lastRtt = 0;
async function doClockSync(samples = 8) {
  const results = [];
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    try {
      const res = await new Promise((resolve, reject) => {
        // use callback-style to get server timestamp immediately
        socket.timeout(2000).emit('timeSync', { t0 }, (err, payload) => {
          if (err) return reject(err);
          resolve(payload);
        });
      });
      const t1 = Date.now();
      const rtt = t1 - t0;
      const tServer = res.tServer || res.tServer;
      results.push({ rtt, t0, t1, tServer });
    } catch (e) {
      // ignore failed sample
    }
    await new Promise(r => setTimeout(r, 50));
  }
  if (!results.length) return;
  // pick sample with smallest RTT
  results.sort((a,b)=>a.rtt-b.rtt);
  const best = results[0];
  lastRtt = best.rtt;
  // offset = tServer - (t0 + rtt/2)
  clockOffset = best.tServer - (best.t0 + best.rtt/2);
  console.info('Clock sync complete', { clockOffset, lastRtt });
  // show debug overlay if present
  const dbg = document.getElementById('syncDebug');
  if (dbg) dbg.textContent = `offset=${clockOffset}ms rtt=${lastRtt}ms`;
}

// run initial sync
doClockSync().catch(()=>{});

function serverTimeToLocal(serverTs) {
  return serverTs - clockOffset;
}

// Debug overlay
const debugEl = document.createElement('div');
debugEl.id = 'syncDebug';
debugEl.style.position = 'fixed';
debugEl.style.right = '8px';
debugEl.style.bottom = '8px';
debugEl.style.padding = '6px 8px';
debugEl.style.background = 'rgba(0,0,0,0.6)';
debugEl.style.color = '#fff';
debugEl.style.fontSize = '12px';
debugEl.style.zIndex = 9999;
document.body.appendChild(debugEl);

// --- Manifest support ---
let manifest = null;
let stepMap = new Map();
let transitionsMap = {};
let playbackToken = 0; // protect against stale oncanplay/onerror events
async function loadManifest() {
  try {
    const res = await fetch('/videos/manifest.json');
    if (!res.ok) throw new Error('no manifest');
    manifest = await res.json();
    (manifest.steps || []).forEach(s => stepMap.set(Number(s.id), s));
    transitionsMap = manifest.transitions || {};
    console.info('Loaded manifest', manifest);
  } catch (e) {
    console.info('No manifest found, falling back to filename conventions');
  }
}
loadManifest().catch(()=>{});

function getStepFile(step) {
  const s = stepMap.get(Number(step));
  if (s && s.file) return s.file;
  return `step${step}.webm`;
}
function getStepLabel(step) {
  const s = stepMap.get(Number(step));
  if (s && s.label) return s.label;
  return `step ${step}`;
}
function getTransitionFile(from, to) {
  const key = `${from}-${to}`;
  // Only return an explicitly configured transition. Do NOT fall back to a default or generated filename.
  if (transitionsMap && Object.prototype.hasOwnProperty.call(transitionsMap, key)) {
    return transitionsMap[key];
  }
  return null;
}
function getStartFile() {
  if (manifest && manifest.start) return manifest.start;
  return 'start.webm';
}

// State
let currentStep = 1;
let isTransitioning = false;
let showStarted = false;
let queuedStep = null;

// Small helper: inject CSS for fade
const styleTag = document.createElement('style');
styleTag.textContent = `#player{transition:opacity 0.45s} .hidden{opacity:0}`;
document.head.appendChild(styleTag);

// Ensure autoplay works: muted + playsInline expected on the <video> element
player.muted = true;
player.playsInline = true;

// Start with the waiting/start video
player.src = `videos/${getStartFile()}`;
player.loop = true;
player.style.opacity = 1;
player.play().catch(() => { /* ignore autoplay rejection */ });

function fadeOut(cb) {
  player.classList.add('hidden');
  setTimeout(cb, 450);
}
function fadeIn() {
  player.classList.remove('hidden');
}

function loadAndPlay(src, loop = false) {
  return new Promise((resolve, reject) => {
    // protect against overlapping loads: only the most recent token's handlers run
    const token = ++playbackToken;
    player.loop = !!loop;
    player.src = src;
    try { player.load(); } catch(e) { /* ignore load exceptions in some browsers */ }

    const onCan = () => {
      if (token !== playbackToken) return; // stale
      player.play().catch(() => {});
      resolve();
    };
    const onErr = (e) => {
      if (token !== playbackToken) return; // stale
      reject(new Error('video load error'));
    };

    // assign handlers
    player.oncanplay = onCan;
    player.onerror = onErr;
  });
}

async function playStep(step) {
  isTransitioning = true;
  try {
    await new Promise(r => fadeOut(r));
  await loadAndPlay(`videos/${getStepFile(step)}`, true);
    fadeIn();
  } catch (err) {
    // if step video missing, revert to start video
    console.error('Failed to play step', step, err);
    await loadAndPlay('videos/start.webm', true).catch(()=>{});
    fadeIn();
  } finally {
    isTransitioning = false;
    // handle queued step
    if (queuedStep !== null && queuedStep !== currentStep) {
      const next = queuedStep;
      queuedStep = null;
      // small delay to ensure state settles
      setTimeout(() => socket.emit('changeStep', next), 50);
    }
  }
}

async function playTransitionAndStep(fromStep, toStep) {
  isTransitioning = true;
  const transitionFile = getTransitionFile(fromStep, toStep);
  if (!transitionFile) {
    // No explicit transition configured; skip transition and jump to step
    await playStep(toStep);
    return;
  }

  const transitionSrc = `videos/${transitionFile}`;
  try {
    await new Promise(r => fadeOut(r));
    // try transition first
    await loadAndPlay(transitionSrc, false);
    fadeIn();
    // wait for transition to end
    await new Promise((resolve) => {
      player.onended = () => resolve();
    });
    // then play the target step
    await playStep(toStep);
  } catch (err) {
    console.warn('Transition failed or missing, jumping to step', fromStep, '->', toStep, err);
    await playStep(toStep);
  }
}

// Socket events
socket.on('startShow', (step) => {
  showStarted = true;
  currentStep = step || 1;
  // start the show by playing the selected step
  playStep(currentStep);
});

// Scheduled step: server provides absolute server timestamp 'at' in ms
socket.on('scheduledStep', async (data) => {
  // data: { step, at }
  if (!data || typeof data.at !== 'number') return;
  const atLocal = serverTimeToLocal(data.at);
  const delay = atLocal - Date.now();
  console.info('Received scheduledStep', data.step, 'serverAt', data.at, 'localDelay', delay);
  const dbg = document.getElementById('syncDebug');
  if (dbg) dbg.textContent = `offset=${clockOffset}ms rtt=${lastRtt}ms scheduled in ${Math.max(0, Math.round(delay))}ms`;

  // preload clip
  try {
    await loadAndPlay(`videos/${getStepFile(data.step)}`, true);
    // pause immediately after preloading so it's ready (some browsers keep playing)
    player.pause();
    player.currentTime = 0;
  } catch (e) {
    console.warn('Preload failed for step', data.step, e);
  }

  // schedule playback
  const start = () => {
    playStep(data.step);
  };

  if (delay <= 0) {
    // scheduled time already passed — start immediately
    start();
    return;
  }

  setTimeout(start, delay);
});

socket.on('setStep', (step) => {
  if (!showStarted) return;
  if (step === currentStep) return;
  // If already transitioning, queue the latest requested step
  if (isTransitioning) {
    queuedStep = step;
    return;
  }
  // kick off transition
  const from = currentStep;
  currentStep = step;
  playTransitionAndStep(from, step).catch(()=>{});
});

// Handle goLive: server provides { step, at } where 'at' is server timestamp when that step started
socket.on('goLive', async (data) => {
  try {
    // If no data or missing 'at', just resume playing the current source
    if (!data || typeof data.at !== 'number') {
      player.play().catch(()=>{});
      return;
    }

    // Mark that the show is live and set current step if provided.
    showStarted = true;
    if (data.step) currentStep = data.step;

    // Clear any queued or transitioning state so controls stay responsive
    queuedStep = null;
    isTransitioning = false;

    const atLocal = serverTimeToLocal(data.at);
    const elapsedMs = Date.now() - atLocal; // ms since the step started
    const elapsedSec = Math.max(0, elapsedMs / 1000);

    if (data.step) {
      // load the step video, then seek to elapsedSec and play
      try {
        await loadAndPlay(`videos/${getStepFile(data.step)}`, true);
        // ensure metadata loaded to allow seeking
        player.currentTime = Math.min(player.duration || Infinity, elapsedSec);
        player.play().catch(()=>{});
        console.info('Go Live: playing step', data.step, 'at', elapsedSec, 's');
      } catch (e) {
        console.warn('GoLive failed to load step video, falling back to start', e);
        // fallback: play start video from elapsed
        try {
          await loadAndPlay(`videos/${getStartFile()}`, true);
          player.currentTime = elapsedSec;
          player.play().catch(()=>{});
        } catch(_) {
          player.play().catch(()=>{});
        }
      }
    } else {
      // no specific step: play start video and seek
      try {
        await loadAndPlay(`videos/${getStartFile()}`, true);
        player.currentTime = elapsedSec;
        player.play().catch(()=>{});
      } catch (e) {
        player.play().catch(()=>{});
      }
    }
  } catch (e) {
    console.error('goLive handler error', e);
  }
});

// Follow host play/pause/mute
socket.on('play', () => {
  player.play().catch(()=>{});
});
socket.on('pause', () => {
  player.pause();
});

socket.on('pauseattimestand', (timestand) => {

  const checkInterval = setInterval(() => {
    if (Math.abs(player.currentTime-timestand) < 0.05) {
      player.pause();
      clearInterval(checkInterval);
    }
    console.log('Checking timestand', Math.abs(player.currentTime-timestand), 'abweichung zu ', timestand);
  }, 100);

  // Stoppe den Timer, falls das Video pausiert wird (z.B. manuell)  Warum Keine Ahnung
  const onPause = () => {
    clearInterval(checkInterval);
    player.removeEventListener('pause', onPause);
  };
  player.addEventListener('pause', onPause);
});

socket.on('mute', (muted) => {
  player.muted = !!muted;
});
