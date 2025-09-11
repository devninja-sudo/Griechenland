// Client-side player controller
const socket = io();
const player = document.getElementById('player');

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
player.src = 'videos/start.webm';
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
    // cleanup handlers
    player.oncanplay = null;
    player.onended = null;
    player.onerror = null;

    player.loop = !!loop;
    player.src = src;
    player.load();

    player.oncanplay = () => {
      // play may return a promise (autoplay); ignore errors
      player.play().catch(() => {});
      resolve();
    };

    player.onerror = (e) => {
      reject(new Error('video load error'));
    };
  });
}

async function playStep(step) {
  isTransitioning = true;
  try {
    await new Promise(r => fadeOut(r));
    await loadAndPlay(`videos/step${step}.webm`, true);
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
  const transitionSrc = `videos/transition_${fromStep}to${toStep}.webm`;
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
    // if transition missing or errors, jump straight to step
    console.warn('Transition failed, jumping to step', fromStep, '->', toStep, err);
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

// Follow host play/pause/mute
socket.on('play', () => {
  player.play().catch(()=>{});
});
socket.on('pause', () => {
  player.pause();
});
socket.on('mute', (muted) => {
  player.muted = !!muted;
});
