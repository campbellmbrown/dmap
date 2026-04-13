import { DEFAULT_HOST, DEFAULT_PORT } from "./constants";
import { getLanAddress } from "./network";
import { startServer } from "./server";

function readArgValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) {
    return null;
  }

  return process.argv[index + 1];
}

function parseNumber(raw: string | null, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function printStartupInfo(port: number): Promise<void> {
  const lanAddress = getLanAddress();
  const dmUrl = `http://localhost:${port}/dm`;
  const bootstrapUrl = `http://localhost:${port}/api/bootstrap`;

  const bootstrapResponse = await fetch(bootstrapUrl);
  const bootstrapPayload = (await bootstrapResponse.json()) as { playerUrl: string };

  console.log("");
  console.log("DnD Map Viewer running");
  console.log(`DM URL:      ${dmUrl}`);
  console.log(`Player URL:  ${bootstrapPayload.playerUrl}`);
  console.log(`LAN address: ${lanAddress}`);
}

async function main(): Promise<void> {
  const isDevMode = process.argv.includes("--dev");
  const port = parseNumber(readArgValue("--port") ?? process.env.PORT ?? null, DEFAULT_PORT);
  const host = readArgValue("--host") ?? process.env.HOST ?? DEFAULT_HOST;

  const app = await startServer({ port, host, devMode: isDevMode });

  await printStartupInfo(port);

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
