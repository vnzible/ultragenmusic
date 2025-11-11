// Annusic — robust client script
// Key changes:
// - single dynamic loader for YT iframe API
// - no duplicate onYouTubeIframeAPIReady
// - latency-aware sync and drift correction
// - responsive player sizing (CSS handles aspect ratio)
// - retries & graceful degradation

const socket = io();

let player = null;
let playerReady = false;
let playerCreating = false;
let currentRoom = null;
let nickname = "";
let lastEmit = 0;
let latency = 0;

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
  // ensure YT API loads and player is created
  ensurePlayerCreated();
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

// ---- latency ping (simple) ----
function pingServer(){
  const t0 = Date.now();
  socket.emit("ping", t0, (ts) => {
    const t1 = Date.now();
    latency = (t1 - t0) / 2;
  });
}
setInterval(pingServer, 5000);

// ---- YT loader (single place) ----
function loadYouTubeAPI(){
  return new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve();
    if (document.querySelector('script[data-yt-loader]')) {
      // already injected, poll
      const poll = setInterval(() => {
        if (window.YT && window.YT.Player) {
          clearInterval(poll);
          resolve();
        }
      }, 150);
      // safety timeout
      setTimeout(() => { clearInterval(poll); resolve(); }, 10000);
      return;
    }

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    tag.setAttribute('data-yt-loader', '1');
    document.head.appendChild(tag);

    // youtube will call this global when ready
    window.onYouTubeIframeAPIReady = function(){
      resolve();
    };

    // fallback safety
    setTimeout(() => {
      if (window.YT && window.YT.Player) resolve();
      else resolve(); // still resolve (we'll handle missing player)
    }, 9000);
  });
}

// ---- create player safely (id: youtube-player) ----
async function ensurePlayerCreated(){
  if (playerReady || playerCreating) return;
  playerCreating = true;

  await loadYouTubeAPI();

  // wait until DOM element is present & visible
  const el = document.getElementById("youtube-player");
  const waitDom = new Promise(res => {
    let tries = 0;
    const poll = setInterval(() => {
      tries++;
      if (el) { clearInterval(poll); res(); }
      if (tries > 60) { clearInterval(poll); res(); }
    }, 100);
  });
  await waitDom;

  tryCreatePlayer();
}

function tryCreatePlayer(retries = 0){
  try {
    if (!window.YT || !YT.Player) {
      if (retries < 6) return setTimeout(() => tryCreatePlayer(retries+1), 700);
      console.warn("YT.Player unavailable after retries");
      playerCreating = false;
      return;
    }

    player = new YT.Player('youtube-player', {
      height: '100%',
      width: '100%',
      videoId: '',
      playerVars: { rel:0, modestbranding:1, playsinline:1, iv_load_policy:3 },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
        onError: (e) => console.warn("YT error", e)
      }
    });
  } catch(e) {
    console.warn("createPlayer failed, retrying", e);
    if (retries < 6) setTimeout(() => tryCreatePlayer(retries+1), 800);
    else playerCreating = false;
  }
}

function onPlayerReady(){
  playerReady = true;
  playerCreating = false;
  console.log("Annusic YT player ready");
  // request server sync after ready
  if (currentRoom) socket.emit("request-sync", { roomId: currentRoom });
}

// state change -> emit playback events (debounced)
function onPlayerStateChange(e){
  if (!currentRoom || !playerReady) return;
  const now = Date.now();
  if (now - lastEmit < 150) return;
  lastEmit = now;

  const t = player.getCurrentTime();
  if (e.data === YT.PlayerState.PLAYING) {
    socket.emit("playback", { roomId: currentRoom, action: "play", time: t });
  } else if (e.data === YT.PlayerState.PAUSED) {
    socket.emit("playback", { roomId: currentRoom, action: "pause", time: t });
  }
}

