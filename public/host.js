const socket = io();
let currentStep = 1;
let showStarted = false;
const hostPlayer = document.getElementById('hostPlayer');
const nowPlaying = document.getElementById('nowPlaying');
const playPauseBtn = document.getElementById('playPauseBtn');
const muteBtn = document.getElementById('muteBtn');

// --- Manifest support (same structure as client) ---
let manifest = null;
let stepMap = new Map();
let transitionsMap = {};
let playbackToken = 0; // incremented for each load to avoid race conditions
let isTransitionPlaying = false;
async function loadManifest() {
  try {
    const res = await fetch('/videos/manifest.json');
    if (!res.ok) throw new Error('no manifest');
    manifest = await res.json();
    (manifest.steps || []).forEach(s => stepMap.set(Number(s.id), s));
    transitionsMap = manifest.transitions || {};
    console.info('Host loaded manifest', manifest);
  } catch (e) {
    console.info('Host: no manifest found, falling back to filename conventions');
  }
}
loadManifest().catch(()=>{});

function getStepFile(step) {
  const s = stepMap.get(Number(step));
  if (s && s.file) return s.file;
  return `step${step}.webm`;
}
function getTransitionFile(from, to) {
  const key = `${from}-${to}`;
  // Only return an explicitly configured transition. Per requirement, do NOT fall back to
  // a default transition or generated filename. If no explicit mapping, return null.
  if (transitionsMap && Object.prototype.hasOwnProperty.call(transitionsMap, key)) {
    return transitionsMap[key];
  }
  return null;
}
function getStartFile() {
  if (manifest && manifest.start) return manifest.start;
  return 'start.webm';
}

// Host: helper to get label
function getStepLabel(step) {
  const s = stepMap.get(Number(step));
  return (s && s.label) ? s.label : `step ${step}`;
}

// Missing files checker (simple HEAD requests)
async function checkFiles() {
  const report = [];
  const toCheck = [];
  toCheck.push(getStartFile());
  ((manifest && manifest.steps) || []).forEach(s => toCheck.push(s.file || getStepFile(s.id)));
  Object.values((manifest && manifest.transitions) || {}).forEach(t => toCheck.push(t));

  for (const file of toCheck) {
    try {
      const res = await fetch(`/videos/${file}`, { method: 'HEAD' });
      if (!res.ok) report.push({ file, ok: false, status: res.status });
    } catch (e) {
      report.push({ file, ok: false, error: e.message });
    }
  }
  return report;
}

// UI for report
const reportPanel = document.createElement('pre');
reportPanel.style.position = 'fixed';
reportPanel.style.left = '8px';
reportPanel.style.top = '8px';
reportPanel.style.padding = '8px';
reportPanel.style.background = 'rgba(0,0,0,0.8)';
reportPanel.style.color = '#fff';
reportPanel.style.maxHeight = '60vh';
reportPanel.style.overflow = 'auto';
reportPanel.style.display = 'none';
document.body.appendChild(reportPanel);

document.getElementById('checkFilesBtn').addEventListener('click', async () => {
  reportPanel.style.display = 'block';
  reportPanel.textContent = 'Checking...';
  const r = await checkFiles();
  if (!r.length) reportPanel.textContent = 'All files OK (or no manifest present)';
  else reportPanel.textContent = JSON.stringify(r, null, 2);
});

// helper to safely load and play a video on host player with error handling
function hostLoadAndPlay(src, loop = false) {
  return new Promise((resolve, reject) => {
    // protect against overlapping loads: only the most recent token's handlers run
    const token = ++playbackToken;
    hostPlayer.loop = !!loop;
    hostPlayer.src = src;
    try {
      hostPlayer.load();
    } catch (e) {
      reject(e);
      return;
    }

    const onCan = () => {
      if (token !== playbackToken) return; // stale event
      hostPlayer.play().catch(()=>{});
      resolve();
    };
    const onErr = () => {
      if (token !== playbackToken) return; // stale
      reject(new Error('host video load error'));
    };

    // assign handlers (clear previous to avoid leaks)
    hostPlayer.oncanplay = onCan;
    hostPlayer.onerror = onErr;
    // we intentionally don't set onended here; callers set onended when needed
  });
}

async function hostPlayStep(step) {
  try {
    const file = getStepFile(step);
    if (!file) throw new Error('No step file');
    await hostLoadAndPlay(`videos/${file}`, true);
    nowPlaying.textContent = `Now: ${getStepLabel(step)}`;
  } catch (err) {
    console.error('Host failed to play step', step, err);
    // fallback to start video to keep UI responsive
    try { await hostLoadAndPlay(`videos/${getStartFile()}`, true); }
    catch(e) { console.error('Host fallback failed', e); }
    nowPlaying.textContent = `Now: idle`;
  }
}

