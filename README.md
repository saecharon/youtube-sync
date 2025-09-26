# YouTube Sync + Chat (Express + Socket.IO)

Real-time YouTube watch party with room codes, host-driven sync, drift correction via heartbeat + RTT compensation, and chat.

## Features
- Express server with Socket.IO (WebSocket preferred)
- Static frontend in `public/` using YouTube IFrame Player API
- Rooms with simple join by code + username; first joiner or checkbox becomes host
- Host actions broadcast: `load`, `play`, `pause`, `seek`, `heartbeat`
- Client-side RTT measurement for latency compensation and drift correction
- Real-time chat to all participants in the room
- Healthcheck: `GET /health` -> 200 OK
- Optional Redis adapter for Socket.IO scaling (if `REDIS_URL` provided)

## Quick start (local)
```bash
npm install
# Windows PowerShell
$env:PORT=3000; $env:NODE_ENV='development'; node index.js
# or
npm start
```
Open http://localhost:3000 and join a room (e.g., `abc123`).
Open a second browser/incognito window to test synchronization.

## Temporary public testing (ngrok)
If you need a temporary HTTPS URL, install ngrok and run:
```bash
# Start server locally first on PORT=3000
ngrok http 3000
```
Share the `https://*.ngrok.io` URL with testers.

## Environment variables
Copy `.env.example` to `.env` if running locally. The server respects these:
- `PORT` — server port (host sets automatically on Railway/Render)
- `NODE_ENV` — `production` or `development`
- `REDIS_URL` — optional, enables Socket.IO Redis adapter for multi-instance scaling
- `BASE_URL` — optional, helpful for absolute links (not required)
- `YOUTUBE_API_KEY` — optional, only if adding Data API search (not required for playback)

## Deployment (Railway recommended)
1. Push this repo to GitHub (branch: `deploy/windsurf`).
2. In Railway, create a new project and "Deploy from GitHub". Select this repo and the default Node template.
3. Railway auto-detects Node and runs `npm install` then `npm start` (which runs `node index.js`).
4. Set environment variables on the Railway service:
   - `NODE_ENV=production`
   - `REDIS_URL` (optional)
5. After deploy completes, open the Railway-provided HTTPS URL.

## Verification checklist
- Open two separate browsers/sessions.
- Host joins room `abc123`, loads a video via URL or 11-char ID.
- Play/pause/seek actions reflect on the other client within ~300ms.
- Chat messages appear in both clients.
- Heartbeat drift correction nudges playback to stay in sync.

## Security notes
- Do not commit real secrets. Use environment variables.
- This app uses the YouTube IFrame Player API; it does NOT download or redistribute videos.
