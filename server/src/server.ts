import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import QRCode from "qrcode";
import WebSocket, { type RawData } from "ws";

import type {
  BootstrapResponse,
  ClientRole,
  ClientToServerMessage,
  MapAsset,
  ServerToClientMessage,
  SessionPatchRequest
} from "../../shared/src/types";
import { DEFAULT_HOST, DEFAULT_PORT } from "./constants";
import { parseMapMetadata } from "./mapMetadata";
import { getLanAddress, isLoopbackAddress } from "./network";
import { SessionStore } from "./sessionStore";
import { createRoomCode, extensionFromMimeType, sanitizeFileName } from "./utils";

export interface BuildServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  devMode?: boolean;
}

interface ConnectedClient {
  role: ClientRole;
  socket: WebSocket;
}

function parseClientMessage(data: RawData): ClientToServerMessage | null {
  try {
    const jsonText =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data as ArrayBuffer).toString("utf8");

    const parsed = JSON.parse(jsonText) as ClientToServerMessage;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function sendMessage(socket: WebSocket, message: ServerToClientMessage): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(message));
}

function toServerError(message: string): ServerToClientMessage {
  return {
    type: "server.error",
    payload: { message }
  };
}

function inferMimeType(mimeType: string | undefined, fileName: string): string {
  if (mimeType && mimeType !== "application/octet-stream") {
    return mimeType;
  }

  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".pdf") {
    return "application/pdf";
  }

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }

  throw new Error("Unsupported file type. Only PNG, JPG/JPEG, and PDF are supported.");
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const port = options.port ?? DEFAULT_PORT;
  const dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), "data"));
  const mapDir = path.join(dataDir, "maps");
  const cacheDir = path.join(dataDir, "cache");
  const roomCode = createRoomCode();

  await fs.mkdir(mapDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  const sessionStore = new SessionStore(dataDir, roomCode);
  await sessionStore.initialize();

  const app = Fastify({
    logger: true
  });

  const clients = new Set<ConnectedClient>();
  const clientDistDir = path.resolve(process.cwd(), "dist/client");
  const clientIndexPath = path.join(clientDistDir, "index.html");
  const hasBuiltClient = existsSync(clientIndexPath);

  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024
    }
  });

  await app.register(websocket);

  if (hasBuiltClient) {
    await app.register(fastifyStatic, {
      root: clientDistDir,
      serve: false
    });

    await app.register(fastifyStatic, {
      root: path.join(clientDistDir, "assets"),
      prefix: "/assets/",
      decorateReply: false
    });
  }

  function broadcastToAll(message: ServerToClientMessage): void {
    for (const client of clients) {
      sendMessage(client.socket, message);
    }
  }

  function broadcastToPlayers(message: ServerToClientMessage): void {
    for (const client of clients) {
      if (client.role === "player") {
        sendMessage(client.socket, message);
      }
    }
  }

  function publishSnapshot(): void {
    broadcastToAll({
      type: "session.snapshot",
      payload: sessionStore.getSnapshot()
    });
  }

  async function buildBootstrap(requestHostIsLocal: boolean): Promise<BootstrapResponse> {
    const lanAddress = getLanAddress();
    const playerRoomCode = requestHostIsLocal ? sessionStore.getRoomCode() : null;
    const dmUrl = `http://localhost:${port}/dm`;
    const playerBaseUrl = `http://${lanAddress}:${port}/player`;
    const playerUrl = playerRoomCode ? `${playerBaseUrl}?room=${playerRoomCode}` : playerBaseUrl;
    const qrDataUrl = await QRCode.toDataURL(playerUrl, { margin: 1, width: 256 });

    return {
      dmUrl,
      playerUrl,
      roomCode: playerRoomCode,
      qrDataUrl
    };
  }

  function rejectIfNotLocal(requestIp: string, reply: { code: (statusCode: number) => unknown }): boolean {
    if (!isLoopbackAddress(requestIp)) {
      reply.code(403);
      return true;
    }

    return false;
  }

  app.get("/api/bootstrap", async (request) => {
    return buildBootstrap(isLoopbackAddress(request.ip));
  });

  app.get("/api/session", async () => {
    return sessionStore.getSnapshot();
  });

  app.patch<{ Body: SessionPatchRequest }>("/api/session", async (request, reply) => {
    if (rejectIfNotLocal(request.ip, reply)) {
      return { error: "DM route is localhost-only" };
    }

    const patch = request.body ?? {};

    if (Object.prototype.hasOwnProperty.call(patch, "activeMapId")) {
      sessionStore.setActiveMap(patch.activeMapId ?? null, patch.pdfPage ?? 1);
    } else if (typeof patch.pdfPage === "number") {
      sessionStore.setPdfPage(patch.pdfPage);
    }

    if (typeof patch.syncLock === "boolean") {
      sessionStore.setSyncLock(patch.syncLock);
      broadcastToAll({
        type: "dm.syncLock.set",
        payload: { syncLock: patch.syncLock }
      });
      if (patch.syncLock) {
        broadcastToPlayers({
          type: "dm.camera.set",
          payload: { camera: sessionStore.getSnapshot().session.camera }
        });
      }
    }

    publishSnapshot();
    return sessionStore.getSnapshot();
  });

  app.post("/api/maps", async (request, reply) => {
    if (rejectIfNotLocal(request.ip, reply)) {
      return { error: "DM route is localhost-only" };
    }

    const uploadedFile = await request.file();
    if (!uploadedFile) {
      reply.code(400);
      return { error: "Expected a multipart file upload." };
    }

    const safeOriginalName = sanitizeFileName(uploadedFile.filename || "map");
    const mimeType = inferMimeType(uploadedFile.mimetype, safeOriginalName);

    if (!["application/pdf", "image/png", "image/jpeg"].includes(mimeType)) {
      reply.code(400);
      return { error: "Only PNG, JPEG, or PDF files are supported." };
    }

    const mapId = crypto.randomUUID();
    const extension = path.extname(safeOriginalName) || extensionFromMimeType(mimeType);
    const storedFileName = `${mapId}${extension}`;
    const absoluteStoragePath = path.join(mapDir, storedFileName);

    await pipeline(uploadedFile.file, createWriteStream(absoluteStoragePath));

    const parsedMeta = await parseMapMetadata(absoluteStoragePath, mimeType);

    const mapAsset: MapAsset = {
      id: mapId,
      name: safeOriginalName,
      kind: parsedMeta.kind,
      mimeType,
      width: parsedMeta.width,
      height: parsedMeta.height,
      pdfPageCount: parsedMeta.pdfPageCount,
      pages: parsedMeta.pages,
      storagePath: path.join("maps", storedFileName).replaceAll("\\", "/"),
      createdAt: Date.now()
    };

    sessionStore.addMap(mapAsset);
    publishSnapshot();

    return mapAsset;
  });

  app.get<{ Params: { mapId: string } }>("/api/maps/:mapId/file", async (request, reply) => {
    const map = sessionStore.getMapById(request.params.mapId);
    if (!map) {
      reply.code(404);
      return { error: "Map not found" };
    }

    const absolutePath = path.resolve(dataDir, map.storagePath);
    reply.type(map.mimeType);
    return reply.send(createReadStream(absolutePath));
  });

  app.get("/ws", { websocket: true }, (socket, request) => {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const role = url.searchParams.get("role");
    const requestedRoomCode = url.searchParams.get("roomCode");

    if (role !== "dm" && role !== "player") {
      socket.close(1008, "Unknown role");
      return;
    }

    if (role === "dm" && !isLoopbackAddress(request.ip)) {
      socket.close(1008, "DM websocket is localhost-only");
      return;
    }

    if (role === "player" && requestedRoomCode !== sessionStore.getRoomCode()) {
      socket.close(1008, "Invalid room code");
      return;
    }

    const client: ConnectedClient = {
      role,
      socket
    };
    clients.add(client);

    sendMessage(socket, {
      type: "session.snapshot",
      payload: sessionStore.getSnapshot()
    });

    socket.on("message", (raw: RawData) => {
      if (role !== "dm") {
        sendMessage(socket, toServerError("Player role is read-only."));
        return;
      }

      const message = parseClientMessage(raw);
      if (!message) {
        sendMessage(socket, toServerError("Invalid message payload."));
        return;
      }

      try {
        switch (message.type) {
          case "dm.camera.set": {
            if (!sessionStore.getSnapshot().session.syncLock) {
              break;
            }

            sessionStore.setCamera(message.payload.camera);
            broadcastToPlayers({
              type: "dm.camera.set",
              payload: { camera: message.payload.camera }
            });
            break;
          }

          case "dm.syncLock.set": {
            sessionStore.setSyncLock(message.payload.syncLock);
            broadcastToAll({
              type: "dm.syncLock.set",
              payload: { syncLock: message.payload.syncLock }
            });

            if (message.payload.syncLock && message.payload.camera) {
              sessionStore.setCamera(message.payload.camera);
              broadcastToPlayers({
                type: "dm.camera.set",
                payload: { camera: message.payload.camera }
              });
            }

            publishSnapshot();
            break;
          }

          case "dm.fog.stroke": {
            sessionStore.applyStroke(message.payload.stroke);
            broadcastToPlayers({
              type: "dm.fog.stroke",
              payload: { stroke: message.payload.stroke }
            });
            break;
          }

          case "dm.history.undo": {
            if (sessionStore.undo()) {
              publishSnapshot();
            }
            break;
          }

          case "dm.history.redo": {
            if (sessionStore.redo()) {
              publishSnapshot();
            }
            break;
          }

          default: {
            sendMessage(socket, toServerError("Unsupported DM message type."));
          }
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : "Unexpected server error";
        sendMessage(socket, toServerError(errorMessage));
      }
    });

    socket.on("close", () => {
      clients.delete(client);
    });
  });

  app.get("/", async (request, reply) => {
    if (isLoopbackAddress(request.ip)) {
      return reply.redirect("/dm");
    }

    return reply.redirect("/player");
  });

  app.get("/dm", async (request, reply) => {
    if (rejectIfNotLocal(request.ip, reply)) {
      return { error: "DM route is localhost-only" };
    }

    if (hasBuiltClient) {
      return reply.sendFile("index.html");
    }

    return reply
      .code(503)
      .type("text/plain")
      .send("Client build not found. Run `npm run build` or use `npm run dev`.");
  });

  app.get("/player", async (_request, reply) => {
    if (hasBuiltClient) {
      return reply.sendFile("index.html");
    }

    return reply
      .code(503)
      .type("text/plain")
      .send("Client build not found. Run `npm run build` or use `npm run dev`.");
  });

  app.addHook("onClose", async () => {
    await sessionStore.flush();
  });

  return app;
}

export async function startServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = await buildServer(options);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;

  await app.listen({ port, host });
  return app;
}
