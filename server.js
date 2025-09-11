const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  socket.on('changeStep', (step) => {
    io.emit('setStep', step);
  });
  socket.on('startShow', (step) => {
    io.emit('startShow', step);
  });
  socket.on('play', () => io.emit('play'));
  socket.on('pause', () => io.emit('pause'));
  socket.on('mute', (muted) => io.emit('mute', muted));
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
