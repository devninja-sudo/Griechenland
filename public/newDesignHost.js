const socket = io();
let currentStep = 1;


let manifest = null;
let stepMap = new Map();
let transitionsMap = {};
let timestampsMap = {};
let playbackToken = 0; // incremented for each load to avoid race conditions
let isTransitionPlaying = false;
async function loadManifest() {
  try {
    const res = await fetch('/videos/manifest.json');
    if (!res.ok) throw new Error('no manifest');
    manifest = await res.json();
    (manifest.steps || []).forEach(s => stepMap.set(Number(s.id), s));
    transitionsMap = manifest.transitions || {};
    timestampsMap = manifest.Timestamps || {};
    console.info('Host loaded manifest', manifest);
  } catch (e) {
    console.info('Host: no manifest found, falling back to filename conventions');
  }
}
loadManifest().catch(()=>{});

getActStep();


let showStarted = false;
let paused = false;

const playButton = document.getElementById('playButton');
const SzeneName = document.getElementById('SzeneName');
const goLiveButton = document.getElementById('goLiveButton');
const TimeStampsControll = document.getElementById('ClipTimestampControll');
const JumpCheckbox = document.getElementById('JumpCheckbox');
const PauseAtTimestampCheckbox = document.getElementById('PauseAtTimestampCheckbox');

const ClientCounter = document.getElementById('ClientCounter');
ClientCounter.innerText = `Zuschauer: 0`;

const PauseAtTimestampControll = document.getElementById('PauseAtTimestampControll');
PauseAtTimestampControll.style.display = "none";

window.onload = async () => {
    await StepUpdateEvent(await getActStep());
    

    timestampsMap.forEach(element => {
       console.log(`Step ID: ${element.stepid}, Timestamp: ${element.Timestamp}, Name: ${element.name}`);
    });
};


async function StepUpdateEvent(step){
  await aktSzeneName();

  ClipTimestampControll.innerHTML = "";
  timestampsMap.forEach(element => {
    if(element.stepid == step){
        const button = document.createElement("button");
        button.innerText = element.name;
        button.onclick = () => {
            timestandFunction(element.Timestamp);
        };
        TimeStampsControll.appendChild(button);
    }});
};

function timestandFunction(timestand){
  if(JumpCheckbox.checked){
    jumpToTimestamp(timestand);
    return;
  }
  stoptimestand(timestand);
}

function jumpToTimestamp(timestand) {
  socket.emit("JumpToTimestamp", timestand, PauseAtTimestampCheckbox.checked); 
}
socket.on('play', () => {
    paused = false;
    playButton.textContent = '❚❚';
    playButton.onclick = pause;
});


socket.on('pause', () => {
    paused = true;
    playButton.textContent = '▶';
    playButton.onclick = play;
});

socket.on('pauseattimestand', () => {
    paused = false;
    playButton.textContent = '❚?❚';
    playButton.onclick = pause;
});

socket.on('JumpToTimestamp', async (timestamp, pause) => {
  if (pause) {
    setTimeout(() => {
    paused = true;
    playButton.textContent = '▶';
    playButton.onclick = play;
    }, 20);
  }
});

socket.on('ActStepReport', (step) => {
    currentStep = step;
});

socket.on('setStep', async (step) => {
    await StepUpdateEvent(step);
});

socket.on('startShow', async (step) => {
    await StepUpdateEvent(step);
});

async function aktSzeneName(){
    SzeneName.textContent = `Szenenname: ${await getStepLabel()}`;
}

function getActStep() {
  return new Promise((resolve) => {
    // Einmaligen Listener setzen
    socket.once('ActStepReport', (step) => {
      resolve(step);
      currentStep = step;
    });
    socket.emit('getActStep');
  });
}


 async function getStepLabel() {
  let step = await getActStep();
  const s = stepMap.get(Number(step));
  return (s && s.label) ? s.label : `step ${step}`;
}

function startShow() {
  showStarted = true;
  socket.emit("startShow", currentStep);
}

function pause(){
  socket.emit('pause');
}

function play(){
  socket.emit('play');
}

function changeStep(step){
    socket.emit('changeStep', step);
}


async function backScene(){
    currentStep = await getActStep(); 
    if(currentStep <= 1){
        alert("Du bist schon bei der ersten Szene!");
        return;
    }
    changeStep(currentStep - 1);    
}

function mute(){
    alert ("Funktion noch nicht implementiert!");
}

async function nextScene(){
    if(stepMap.get(Number(await getActStep()+1)) == undefined){
        alert("Du bist schon bei der letzten Szene!");
        return;
    }
    currentStep = await getActStep(); 
    changeStep(currentStep + 1);    

}

async function startShow(){
    socket.emit("startShow", 1);
}


function goLive(){
    socket.emit('requestGoLive');
}

function stoptimestand(timestand) {
  socket.emit("play")
  socket.emit("pauseattimestand", timestand)
}


function JumpToScene(){
  changeStep(prompt("Zu welcher Szene möchtest du springen?") || getActStep());
}


function toggleCheckboxJumpTimestamp(){
  if(JumpCheckbox.checked){
    PauseAtTimestampControll.style.display = "inline";
  }else{
    PauseAtTimestampControll.style.display = "none";
  }
}

function CountClientsRequest() {
  return new Promise((resolve) => {
    // Einmaligen Listener setzen
    socket.once('ClientCountResponse', (count) => {
      resolve(count);
      let clientCount = count;
      ClientCounter.innerText = `Zuschauer: ${clientCount}`;
    });
    socket.emit('ClientCountRequest');
  });
}
CountClientsRequest();
setInterval(CountClientsRequest, 10000); // alle 10 Sekunden aktualisieren