/* global YT */
(function () {
  const socket = io({
    transports: ['websocket', 'polling'], // allow fallback if websocket is blocked
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
  });

  // UI elements
  const joinBtn = document.getElementById('joinBtn');
  const roomCodeEl = document.getElementById('roomCode');
  const usernameEl = document.getElementById('username');
  const asHostEl = document.getElementById('asHost');
  const statusEl = document.getElementById('status');
  const rttEl = document.getElementById('rtt');

  const loadBtn = document.getElementById('loadBtn');
  const playBtn = document.getElementById('playBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const seekBtn = document.getElementById('seekBtn');
  const seekTimeEl = document.getElementById('seekTime');
  const videoUrlEl = document.getElementById('videoUrl');

  const messagesEl = document.getElementById('messages');
  const chatInputEl = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const usersEl = document.getElementById('users');

  // State
  let roomCode = null;
  let username = null;
  let isHost = false;
  let player = null;
  let lastKnownState = { state: 'paused', time: 0, videoId: null };

  // RTT measurement
  let lastPingTs = null;
  let lastRttMs = null;
  function sendPing() {
    lastPingTs = Date.now();
    socket.emit('rtt_ping', { ts: lastPingTs });
  }
  setInterval(sendPing, 5000);

  socket.on('rtt_pong', ({ ts }) => {
    if (typeof ts === 'number' && lastPingTs === ts) {
      const now = Date.now();
      lastRttMs = now - ts;
      rttEl.textContent = `RTT: ${lastRttMs} ms`;
    }
  });

  // YouTube Player API
  let ytReady = false;
  window.onYouTubeIframeAPIReady = function () {
    ytReady = true;
    createPlayer('');
  };

  function extractVideoId(input) {
    if (!input) return '';
    try {
      if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
      const url = new URL(input);
      if (url.hostname.includes('youtu.be')) {
        return url.pathname.replace('/', '').slice(0, 11);
      }
      if (url.searchParams.has('v')) {
        return url.searchParams.get('v');
      }
    } catch (_) {}
    return input.length === 11 ? input : '';
  }

  function createPlayer(videoId) {
    const opts = {
      height: '390',
      width: '640',
      videoId: videoId || undefined,
      playerVars: { playsinline: 1 },
      events: {
        onReady: () => updateControls(),
        onStateChange: onPlayerStateChange,
      },
    };
    player = new YT.Player('player', opts);
  }

  function onPlayerStateChange(e) {
    if (!isHost) return;
    const state = e.data; // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    const currentTime = safeCurrentTime();
    const hostTime = Date.now();
    if (state === 1) {
      emitHostAction({ type: 'play', time: currentTime, state: 'playing', hostTime });
    } else if (state === 2) {
      emitHostAction({ type: 'pause', time: currentTime, state: 'paused', hostTime });
    }
  }

  function safeCurrentTime() {
    try {
      return player && typeof player.getCurrentTime === 'function' ? player.getCurrentTime() : 0;
    } catch (_) {
      return 0;
    }
  }

  function seekTo(t) {
    if (!player) return;
    try { player.seekTo(t, true); } catch (_) {}
  }

  function loadVideo(videoId) {
    if (!player) return;
    try { player.loadVideoById(videoId); } catch (_) {}
  }

  function updateControls() {
    const joined = !!roomCode;
    loadBtn.disabled = !(joined && isHost);
    playBtn.disabled = !(joined && isHost);
    pauseBtn.disabled = !(joined && isHost);
    seekBtn.disabled = !(joined && isHost);
  }

  function emitHostAction(payload) {
    if (!roomCode) return;
    socket.emit('host_action', { roomCode, ...payload });
  }

  // Host heartbeat every 5s
  setInterval(() => {
    if (!isHost || !roomCode) return;
    const hostTime = Date.now();
    emitHostAction({ type: 'heartbeat', time: safeCurrentTime(), state: getStateString(), hostTime });
  }, 5000);

  function getStateString() {
    try {
      const st = player.getPlayerState();
      return st === 1 ? 'playing' : 'paused';
    } catch (_) {
      return 'paused';
    }
  }

  // Socket events
  socket.on('connect', () => {
    statusEl.textContent = 'Connected';
    updateControls();
  });
  socket.on('disconnect', (reason) => {
    statusEl.textContent = `Disconnected (${reason})`;
    updateControls();
  });
  socket.on('host_confirmed', () => {
    isHost = true;
    updateControls();
  });
  socket.on('host_left', () => {
    if (isHost) return;
    appendMessage({ system: true, message: 'Host left. A new host is needed.' });
  });
  socket.on('room_state', (state) => {
    lastKnownState = state;
    if (state.videoId) {
      loadVideo(state.videoId);
      // Apply approximate sync
      if (typeof state.playbackTime === 'number') {
        const rttHalfMs = (lastRttMs || 0) / 2;
        const rttHalfSec = rttHalfMs / 1000; // convert ms -> seconds
        const serverToClientDelay = rttHalfSec; // one-way latency estimate
        const target = state.playbackState === 'playing'
          ? state.playbackTime + serverToClientDelay
          : state.playbackTime;
        const current = safeCurrentTime();
        const diff = Math.abs(current - target);
        const finalTarget = diff > 0.15 ? target : current;
        seekTo(finalTarget);
        if (state.playbackState === 'playing') {
          try { player.playVideo(); } catch (_) {}
        } else {
          try { player.pauseVideo(); } catch (_) {}
        }
      }
    }
  });

  socket.on('room_users', ({ users }) => {
    usersEl.innerHTML = '';
    (users || []).forEach(u => {
      const li = document.createElement('li');
      li.textContent = u.username;
      usersEl.appendChild(li);
    });
  });

  socket.on('host_action', ({ type, videoId, time, state }) => {
    const rttHalf = (lastRttMs || 0) / 2 / 1000; // seconds
    let targetTime = typeof time === 'number' ? time : safeCurrentTime();
    if (type === 'play' || type === 'seek' || type === 'heartbeat') {
      targetTime += rttHalf;
    }
    if (type === 'load' && videoId) {
      loadVideo(videoId);
    }
    if (typeof targetTime === 'number' && !Number.isNaN(targetTime)) {
      seekTo(targetTime);
    }
    if (state === 'playing') {
      try { player.playVideo(); } catch (_) {}
    } else if (state === 'paused') {
      try { player.pauseVideo(); } catch (_) {}
    }
  });

  // Chat
  function appendMessage({ username, message, ts, system }) {
    const div = document.createElement('div');
    div.className = system ? 'msg system' : 'msg';
    const timeStr = ts ? new Date(ts).toLocaleTimeString() : '';
    div.textContent = system ? message : `[${timeStr}] ${username}: ${message}`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  socket.on('chat_message', (msg) => appendMessage(msg));

  // UI actions
  joinBtn.addEventListener('click', () => {
    roomCode = (roomCodeEl.value || '').trim();
    username = (usernameEl.value || '').trim() || 'anon';
    isHost = !!asHostEl.checked;
    if (!roomCode) {
      alert('Enter a room code');
      return;
    }
    socket.emit('join_room', { roomCode, username, asHost: isHost });
    updateControls();
  });

  loadBtn.addEventListener('click', () => {
    const v = extractVideoId(videoUrlEl.value);
    if (!v) return alert('Enter a valid YouTube URL or 11-char video ID');
    loadVideo(v);
    emitHostAction({ type: 'load', videoId: v, time: safeCurrentTime(), state: getStateString(), hostTime: Date.now() });
  });

  playBtn.addEventListener('click', () => {
    try { player.playVideo(); } catch (_) {}
    emitHostAction({ type: 'play', time: safeCurrentTime(), state: 'playing', hostTime: Date.now() });
  });

  pauseBtn.addEventListener('click', () => {
    try { player.pauseVideo(); } catch (_) {}
    emitHostAction({ type: 'pause', time: safeCurrentTime(), state: 'paused', hostTime: Date.now() });
  });

  seekBtn.addEventListener('click', () => {
    const t = parseFloat(seekTimeEl.value || '0');
    if (Number.isNaN(t)) return;
    seekTo(t);
    emitHostAction({ type: 'seek', time: t, state: getStateString(), hostTime: Date.now() });
  });

  sendBtn.addEventListener('click', sendChat);
  chatInputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  function sendChat() {
    const msg = (chatInputEl.value || '').trim();
    if (!msg || !roomCode) return;
    socket.emit('chat_message', { roomCode, username, message: msg });
    chatInputEl.value = '';
  }
})();
