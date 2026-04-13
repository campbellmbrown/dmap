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

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";

  const connect = (): void => {
    const params = new URLSearchParams();
    params.set("role", options.role);
    if (options.role === "player" && options.roomCode) {
      params.set("roomCode", options.roomCode);
    }

    socket = new WebSocket(`${protocol}://${window.location.host}/ws?${params.toString()}`);

    socket.addEventListener("open", () => {
      options.onStatus(true);
    });

    socket.addEventListener("close", (event) => {
      options.onStatus(false);

      if (closedByUser) {
        return;
      }

      if (options.role === "player" && event.code === 1008) {
        options.onError("Connection rejected. Check the room code.");
        return;
      }

      reconnectTimer = window.setTimeout(connect, 1_000);
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
      options.onError("Websocket error");
    });
  };

  connect();

  return {
    send(message) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
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