async function hostPlayTransitionAndStep(fromStep, toStep) {
  const transitionFile = getTransitionFile(fromStep, toStep);
  // Only play if an explicit transition mapping exists
  if (!transitionFile) {
    console.info('No explicit transition configured, skipping transition', `${fromStep}->${toStep}`);
    await hostPlayStep(toStep);
    return;
  }

  if (isTransitionPlaying) {
    console.warn('Transition already playing, skipping new transition', `${fromStep}->${toStep}`);
    await hostPlayStep(toStep);
    return;
  }

  isTransitionPlaying = true;
  try {
    const transitionSrc = `videos/${transitionFile}`;
    await hostLoadAndPlay(transitionSrc, false);
    // wait until transition ends
    await new Promise((resolve) => { hostPlayer.onended = () => resolve(); });
    await hostPlayStep(toStep);
  } catch (err) {
    console.warn('Host transition missing or failed, jumping to step', fromStep, '->', toStep, err);
    await hostPlayStep(toStep);
  } finally {
    isTransitionPlaying = false;
  }
}

// initialize host player with start video (muted to allow autoplay on mobile)
hostPlayer.loop = true;
hostPlayer.muted = true;
hostLoadAndPlay(`videos/${getStartFile()}`, true).catch(()=>{});

playPauseBtn.addEventListener('click', () => {
  // guard against missing player
  try {
    if (hostPlayer.paused) {
      hostPlayer.play().catch(()=>{});
      playPauseBtn.textContent = 'Pause';
      socket.emit('play');
    } else {
      hostPlayer.pause();
      playPauseBtn.textContent = 'Play';
      socket.emit('pause');
    }
  } catch (e) {
    console.error('Play/Pause failed', e);
  }
});

muteBtn.addEventListener('click', () => {
  try {
    hostPlayer.muted = !hostPlayer.muted;
    muteBtn.textContent = hostPlayer.muted ? 'Unmute' : 'Mute';
    socket.emit('mute', hostPlayer.muted);
  } catch (e) {
    console.error('Mute toggle failed', e);
  }
});

function setStep(step) {
  if (step < 1) return;
  currentStep = step;
  if (showStarted) {
    socket.emit("changeStep", step);
  }
}

function jumpToStep() {
  const input = document.getElementById("stepInput");
  const step = parseInt(input.value, 10);
  if (!isNaN(step) && step > 0) {
  setStep(step);
  }
}

function startShow() {
  showStarted = true;
  socket.emit("startShow", currentStep);
  // begin host playback
  hostPlayStep(currentStep).catch(()=>{});
}

// schedule a step to start after leadMs milliseconds (from server time)
async function scheduleStepIn(step, leadMs = 4000) {
  // request server time via callback-style timeSync
  socket.timeout(2000).emit('timeSync', { t0: Date.now() }, (err, payload) => {
    if (err || !payload || typeof payload.tServer !== 'number') {
      console.warn('timeSync failed, sending immediate schedule');
      // fallback: send schedule with server approx = Date.now() + leadMs
      socket.emit('scheduleStep', { step, at: Date.now() + leadMs });
      return;
    }
    const serverNow = payload.tServer;
    const at = serverNow + leadMs;
    socket.emit('scheduleStep', { step, at });
    const human = new Date(at).toLocaleTimeString();
    nowPlaying.textContent = `Scheduled step ${step} at ${human}`;
  });
}

function scheduleStepAt(step, serverTimestamp) {
  socket.emit('scheduleStep', { step, at: serverTimestamp });
  const human = new Date(serverTimestamp).toLocaleTimeString();
  nowPlaying.textContent = `Scheduled step ${step} at ${human}`;
}

// expose scheduling helpers for quick use
window.scheduleStepIn = scheduleStepIn;
window.scheduleStepAt = scheduleStepAt;

function requestGoLive() {
  socket.emit('requestGoLive');
}
window.requestGoLive = requestGoLive;

function stoptimestand(timestand) {
  socket.emit("pauseattimestand", timestand)
}

// React to local changes so host player mirrors controls immediately
window.setStep = (step) => {
  if (step < 1) return;
  const prev = currentStep;
  currentStep = step;
  if (showStarted) {
    socket.emit('changeStep', step);
    // play transition locally only if explicitly configured
    const transitionFile = getTransitionFile(prev, step);
    if (transitionFile) {
      hostPlayTransitionAndStep(prev, step).catch(()=>{});
    } else {
      // no transition configured: directly jump to step
      hostPlayStep(step).catch(()=>{});
    }
  } else {
    // if not started, just update the miniplayer preview
    hostPlayStep(step).catch(()=>{});
  }
};

// expose jumpToStep and startShow
window.jumpToStep = jumpToStep;
window.startShow = startShow;

// Expose startShow for button
window.startShow = startShow;