// ---- remote playback handlers (with drift correction) ----
socket.on("playback", (d) => {
  if (d.roomId !== currentRoom || !playerReady) return;
  // compensate for measured latency
  const expectedTime = (d.time || 0) + (latency/1000);
  correctDriftAndApply(expectedTime, d.action);
});

socket.on("load-video", (d) => {
  if (d.roomId !== currentRoom) return;
  ensurePlayerCreated().then(() => {
    loadVideoById(d.videoId, () => {
      // small delay then play/pause based on server state
      setTimeout(() => {
        if (d.playNow && player && player.playVideo) player.playVideo();
      }, 500);
    });
  });
});

socket.on("seek", (d) => {
  if (d.roomId !== currentRoom || !playerReady) return;
  const t = (d.time || 0) + (latency/1000);
  player.seekTo(t, true);
});

socket.on("sync-video", (d) => {
  if (!playerReady) {
    // will be handled when player becomes ready (request-sync after ready)
    return;
  }
  if (d.videoId) {
    loadVideoById(d.videoId, () => {
      const expected = (d.time || 0) + (latency/1000);
      player.seekTo(expected, true);
      if (d.isPlaying) player.playVideo(); else player.pauseVideo();
      nowPlaying.textContent = d.title || d.videoId;
    });
  }
});

// helper: correct drift before applying action
function correctDriftAndApply(expectedTime, action){
  try {
    const local = player.getCurrentTime();
    const diff = Math.abs(local - expectedTime);
    if (diff > 0.6) {
      // big drift -> seek
      player.seekTo(expectedTime, true);
    }
    if (action === "play") player.playVideo();
    if (action === "pause") player.pauseVideo();
  } catch(e) {
    console.warn("drift correction failed", e);
  }
}

// ---- local controls ----
playBtn.onclick = () => {
  if (!playerReady) return alert("Player not ready yet");
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
  socket.emit("load-video", { roomId: currentRoom, videoId: id, playNow: false });
  nowPlaying.textContent = id;
};

// ---- search (uses config-served YT key) ----
searchBtn.onclick = async () => {
  const q = searchInput.value.trim();
  if (!q) return;
  const key = window.YT_API_KEY;
  if (!key) return alert("Set window.YT_API_KEY in config");
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
      socket.emit("load-video", { roomId: currentRoom, videoId: vid, playNow: false });
      nowPlaying.textContent = title;
    };

    playBtnLocal.onclick = () => {
      // must be triggered by user gesture
      socket.emit("load-video", { roomId: currentRoom, videoId: vid, playNow: true });
      // small local attempt to play (user gesture)
      ensurePlayerCreated().then(() => {
        setTimeout(() => {
          if (playerReady) {
            player.playVideo();
            const t = player.getCurrentTime();
            socket.emit("playback", { roomId: currentRoom, action:"play", time: t });
          }
        }, 500);
      });
      nowPlaying.textContent = title;
    };

    results.appendChild(card);
  });
}

// safe loader for playing
function loadVideoById(id, cb){
  if (!playerReady) {
    const wait = setInterval(() => {
      if (playerReady) {
        clearInterval(wait);
        try {
          player.loadVideoById(id);
        } catch(e){ console.warn(e); }
        nowPlaying.textContent = id;
        if (cb) setTimeout(cb, 600);
      }
    }, 150);
    return;
  }
  try {
    player.loadVideoById(id);
    nowPlaying.textContent = id;
    if (cb) setTimeout(cb, 600);
  } catch(e) {
    console.warn("loadVideoById fail", e);
  }
}

// ---- helpers ----
function extractYouTubeId(u){
  if (!u) return "";
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

// ---- socket ping handler on server side (server responds with ts) ----
socket.on("connect", () => {
  console.log("connected to socket");
  pingServer();
});

// === MOBILE TAB SWITCH ===
const tabs = document.querySelectorAll('.tab-btn');
const panels = document.querySelectorAll('.tab-panel');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const target = document.getElementById(`tab-${tab.dataset.tab}`);
    if (target) target.classList.add('active');
  });
});

