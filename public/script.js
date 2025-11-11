/* script.js — central room view, improved playback reliability, Ultra theme */
const socket = io();

let player;
let currentRoom = null;
let nickname = "";
let playerReady = false;
let isSeeking = false;

// DOM
const nicknameScreen = document.getElementById("nickname-screen");
const roomScreen = document.getElementById("room-screen");
const nicknameInput = document.getElementById("nickname");
const startBtn = document.getElementById("start-btn");
const createRoomBtn = document.getElementById("create-room");
const joinInput = document.getElementById("join-input");
const joinRoomBtn = document.getElementById("join-room");
const roomIdDisplay = document.getElementById("room-id-display");
const userList = document.getElementById("user-list");
const chatMessages = document.getElementById("chat-messages");
const chatBox = document.getElementById("chat-box");
const sendChat = document.getElementById("send-chat");

const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const results = document.getElementById("results");
const playBtn = document.getElementById("play-btn");
const pauseBtn = document.getElementById("pause-btn");
const seekBtn = document.getElementById("seek-btn");
const seekInput = document.getElementById("seek");
const loadBtn = document.getElementById("load-btn");
const nowPlaying = document.getElementById("now-playing");

// ---- nickname flow ----
startBtn.onclick = () => {
  nickname = nicknameInput.value.trim();
  if (!nickname) return alert("Please enter a nickname");
  nicknameScreen.classList.add("hidden");
  roomScreen.classList.remove("hidden");
};

// ---- rooms ----
createRoomBtn.onclick = () => {
  const id = Math.random().toString(36).slice(2,8);
  joinRoom(id);
};

joinRoomBtn.onclick = () => {
  const id = joinInput.value.trim();
  if (!id) return alert("Enter room ID");
  joinRoom(id);
};

function joinRoom(id){
  currentRoom = id;
  roomIdDisplay.textContent = `Room: ${id}`;
  socket.emit("join-room", { roomId: id, name: nickname });
}

// ---- chat ----
sendChat.onclick = () => {
  const t = chatBox.value.trim();
  if (!t) return;
  socket.emit("chat", t);
  chatBox.value = "";
};

