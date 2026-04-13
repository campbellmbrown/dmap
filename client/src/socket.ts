import type { ClientRole, ClientToServerMessage, ServerToClientMessage } from "@shared/types";

export interface SocketClient {
  send: (message: ClientToServerMessage) => void;
  close: () => void;
}

interface SocketOptions {
  role: ClientRole;
  roomCode?: string;
  onMessage: (message: ServerToClientMessage) => void;
  onStatus: (connected: boolean) => void;
  onError: (error: string) => void;
}

export function connectSocket(options: SocketOptions): SocketClient {
  let socket: WebSocket | null = null;
  let closedByUser = false;
  let reconnectTimer: number | null = null;
  const queuedMessages: ClientToServerMessage[] = [];
  let queuedCameraMessage: ClientToServerMessage | null = null;
  const MAX_QUEUED_MESSAGES = 400;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";

  const queueMessage = (message: ClientToServerMessage): void => {
    if (message.type === "dm.camera.set") {
      queuedCameraMessage = message;
      return;
    }

    if (queuedMessages.length >= MAX_QUEUED_MESSAGES) {
      queuedMessages.shift();
    }
    queuedMessages.push(message);
  };

  const flushQueue = (): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    while (queuedMessages.length > 0) {
      const nextMessage = queuedMessages.shift();
      if (!nextMessage) {
        break;
      }

      socket.send(JSON.stringify(nextMessage));
    }

    if (queuedCameraMessage) {
      socket.send(JSON.stringify(queuedCameraMessage));
      queuedCameraMessage = null;
    }
  };

  const connect = (): void => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const params = new URLSearchParams();
    params.set("role", options.role);
    if (options.role === "player" && options.roomCode) {
      params.set("roomCode", options.roomCode);
    }

    socket = new WebSocket(`${protocol}://${window.location.host}/ws?${params.toString()}`);

    socket.addEventListener("open", () => {
      options.onStatus(true);
      flushQueue();
    });

    socket.addEventListener("close", (event) => {
      options.onStatus(false);

      if (closedByUser) {
        return;
      }

      if (options.role === "dm" && event.code === 1008) {
        options.onError("DM controls must be opened from localhost (http://localhost:4100/dm).");
        return;
      }

      if (options.role === "player" && event.code === 1008) {
        options.onError("Connection rejected. Check the room code.");
        return;
      }

      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 1_000);
    });

    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data as string) as ServerToClientMessage;
        options.onMessage(payload);
      } catch {
        options.onError("Received an invalid websocket payload.");
      }
    });

    socket.addEventListener("error", () => {
      // Browsers emit opaque websocket error events during reconnects.
      // Connection state is surfaced via onStatus and close handling.
    });
  };

  connect();

  return {
    send(message) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        queueMessage(message);
        return;
      }

      socket.send(JSON.stringify(message));
    },
    close() {
      closedByUser = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    }
  };
}
