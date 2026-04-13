export type ClientRole = "dm" | "player";
export type MapKind = "image" | "pdf";
export type BrushShape = "round" | "square";
export type BrushMode = "reveal" | "refog";

export interface Point {
  x: number;
  y: number;
}

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export interface CameraSyncMeta {
  centerWorldX: number;
  centerWorldY: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface BrushConfig {
  shape: BrushShape;
  sizePx: number;
  hardness: number;
  mode: BrushMode;
}

export interface FogStroke {
  brush: BrushConfig;
  pointsWorld: Point[];
  timestamp: number;
  strokeGroupId?: string;
}

export interface MapPageMeta {
  width: number;
  height: number;
}

export interface MapAsset {
  id: string;
  name: string;
  kind: MapKind;
  mimeType: string;
  width: number;
  height: number;
  pdfPageCount: number;
  pages?: MapPageMeta[];
  storagePath: string;
  createdAt: number;
}

export interface FogState {
  worldWidth: number;
  worldHeight: number;
  maskWidth: number;
  maskHeight: number;
  maskBase64: string;
  strokeCount: number;
  historyIndex: number;
}

export interface SessionState {
  activeMapId: string | null;
  pdfPage: number;
  camera: CameraState;
  cameraSync: CameraSyncMeta | null;
  syncLock: boolean;
  fogState: FogState | null;
  historyIndex: number;
}

export interface SessionSnapshot {
  session: SessionState;
  activeMap: MapAsset | null;
  maps: MapAsset[];
}

export interface BootstrapResponse {
  dmUrl: string;
  playerUrl: string;
  roomCode: string | null;
  qrDataUrl: string;
}

export interface ServerErrorPayload {
  message: string;
}

export interface WsEnvelope<TType extends string, TPayload> {
  type: TType;
  payload: TPayload;
}

export type ServerToClientMessage =
  | WsEnvelope<"session.snapshot", SessionSnapshot>
  | WsEnvelope<"dm.camera.set", { camera: CameraState; cameraSync?: CameraSyncMeta | null }>
  | WsEnvelope<"dm.syncLock.set", { syncLock: boolean }>
  | WsEnvelope<"dm.fog.stroke", { stroke: FogStroke }>
  | WsEnvelope<"server.error", ServerErrorPayload>;

export type ClientToServerMessage =
  | WsEnvelope<"dm.camera.set", { camera: CameraState; cameraSync?: CameraSyncMeta | null }>
  | WsEnvelope<"dm.syncLock.set", { syncLock: boolean; camera?: CameraState; cameraSync?: CameraSyncMeta | null }>
  | WsEnvelope<"dm.fog.stroke", { stroke: FogStroke }>
  | WsEnvelope<"dm.history.undo", Record<string, never>>
  | WsEnvelope<"dm.history.redo", Record<string, never>>;

export interface SessionPatchRequest {
  activeMapId?: string | null;
  pdfPage?: number;
  syncLock?: boolean;
}
