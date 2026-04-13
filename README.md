# dmap

LAN DnD map viewer with DM controls and synced player projection view.

## Features

- Browser-based DM and player pages
- Load PNG/JPG/PDF maps
- PDF page picker
- Pan/zoom map camera
- Fog of war with round/square brushes
- Brush hardness control (soft to hard edges)
- Reveal and re-fog modes
- Undo/redo fog strokes
- DM camera sync lock toggle
- Random room code per launch
- Localhost-only DM controls
- Debounced auto-save of session data
- LAN player URL + QR code

## Requirements

- Node.js LTS
- npm
- uv (for your Python tooling in this repo)

Check and upgrade tools:

```powershell
npm run doctor
winget upgrade --id OpenJS.NodeJS.LTS -e
winget upgrade --id astral-sh.uv -e
```

## Run

Development:

```powershell
npm install
npm run dev
```

Production session run:

```powershell
npm install
npm run session
```

Windows launcher (double-click or run in PowerShell):

```powershell
.\Start-DMap.ps1
```

## URLs

- DM: `http://localhost:4100/dm` (localhost-only)
- Player: LAN URL printed by the server on startup

## Storage

- Maps: `data/maps/*`
- Session state: `data/session.json`
- Cache folder: `data/cache/*`

## Tests

```powershell
npm run test
npx playwright install
npm run test:e2e
```
