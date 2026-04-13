import path from "node:path";

import { expect, test } from "@playwright/test";

test("dm and player pages connect and map upload updates session", async ({ page, context, request }) => {
  const bootstrapResponse = await request.get("/api/bootstrap");
  const bootstrapPayload = (await bootstrapResponse.json()) as { roomCode: string };

  const playerPage = await context.newPage();
  await playerPage.goto(`/player?room=${bootstrapPayload.roomCode}`);

  await page.goto("/dm");

  await expect(page.getByRole("heading", { name: "DM Controls" })).toBeVisible();
  await expect(playerPage.locator("canvas.map-canvas")).toBeVisible();

  const uploadInput = page.locator("input[type='file']");
  await uploadInput.setInputFiles(path.resolve("e2e/assets/test-map.png"));

  await expect(page.getByText(/Map:/)).toBeVisible();

  const sessionResponse = await request.get("/api/session");
  const sessionPayload = (await sessionResponse.json()) as { session: { activeMapId: string | null } };

  expect(sessionPayload.session.activeMapId).not.toBeNull();
});