socket.on("chat", (m) => {
  const d = document.createElement("div");
  d.innerHTML = `<b>${escapeHtml(m.name)}:</b> ${escapeHtml(m.text)}`;
  chatMessages.appendChild(d);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// ---- users ----
socket.on("user-list", (list) => {
  userList.innerHTML = "";
  list.forEach(u => {
    const li = document.createElement("li");
    li.textContent = u.name;
    userList.appendChild(li);
  });
});

// ---- youtube player setup ----
window.onYouTubeIframeAPIReady = function(){
  player = new YT.Player("youtube-player", {
    height: "360",
    width: "100%",
    videoId: "",
    playerVars: { rel:0, modestbranding:1, playsinline:1 },
    events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange }
  });
};

function onPlayerReady(){
  playerReady = true;
  console.log("YT player ready");
}

let lastEmit = 0;
function onPlayerStateChange(e){
  if (!currentRoom || !playerReady) return;
  // debounce frequent events
  const now = Date.now();
  if (now - lastEmit < 150) return;
  lastEmit = now;

  if (e.data === YT.PlayerState.PLAYING){
    const t = player.getCurrentTime();
    socket.emit("playback", { roomId: currentRoom, action:"play", time: t });
  } else if (e.data === YT.PlayerState.PAUSED){
    const t = player.getCurrentTime();
    socket.emit("playback", { roomId: currentRoom, action:"pause", time: t });
  }
}

// ---- remote playback handlers ----
socket.on("playback", (d) => {
  if (d.roomId !== currentRoom || !playerReady) return;
  // keep small tolerance to avoid ping jitter
  player.seekTo(d.time || 0, true);
  if (d.action === "play") player.playVideo();
  if (d.action === "pause") player.pauseVideo();
});

socket.on("load-video", (d) => {
  if (d.roomId !== currentRoom || !playerReady) return;
  console.log("Loading video:", d.videoId);
  loadVideoById(d.videoId, () => {
    // small delay to let iframe settle
    setTimeout(() => {
      if (player && typeof player.playVideo === "function") {
        player.playVideo();
      }
    }, 500);
  });
});

socket.on("seek", (d) => {
  if (d.roomId !== currentRoom || !playerReady) return;
  player.seekTo(d.time || 0, true);
});

socket.on("sync-video", (d) => {
  if (!playerReady) return;
  if (d.videoId) {
    loadVideoById(d.videoId, () => {
      player.seekTo(d.time || 0, true);
      if (d.isPlaying) player.playVideo(); else player.pauseVideo();
    });
  }
});

// ---- local control buttons (user gestures ensure play works) ----
playBtn.onclick = () => {
  if (!playerReady) return alert("Player not ready yet");
  // user gesture: ensure play action is triggered directly by click
  player.playVideo();
  const t = player.getCurrentTime();
  socket.emit("playback", { roomId: currentRoom, action:"play", time: t });
};

pauseBtn.onclick = () => {
  if (!playerReady) return;
  player.pauseVideo();
  const t = player.getCurrentTime();
  socket.emit("playback", { roomId: currentRoom, action:"pause", time: t });
};

seekBtn.onclick = () => {
  const s = parseFloat(seekInput.value);
  if (!playerReady || isNaN(s)) return;
  player.seekTo(s, true);
  socket.emit("seek", { roomId: currentRoom, time: s });
};

loadBtn.onclick = () => {
  const id = extractYouTubeId(document.getElementById("search-input").value.trim() || "");
  if (!id) return alert("Paste YouTube id or search and press Play on a result");
  socket.emit("load-video", { roomId: currentRoom, videoId: id });
  nowPlaying.textContent = id;
};

// ---- better search (uses window.YT_API_KEY) ----
searchBtn.onclick = async () => {
  const q = searchInput.value.trim();
  if (!q) return;
  const key = window.YT_API_KEY;
  if (!key) return alert("Set window.YT_API_KEY in index.html");
  searchBtn.disabled = true;
  results.innerHTML = `<div class="muted">Searching...</div>`;
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(q)}&key=${key}`);
    const data = await res.json();
    renderSearchResults(data.items || []);
  } catch(e){
    console.error(e);
    results.innerHTML = `<div class="muted">Search failed</div>`;
  } finally {
    searchBtn.disabled = false;
  }
};

function renderSearchResults(items){
  results.innerHTML = "";
  items.forEach(it => {
    const vid = it.id.videoId;
    const title = it.snippet.title;
    const thumb = it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || "";
    const card = document.createElement("div");
    card.className = "video-card";
    card.innerHTML = `<img src="${thumb}" alt=""><p>${escapeHtml(title)}</p><div style="display:flex;gap:8px"><button class="btn small" data-id="${vid}">Load</button><button class="btn small primary" data-id="${vid}">Play</button></div>`;
    const loadBtnLocal = card.querySelectorAll("button")[0];
    const playBtnLocal = card.querySelectorAll("button")[1];

    loadBtnLocal.onclick = () => {
      socket.emit("load-video", { roomId: currentRoom, videoId: vid });
      nowPlaying.textContent = title;
    };

    playBtnLocal.onclick = () => {
      socket.emit("load-video", { roomId: currentRoom, videoId: vid });
      // give a small delay for clients to load, then issue play (also user gesture)
      setTimeout(() => {
        // local user gesture
        if (playerReady) {
          player.playVideo();
          const t = player.getCurrentTime();
          socket.emit("playback", { roomId: currentRoom, action:"play", time: t });
        }
      }, 600);
      nowPlaying.textContent = title;
    };

    results.appendChild(card);
  });
}

// ---- helper: load video safely ----
function loadVideoById(id, cb){
  if (!playerReady) {
    const wait = setInterval(() => {
      if (playerReady) {
        clearInterval(wait);
        player.loadVideoById(id);
        nowPlaying.textContent = id;
        if (cb) setTimeout(cb, 600);
      }
    }, 150);
    return;
  }
  player.loadVideoById(id);
  nowPlaying.textContent = id;
  if (cb) setTimeout(cb, 600);
}


// ---- small utils ----
function extractYouTubeId(u){
  if (!u) return "";
  // if plain id
  if (/^[A-Za-z0-9_-]{11}$/.test(u)) return u;
  try {
    const url = new URL(u);
    if (url.hostname.includes("youtu.be")) return url.pathname.slice(1);
    if (url.searchParams.get("v")) return url.searchParams.get("v");
  } catch(e){}
  const m = u.match(/(?:v=|\/embed\/|\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : "";
}

function escapeHtml(s){ if(!s) return ""; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]))}
