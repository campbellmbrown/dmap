# dmap

A LAN-based D&D map viewer with real-time DM controls and synchronized player views. The DM runs the server locally, uploads maps, paints fog-of-war, and players connect over the local network to see the current view.

## Features

- Browser-based DM and player pages (no installation for players)
- Load PNG, JPG, and PDF maps (with PDF page picker)
- Fog-of-war painting with round/square brushes and hardness control
- Freehand brush and rectangle fog tool
- Reveal and re-fog modes
- Undo/redo fog strokes (up to 1000 history entries)
- Pan/zoom camera with optional DM-to-player camera sync lock
- Localhost-only DM controls (players are read-only)
- Debounced auto-save of session state every 500ms
- LAN player URL displayed on DM page

## Requirements

- Node.js 22+
- npm

Check and upgrade tools:

```powershell
npm run doctor
winget upgrade --id OpenJS.NodeJS.LTS -e
```

## Run

**Development** (hot reload, client on port 5173, server on port 4100):

```powershell
npm install
npm run dev
```

**Production session** (builds then serves everything from port 4100):

```powershell
npm install
npm run session
```

**Windows launcher** (double-click or run in PowerShell):

```powershell
.\Start-DMap.ps1
```

## Usage

1. Start the server. The DM page opens at `http://localhost:4100/dm` (localhost only).
2. The server prints a LAN URL — share this with players so they can connect from their devices on the same network.
3. On the DM page, upload a map (PNG, JPG, or PDF). For PDFs, pick the page to display.
4. Use the brush or rectangle tool to reveal or re-fog areas of the map.
5. Players see the current map state with fog applied. Toggle **camera sync** to lock the player view to the DM's current pan/zoom.

### DM Controls

| Control | Description |
|---------|-------------|
| Brush tool | Freehand fog painting with variable size and hardness |
| Rectangle tool | Draw rectangular fog/reveal regions with soft edges |
| Pan tool | Drag to move the camera (or middle-click drag) |
| Scroll wheel | Zoom in/out |
| Reveal / Re-fog | Toggle whether the brush reveals or applies fog |
| Brush hardness | Slider from soft (feathered) to hard edges |
| Camera sync | Lock players to the DM's viewport |
| Undo / Redo | Step through fog stroke history |

## URLs

- DM: `http://localhost:4100/dm` (localhost only)
- Player: LAN URL printed by the server on startup (e.g. `http://192.168.x.x:4100/player?room=XXXX`)

## Storage

- Maps: `data/maps/` (uploaded files, UUID filenames)
- Session state: `data/session.json` (maps, fog history, camera, room code)
- Cache: `data/cache/`

## Tests

```powershell
npm run test
npx playwright install
npm run test:e2e
```

## Architecture

```
dmap/
├── client/   React 19 + Vite — DM and player browser UI
├── server/   Fastify + WebSocket — HTTP API, file upload, session store
└── shared/   Types and fog engine — shared between client and server
```

The fog-of-war state is a grayscale mask (up to 2048px) persisted as stroke history. The server broadcasts state changes over WebSocket; clients apply strokes locally for low-latency painting and sync with the server's authoritative state.
