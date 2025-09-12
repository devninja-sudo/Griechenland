const socket = io();
let currentStep = 1;
let showStarted = false;
const hostPlayer = document.getElementById('hostPlayer');
const nowPlaying = document.getElementById('nowPlaying');
const playPauseBtn = document.getElementById('playPauseBtn');
const muteBtn = document.getElementById('muteBtn');

// helper to safely load and play a video on host player with error handling
function hostLoadAndPlay(src, loop = false) {
  return new Promise((resolve, reject) => {
    hostPlayer.oncanplay = null;
    hostPlayer.onended = null;
    hostPlayer.onerror = null;

    hostPlayer.loop = !!loop;
    hostPlayer.src = src;
    try {
      hostPlayer.load();
    } catch (e) {
      // some browsers may throw; treat as load error
      reject(e);
      return;
    }

    hostPlayer.oncanplay = () => {
      hostPlayer.play().catch(()=>{});
      resolve();
    };

    hostPlayer.onerror = () => reject(new Error('host video load error'));
  });
}

async function hostPlayStep(step) {
  try {
    await hostLoadAndPlay(`videos/step${step}.webm`, true);
    nowPlaying.textContent = `Now: step ${step}`;
  } catch (err) {
    console.error('Host failed to play step', step, err);
    // fallback to start video to keep UI responsive
    try { await hostLoadAndPlay('videos/start.webm', true); }
    catch(e) { console.error('Host fallback failed', e); }
    nowPlaying.textContent = `Now: idle`;
  }
}

async function hostPlayTransitionAndStep(fromStep, toStep) {
  const transitionSrc = `videos/transition_${fromStep}to${toStep}.webm`;
  try {
    await hostLoadAndPlay(transitionSrc, false);
    // wait until transition ends
    await new Promise((resolve) => hostPlayer.onended = resolve);
    await hostPlayStep(toStep);
  } catch (err) {
    console.warn('Host transition missing or failed, jumping to step', fromStep, '->', toStep, err);
    await hostPlayStep(toStep);
  }
}

// initialize host player with start video (muted to allow autoplay on mobile)
hostPlayer.loop = true;
hostPlayer.muted = true;
hostLoadAndPlay('videos/start.webm', true).catch(()=>{});

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
    // play transition locally
    hostPlayTransitionAndStep(prev, step).catch(()=>{});
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
