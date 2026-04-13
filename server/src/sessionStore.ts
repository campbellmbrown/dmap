import { promises as fs } from "node:fs";
import path from "node:path";

import {
  MAX_HISTORY_STROKES,
  MAX_MASK_SIDE,
  SAVE_DEBOUNCE_MS,
  SESSION_FILE_NAME
} from "./constants";
import {
  applyStrokeToMask,
  createFullFogMask,
  encodeMask,
  getAdaptiveMaskSize,
  replayStrokes,
  type CameraState,
  type CameraSyncMeta,
  type FogState,
  type FogStroke,
  type MapAsset,
  type SessionSnapshot,
  type SessionState
} from "../../shared/src/index";

interface PersistedFogHistory {
  worldWidth: number;
  worldHeight: number;
  maskWidth: number;
  maskHeight: number;
  strokes: FogStroke[];
  historyIndex: number;
}

interface PersistedState {
  version: 1;
  maps: MapAsset[];
  session: {
    activeMapId: string | null;
    pdfPage: number;
    camera: CameraState;
    cameraSync: CameraSyncMeta | null;
    syncLock: boolean;
  };
  fogByKey: Record<string, PersistedFogHistory>;
}

interface FogHistoryState extends PersistedFogHistory {
  mask: Uint8ClampedArray;
  dirtyMask: boolean;
}

function mapPageKey(mapId: string, page: number): string {
  return `${mapId}:${page}`;
}

function createEmptyMask(maskWidth: number, maskHeight: number): Uint8ClampedArray {
  return createFullFogMask(maskWidth, maskHeight);
}

export class SessionStore {
  private readonly sessionFilePath: string;

  private readonly maps = new Map<string, MapAsset>();

  private readonly fogByKey = new Map<string, FogHistoryState>();

  private activeMapId: string | null = null;

  private pdfPage = 1;

  private camera: CameraState = { x: 0, y: 0, zoom: 1 };

  private cameraSync: CameraSyncMeta | null = null;

  private syncLock = true;

  private saveTimer: NodeJS.Timeout | null = null;

  public constructor(private readonly dataDir: string) {
    this.sessionFilePath = path.join(dataDir, SESSION_FILE_NAME);
  }

