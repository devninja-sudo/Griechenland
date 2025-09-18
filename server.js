const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Keep track of the last scheduled live state (host schedules) so "go live" can broadcast it
let serverLiveState = null;

let Serverstep = 1; 
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  // If a live state is already scheduled, send it to the newly connected socket so
  // new clients join at the current live position immediately.
  if (serverLiveState) {
    // send only to the connecting socket so the client can seek to the correct time
    socket.emit('goLive', serverLiveState);
  }
  socket.on('changeStep', (step) => {
    io.emit('setStep', step);
    Serverstep = step;
  });
  socket.on('startShow', (step) => {
    io.emit('startShow', step);
    Serverstep = step;
  });
  // time synchronization request: reply immediately with server time
  socket.on('timeSync', (payload, cb) => {
    // If a callback is provided, use it to send server time immediately
    const serverTime = Date.now();
    if (typeof cb === 'function') return cb({ tServer: serverTime });
    // otherwise emit back to the requester
    socket.emit('timeSyncResult', { tServer: serverTime });
  });

  // schedule a step at an absolute server timestamp (host -> server -> all clients)
  socket.on('scheduleStep', (data) => {
    // data = { step: N, at: serverTimestamp }
    // update current live state to the scheduled item
    io.emit('scheduledStep', data);
    // store last scheduled (server-wide)
    serverLiveState = data;
    Serverstep = data.step;
  });


  
  // Host requests viewers be sent to the live position now
  socket.on('requestGoLive', () => {
    Serverstep = 1; 
    // broadcast current live state to all clients
    if (serverLiveState) {
      io.emit('goLive', serverLiveState);
    } else {
      // If no scheduled state, broadcast a simple 'goLiveNow' with server now
      io.emit('goLive', { step: null, at: Date.now() });
    }
  });

  socket.on('stopShow', () => {
    io.emit('goLive', { step: null, at: Date.now() });
    serverLiveState = null;
    Serverstep = 1; 
  });



  socket.on('getActStep', () => socket.emit('ActStepReport', Serverstep));

  socket.on('play', () => io.emit('play'));
  socket.on('pause', () => io.emit('pause'));
  socket.on('mute', (muted) => io.emit('mute', muted));
  socket.on('pauseattimestand', (timestand) => {
    io.emit('pauseattimestand', timestand)
  });
  
  socket.on('JumpToTimestamp', (timestand) => {
    io.emit('JumpToTimestamp', timestand)
  });
});

// Bind to 0.0.0.0 to ensure IPv4 localhost (127.0.0.1) works on all platforms
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
