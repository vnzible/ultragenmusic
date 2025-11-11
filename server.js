require('dotenv').config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // CORS can be configured here if hosting separately
  cors: { origin: "*" }
});

app.get('/config.js', (req, res) => {
  res.type('js').send(`window.YT_API_KEY = "${process.env.YT_API_KEY || ''}";`);
});

app.use(express.static(path.join(__dirname, "public")));

const rooms = {}; // { roomId: { users:[{id,name}], video:null, time:0, isPlaying:false, title: '' } }

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, name }) => {
    socket.join(roomId);
    socket.data = { name, roomId };

    if (!rooms[roomId]) rooms[roomId] = { users: [], video: null, time: 0, isPlaying: false, title: '' };
    rooms[roomId].users.push({ id: socket.id, name });

    io.to(roomId).emit("user-list", rooms[roomId].users);
    if (rooms[roomId].video) {
      socket.emit("sync-video", {
        videoId: rooms[roomId].video,
        time: rooms[roomId].time,
        isPlaying: rooms[roomId].isPlaying,
        title: rooms[roomId].title || null
      });
    }
  });

  socket.on("chat", (msg) => {
    const { roomId, name } = socket.data;
    if (roomId) io.to(roomId).emit("chat", { name, text: msg });
  });

  socket.on("playback", (data) => {
    const room = rooms[data.roomId];
    if (!room) return;
    room.time = data.time;
    room.isPlaying = data.action === "play";
    io.to(data.roomId).emit("playback", data);
  });

  socket.on("load-video", (data) => {
    const room = rooms[data.roomId];
    if (!room) return;
    room.video = data.videoId;
    room.isPlaying = !!data.playNow;
    room.time = 0;
    room.title = data.title || null;
    io.to(data.roomId).emit("load-video", data);
  });

  socket.on("seek", (data) => {
    const room = rooms[data.roomId];
    if (!room) return;
    room.time = data.time;
    io.to(data.roomId).emit("seek", data);
  });

  // respond to client ping with echo (for latency)
  socket.on("ping", (t0, cb) => {
    if (typeof cb === 'function') cb(Date.now());
  });

  socket.on("request-sync", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    io.to(socket.id).emit("sync-video", {
      videoId: room.video,
      time: room.time,
      isPlaying: room.isPlaying,
      title: room.title || null
    });
  });

  socket.on("disconnect", () => {
    const { roomId } = socket.data || {};
    if (!roomId || !rooms[roomId]) return;
    rooms[roomId].users = rooms[roomId].users.filter(u => u.id !== socket.id);
    io.to(roomId).emit("user-list", rooms[roomId].users);
    if (rooms[roomId].users.length === 0) delete rooms[roomId];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
