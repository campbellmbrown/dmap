import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../../server/src/sessionStore";
import type { FogStroke, MapAsset } from "../../shared/src/types";

const tempDirs: string[] = [];

async function createStore(): Promise<SessionStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dmap-test-"));
  tempDirs.push(directory);

  const store = new SessionStore(directory);
  await store.initialize();
  return store;
}

function buildMapAsset(): MapAsset {
  return {
    id: "map-1",
    name: "test-map.png",
    kind: "image",
    mimeType: "image/png",
    width: 200,
    height: 100,
    pdfPageCount: 1,
    pages: [{ width: 200, height: 100 }],
    storagePath: "maps/test-map.png",
    createdAt: Date.now()
  };
}

function buildStroke(): FogStroke {
  return {
    brush: {
      shape: "round",
      sizePx: 30,
      hardness: 0.8,
      mode: "reveal"
    },
    pointsWorld: [{ x: 100, y: 50 }],
    timestamp: Date.now()
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SessionStore", () => {
  it("supports undo and redo transitions", async () => {
    const store = await createStore();
    store.addMap(buildMapAsset());

    store.applyStroke(buildStroke());
    expect(store.getSnapshot().session.historyIndex).toBe(1);

    expect(store.undo()).toBe(true);
    expect(store.getSnapshot().session.historyIndex).toBe(0);

    expect(store.redo()).toBe(true);
    expect(store.getSnapshot().session.historyIndex).toBe(1);
  });

  it("persists and reloads session state", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dmap-persist-"));
    tempDirs.push(directory);

    const firstStore = new SessionStore(directory, "ABC123");
    await firstStore.initialize();
    firstStore.addMap(buildMapAsset());
    firstStore.setSyncLock(false);
    firstStore.applyStroke(buildStroke());
    await firstStore.flush();

    const reloadedStore = new SessionStore(directory, "XYZ999");
    await reloadedStore.initialize();

    const snapshot = reloadedStore.getSnapshot();

    expect(snapshot.activeMap?.id).toBe("map-1");
    expect(snapshot.session.syncLock).toBe(false);
    expect(snapshot.session.historyIndex).toBe(1);
    expect(snapshot.session.fogState?.strokeCount).toBe(1);
  });
});
