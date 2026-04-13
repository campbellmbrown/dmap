import type { BootstrapResponse, MapAsset, SessionPatchRequest, SessionSnapshot } from "@shared/types";

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const fallbackMessage = `Request failed with status ${response.status}`;

    try {
      const body = (await response.json()) as { error?: string };
      throw new Error(body.error ?? fallbackMessage);
    } catch {
      throw new Error(fallbackMessage);
    }
  }

  return (await response.json()) as T;
}

export async function fetchBootstrap(): Promise<BootstrapResponse> {
  const response = await fetch("/api/bootstrap");
  return parseJson<BootstrapResponse>(response);
}

export async function fetchSession(): Promise<SessionSnapshot> {
  const response = await fetch("/api/session");
  return parseJson<SessionSnapshot>(response);
}

export async function patchSession(patch: SessionPatchRequest): Promise<SessionSnapshot> {
  const response = await fetch("/api/session", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(patch)
  });

  return parseJson<SessionSnapshot>(response);
}

export async function uploadMap(file: File): Promise<MapAsset> {
  const form = new FormData();
  form.append("file", file);

  const response = await fetch("/api/maps", {
    method: "POST",
    body: form
  });

  return parseJson<MapAsset>(response);
}

export function mapFileUrl(mapId: string): string {
  return `/api/maps/${mapId}/file`;
}