// === COPY ROOM ID ===
document.getElementById('copy-room').onclick = () => {
  const idText = document.getElementById('room-id-display').textContent.replace('Room: ', '').trim();
  navigator.clipboard.writeText(idText).then(() => {
    alert(`Room ID copied: ${idText}`);
  });
};


// ------- MOBILE: wire up tabs, copy, mobile join/search/chat to main handlers -------
document.addEventListener('DOMContentLoaded', () => {

  // --- Helper to copy room id (fallback)
  function copyTextToClipboard(text) {
    if (!text) return Promise.reject('no text');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); document.body.removeChild(ta); return Promise.resolve(); }
    catch (e) { document.body.removeChild(ta); return Promise.reject(e); }
  }

  // --- COPY ROOM ID button (mobile)
  const copyBtn = document.getElementById('copy-room');
  copyBtn && copyBtn.addEventListener('click', () => {
    // prefer mobile display id then desktop
    const mobileDisplay = document.getElementById('room-id-display-mobile');
    const desktopDisplay = document.getElementById('room-id-display');
    const raw = (mobileDisplay && mobileDisplay.textContent) || (desktopDisplay && desktopDisplay.textContent) || '';
    const id = raw.replace('Room:','').trim();
    copyTextToClipboard(id).then(() => {
      // friendly small toast using alert for now
      alert(`Room ID copied: ${id}`);
    }).catch(() => alert('Copy failed'));
  });

  // --- Mobile join/create buttons: reuse existing join logic if present
  const joinMobileBtn = document.getElementById('join-room-mobile');
  const createMobileBtn = document.getElementById('create-room-mobile');

  joinMobileBtn && joinMobileBtn.addEventListener('click', () => {
    const id = (document.getElementById('join-input-mobile')||{}).value || '';
    if (!id) return alert('Enter room id');
    // call the same joinRoom used earlier
    if (typeof joinRoom === 'function') joinRoom(id);
    // update both displays
    const both = document.querySelectorAll('#room-id-display,#room-id-display-mobile');
    both.forEach(el => el.textContent = `Room: ${id}`);
  });

  createMobileBtn && createMobileBtn.addEventListener('click', () => {
    // reuse the same create handler as desktop
    if (typeof createRoom === 'function') {
      // if createRoom function exists, call it; otherwise fallback to random
      try { createRoom(); } catch(e) {
        const id = Math.random().toString(36).slice(2,8);
        if (typeof joinRoom === 'function') joinRoom(id);
        document.querySelectorAll('#room-id-display,#room-id-display-mobile').forEach(el => el.textContent = `Room: ${id}`);
      }
    } else {
      const id = Math.random().toString(36).slice(2,8);
      if (typeof joinRoom === 'function') joinRoom(id);
      document.querySelectorAll('#room-id-display,#room-id-display-mobile').forEach(el => el.textContent = `Room: ${id}`);
    }
  });

  // --- Tabs switching (mobile)
  const tabButtons = Array.from(document.querySelectorAll('#mobile-tabs .tab-btn'));
  const panels = {
    search: document.getElementById('tab-search'),
    chat: document.getElementById('tab-chat'),
    members: document.getElementById('tab-members')
  };

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // hide/show panels
      Object.values(panels).forEach(p => p && p.classList.remove('active'));
      const t = btn.dataset.tab;
      if (panels[t]) panels[t].classList.add('active');
    });
  });

  // --- Wire mobile search to main search handler (reuse same YT search)
  const mobileSearchBtn = document.getElementById('search-btn-mobile');
  mobileSearchBtn && mobileSearchBtn.addEventListener('click', async () => {
    const q = (document.getElementById('search-input-mobile')||{}).value || '';
    if (!q) return alert('Enter search terms');
    const key = window.YT_API_KEY;
    if (!key) return alert('API key missing');
    mobileSearchBtn.disabled = true;
    const out = document.getElementById('results-mobile');
    out.innerHTML = '<div class="muted">Searching...</div>';
    try {
      const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(q)}&key=${key}`);
      const data = await res.json();
      renderMobileSearchResults((data.items||[]), out);
    } catch (e) {
      out.innerHTML = '<div class="muted">Search failed</div>';
    } finally { mobileSearchBtn.disabled = false; }
  });

  // helper to render mobile results (creates same Load/Play buttons as desktop)
  function renderMobileSearchResults(items, container) {
    container.innerHTML = '';
    items.forEach(it => {
      const vid = it.id.videoId;
      const title = it.snippet.title;
      const thumb = it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || '';
      const card = document.createElement('div');
      card.className = 'video-card';
      card.innerHTML = `<img src="${thumb}" alt=""><p>${escapeHtml(title)}</p><div style="display:flex;gap:8px"><button class="btn small load" data-id="${vid}">Load</button><button class="btn small primary play" data-id="${vid}">Play</button></div>`;
      container.appendChild(card);

      card.querySelector('.load').addEventListener('click', () => {
        socket.emit('load-video', { roomId: currentRoom, videoId: vid, playNow: false });
        nowPlaying && (nowPlaying.textContent = title);
      });

      card.querySelector('.play').addEventListener('click', () => {
        socket.emit('load-video', { roomId: currentRoom, videoId: vid, playNow: true });
        ensurePlayerCreated().then(()=> {
          setTimeout(()=> {
            if (playerReady && player && player.playVideo) {
              try { player.playVideo(); const t = player.getCurrentTime(); socket.emit('playback',{ roomId: currentRoom, action:'play', time: t }); } catch(e){}
            }
          }, 600);
        });
        nowPlaying && (nowPlaying.textContent = title);
      });
    });
  }

  // --- Wire mobile chat send to main socket logic
  const mobileSend = document.getElementById('send-chat-mobile');
  mobileSend && mobileSend.addEventListener('click', () => {
    const box = document.getElementById('chat-box-mobile');
    const text = (box && box.value || '').trim();
    if (!text) return;
    socket.emit('chat', text);
    box.value = '';
  });

  // Update mobile members & chat when server events arrive
  socket.on('user-list', (list) => {
    const mobileUL = document.getElementById('user-list-mobile');
    if (mobileUL) {
      mobileUL.innerHTML = '';
      list.forEach(u => {
        const li = document.createElement('li'); li.textContent = u.name; mobileUL.appendChild(li);
      });
    }
    // keep desktop list updated too (original handler may already do this)
    const desktopUL = document.getElementById('user-list');
    if (desktopUL) {
      desktopUL.innerHTML = '';
      list.forEach(u => { const li = document.createElement('li'); li.textContent = u.name; desktopUL.appendChild(li); });
    }
  });

  socket.on('chat', (m) => {
    const mobileMsgs = document.getElementById('chat-messages-mobile');
    if (mobileMsgs) {
      const d = document.createElement('div');
      d.innerHTML = `<b>${escapeHtml(m.name)}:</b> ${escapeHtml(m.text)}`;
      mobileMsgs.appendChild(d);
      mobileMsgs.scrollTop = mobileMsgs.scrollHeight;
    }
    // desktop handler may also update desktop chat
    const desktopMsgs = document.getElementById('chat-messages');
    if (desktopMsgs) {
      const d2 = document.createElement('div'); d2.innerHTML = `<b>${escapeHtml(m.name)}:</b> ${escapeHtml(m.text)}`; desktopMsgs.appendChild(d2); desktopMsgs.scrollTop = desktopMsgs.scrollHeight;
    }
  });

  // ensure room display updates reflect both mobile & desktop
  function syncRoomDisplays(id) {
    document.querySelectorAll('#room-id-display,#room-id-display-mobile').forEach(el => el.textContent = `Room: ${id}`);
  }
  // if your joinRoom function already updates displays, this is redundant but safe
  window.syncRoomDisplays = syncRoomDisplays;

});