  public async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.loadFromDisk();
  }

  public listMaps(): MapAsset[] {
    return Array.from(this.maps.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  public getMapById(mapId: string): MapAsset | null {
    return this.maps.get(mapId) ?? null;
  }

  public getActiveMap(): MapAsset | null {
    if (!this.activeMapId) {
      return null;
    }

    return this.maps.get(this.activeMapId) ?? null;
  }

  public addMap(asset: MapAsset): void {
    this.maps.set(asset.id, asset);
    this.setActiveMap(asset.id, 1);
  }

  public setActiveMap(mapId: string | null, page: number = 1): void {
    if (mapId === null) {
      this.activeMapId = null;
      this.pdfPage = 1;
      this.queueSave();
      return;
    }

    const asset = this.maps.get(mapId);
    if (!asset) {
      throw new Error(`Map not found: ${mapId}`);
    }

    this.activeMapId = mapId;
    this.pdfPage = this.clampPage(asset, page);
    this.ensureFogHistory(asset, this.pdfPage);
    this.queueSave();
  }

  public setPdfPage(page: number): void {
    const activeMap = this.getActiveMap();
    if (!activeMap) {
      throw new Error("No active map");
    }

    this.pdfPage = this.clampPage(activeMap, page);
    this.ensureFogHistory(activeMap, this.pdfPage);
    this.queueSave();
  }

  public setSyncLock(syncLock: boolean): void {
    this.syncLock = syncLock;
    this.queueSave();
  }

  public setCamera(camera: CameraState, cameraSync?: CameraSyncMeta | null): void {
    this.camera = {
      x: Number.isFinite(camera.x) ? camera.x : 0,
      y: Number.isFinite(camera.y) ? camera.y : 0,
      zoom: Number.isFinite(camera.zoom) ? camera.zoom : 1
    };

    if (cameraSync !== undefined) {
      this.cameraSync = cameraSync;
    }
    this.queueSave();
  }

  public applyStroke(stroke: FogStroke): void {
    const fog = this.ensureActiveFogHistory();

    const lastStroke = fog.strokes[fog.strokes.length - 1];
    const shouldMergeWithLastStroke =
      Boolean(stroke.strokeGroupId) &&
      fog.historyIndex === fog.strokes.length &&
      Boolean(lastStroke) &&
      lastStroke.strokeGroupId === stroke.strokeGroupId;

    if (shouldMergeWithLastStroke && lastStroke) {
      lastStroke.pointsWorld.push(...stroke.pointsWorld);
      lastStroke.timestamp = stroke.timestamp;
    } else {
      if (fog.historyIndex < fog.strokes.length) {
        fog.strokes = fog.strokes.slice(0, fog.historyIndex);
      }

      fog.strokes.push(stroke);
      fog.historyIndex += 1;

      if (fog.strokes.length > MAX_HISTORY_STROKES) {
        const overflow = fog.strokes.length - MAX_HISTORY_STROKES;
        fog.strokes = fog.strokes.slice(overflow);
        fog.historyIndex = Math.max(0, fog.historyIndex - overflow);
        fog.dirtyMask = true;
      }
    }

    if (fog.dirtyMask) {
      this.getMask(fog);
    }

    applyStrokeToMask(
      fog.mask,
      {
        worldWidth: fog.worldWidth,
        worldHeight: fog.worldHeight,
        maskWidth: fog.maskWidth,
        maskHeight: fog.maskHeight
      },
      stroke
    );

    this.queueSave();
  }

  public undo(): boolean {
    const fog = this.ensureActiveFogHistory();
    if (fog.historyIndex <= 0) {
      return false;
    }

    fog.historyIndex -= 1;
    fog.dirtyMask = true;
    this.queueSave();
    return true;
  }

  public redo(): boolean {
    const fog = this.ensureActiveFogHistory();
    if (fog.historyIndex >= fog.strokes.length) {
      return false;
    }

    fog.historyIndex += 1;
    fog.dirtyMask = true;
    this.queueSave();
    return true;
  }

  public getSnapshot(): SessionSnapshot {
    const activeMap = this.getActiveMap();
    const fog = activeMap ? this.ensureFogHistory(activeMap, this.pdfPage) : null;

    const sessionState: SessionState = {
      activeMapId: activeMap?.id ?? null,
      pdfPage: this.pdfPage,
      camera: this.camera,
      cameraSync: this.cameraSync,
      syncLock: this.syncLock,
      fogState: fog ? this.toFogState(fog) : null,
      historyIndex: fog?.historyIndex ?? 0
    };

    return {
      session: sessionState,
      activeMap,
      maps: this.listMaps()
    };
  }

  public async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    await this.saveToDisk();
  }

  private clampPage(asset: MapAsset, requestedPage: number): number {
    const maxPage = Math.max(1, asset.pdfPageCount || 1);
    return Math.max(1, Math.min(maxPage, Math.round(requestedPage)));
  }

  private ensureActiveFogHistory(): FogHistoryState {
    const activeMap = this.getActiveMap();
    if (!activeMap) {
      throw new Error("No active map available");
    }

    return this.ensureFogHistory(activeMap, this.pdfPage);
  }

  private ensureFogHistory(asset: MapAsset, page: number): FogHistoryState {
    const key = mapPageKey(asset.id, page);
    const existing = this.fogByKey.get(key);
    if (existing) {
      return existing;
    }

    const pageMeta = this.getPageMeta(asset, page);
    const adaptive = getAdaptiveMaskSize(pageMeta.width, pageMeta.height, MAX_MASK_SIDE);

    const created: FogHistoryState = {
      worldWidth: pageMeta.width,
      worldHeight: pageMeta.height,
      maskWidth: adaptive.maskWidth,
      maskHeight: adaptive.maskHeight,
      strokes: [],
      historyIndex: 0,
      mask: createEmptyMask(adaptive.maskWidth, adaptive.maskHeight),
      dirtyMask: false
    };

    this.fogByKey.set(key, created);
    return created;
  }

  private getPageMeta(asset: MapAsset, page: number): { width: number; height: number } {
    if (asset.kind === "pdf" && asset.pages && asset.pages[page - 1]) {
      return asset.pages[page - 1];
    }

    return {
      width: asset.width,
      height: asset.height
    };
  }

  private toFogState(fog: FogHistoryState): FogState {
    const mask = this.getMask(fog);
    return {
      worldWidth: fog.worldWidth,
      worldHeight: fog.worldHeight,
      maskWidth: fog.maskWidth,
      maskHeight: fog.maskHeight,
      maskBase64: encodeMask(mask),
      strokeCount: fog.strokes.length,
      historyIndex: fog.historyIndex
    };
  }

  private getMask(fog: FogHistoryState): Uint8ClampedArray {
    if (!fog.dirtyMask) {
      return fog.mask;
    }

    fog.mask = replayStrokes(
      {
        worldWidth: fog.worldWidth,
        worldHeight: fog.worldHeight,
        maskWidth: fog.maskWidth,
        maskHeight: fog.maskHeight
      },
      fog.strokes,
      fog.historyIndex
    );

    fog.dirtyMask = false;
    return fog.mask;
  }

  private queueSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveToDisk().catch((error: unknown) => {
        console.error("[session] Failed to save session:", error);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  private toPersistedState(): PersistedState {
    const fogByKey: Record<string, PersistedFogHistory> = {};

    for (const [key, fog] of this.fogByKey.entries()) {
      fogByKey[key] = {
        worldWidth: fog.worldWidth,
        worldHeight: fog.worldHeight,
        maskWidth: fog.maskWidth,
        maskHeight: fog.maskHeight,
        strokes: fog.strokes,
        historyIndex: fog.historyIndex
      };
    }

    return {
      version: 1,
      maps: this.listMaps(),
      session: {
        activeMapId: this.activeMapId,
        pdfPage: this.pdfPage,
        camera: this.camera,
        cameraSync: this.cameraSync,
        syncLock: this.syncLock
      },
      fogByKey
    };
  }

  private async saveToDisk(): Promise<void> {
    const serialized = JSON.stringify(this.toPersistedState(), null, 2);
    await fs.writeFile(this.sessionFilePath, serialized, "utf8");
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const content = await fs.readFile(this.sessionFilePath, "utf8");
      const parsed = JSON.parse(content) as PersistedState;

      if (parsed.version !== 1) {
        return;
      }

      for (const map of parsed.maps ?? []) {
        this.maps.set(map.id, map);
      }

      this.activeMapId = parsed.session?.activeMapId ?? null;
      this.pdfPage = parsed.session?.pdfPage ?? 1;
      this.camera = parsed.session?.camera ?? this.camera;
      this.cameraSync = parsed.session?.cameraSync ?? this.cameraSync;
      this.syncLock = parsed.session?.syncLock ?? this.syncLock;

      for (const [key, persistedFog] of Object.entries(parsed.fogByKey ?? {})) {
        this.fogByKey.set(key, {
          ...persistedFog,
          mask: createEmptyMask(persistedFog.maskWidth, persistedFog.maskHeight),
          dirtyMask: true
        });
      }

      const activeMap = this.getActiveMap();
      if (activeMap) {
        this.pdfPage = this.clampPage(activeMap, this.pdfPage);
        this.ensureFogHistory(activeMap, this.pdfPage);
      }
    } catch (error: unknown) {
      const errorObject = error as NodeJS.ErrnoException;
      if (errorObject.code !== "ENOENT") {
        console.error("[session] Failed to load persisted session:", error);
      }
    }
  }
}
