import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { buildServer } from "../../server/src/server";
import type { ServerToClientMessage } from "../../shared/src/types";

interface StartedServer {
  app: Awaited<ReturnType<typeof buildServer>>;
  baseUrl: string;
  dataDir: string;
}

const startedServers: StartedServer[] = [];

async function startTestServer(): Promise<StartedServer> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "dmap-int-"));
  const app = await buildServer({ port: 0, host: "127.0.0.1", dataDir });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine test server address");
  }

  const started = {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir
  };

  startedServers.push(started);
  return started;
}

async function waitForMessage(socket: WebSocket, expectedType: string): Promise<ServerToClientMessage> {
  return new Promise<ServerToClientMessage>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${expectedType}`));
    }, 5_000);

    const onMessage = (raw: WebSocket.RawData): void => {
      const parsed = JSON.parse(raw.toString()) as ServerToClientMessage;
      if (parsed.type !== expectedType) {
        return;
      }

      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(parsed);
    };

    socket.on("message", onMessage);
  });
}

async function waitForNoMessage(socket: WebSocket, forbiddenType: string, waitMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      resolve();
    }, waitMs);

    const onMessage = (raw: WebSocket.RawData): void => {
      const parsed = JSON.parse(raw.toString()) as ServerToClientMessage;
      if (parsed.type !== forbiddenType) {
        return;
      }

      clearTimeout(timer);
      socket.off("message", onMessage);
      reject(new Error(`Unexpected message type: ${forbiddenType}`));
    };

    socket.on("message", onMessage);
  });
}

afterEach(async () => {
  await Promise.all(
    startedServers.splice(0).map(async ({ app, dataDir }) => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    })
  );
});

describe("server integration", () => {
  it("rejects non-loopback DM route", async () => {
    const { app } = await startTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/dm",
      remoteAddress: "10.0.0.5"
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects player websocket with invalid room code", async () => {
    const { baseUrl } = await startTestServer();
    const wsUrl = baseUrl.replace("http", "ws");

    const socket = new WebSocket(`${wsUrl}/ws?role=player&roomCode=WRONG1`);
    const [code] = (await once(socket, "close")) as [number];

    expect(code).toBe(1008);
  });

  it(
    "fans out camera updates from DM to player",
    async () => {
      const { baseUrl } = await startTestServer();

    const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
    const bootstrapPayload = (await bootstrapResponse.json()) as { roomCode: string };

    const wsBase = baseUrl.replace("http", "ws");
    const dmSocket = new WebSocket(`${wsBase}/ws?role=dm`);
    const playerSocket = new WebSocket(`${wsBase}/ws?role=player&roomCode=${bootstrapPayload.roomCode}`);

    await once(dmSocket, "open");
    await once(playerSocket, "open");

    const cameraPromise = waitForMessage(playerSocket, "dm.camera.set");

    dmSocket.send(
      JSON.stringify({
        type: "dm.camera.set",
        payload: {
          camera: {
            x: 25,
            y: 30,
            zoom: 1.4
          }
        }
      })
    );

    const cameraMessage = await cameraPromise;

    expect(cameraMessage.type).toBe("dm.camera.set");
    if (cameraMessage.type === "dm.camera.set") {
      expect(cameraMessage.payload.camera).toEqual({ x: 25, y: 30, zoom: 1.4 });
    }

    dmSocket.close();
    playerSocket.close();
    },
    12_000
  );

  it(
    "does not fan out DM camera updates when sync lock is disabled",
    async () => {
      const { baseUrl } = await startTestServer();

      const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
      const bootstrapPayload = (await bootstrapResponse.json()) as { roomCode: string };

      const wsBase = baseUrl.replace("http", "ws");
      const dmSocket = new WebSocket(`${wsBase}/ws?role=dm`);
      const playerSocket = new WebSocket(`${wsBase}/ws?role=player&roomCode=${bootstrapPayload.roomCode}`);

      await once(dmSocket, "open");
      await once(playerSocket, "open");

      dmSocket.send(
        JSON.stringify({
          type: "dm.syncLock.set",
          payload: {
            syncLock: false
          }
        })
      );

      await waitForMessage(playerSocket, "dm.syncLock.set");

      const noCameraMessagePromise = waitForNoMessage(playerSocket, "dm.camera.set", 400);

      dmSocket.send(
        JSON.stringify({
          type: "dm.camera.set",
          payload: {
            camera: { x: 150, y: 120, zoom: 1.8 }
          }
        })
      );

      await noCameraMessagePromise;

      dmSocket.close();
      playerSocket.close();
    },
    12_000
  );
});
