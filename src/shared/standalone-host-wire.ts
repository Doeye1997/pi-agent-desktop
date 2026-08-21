import type { Socket } from "node:net";

export const STANDALONE_HOST_PROTOCOL_VERSION = 1;
export const HOST_DISCOVERY_FILE = "agent-host.json";
export const HOST_LOCK_FILE = "agent-host.lock";

export interface HostDiscoveryRecord {
  pid: number;
  port: number;
  token: string;
  protocolVersion: number;
  hostVersion: string;
  startedAt: string;
  generation?: number;
  ownerToken?: string;
  processStartedAt?: string;
}

export type HostWireMessage =
  | {
      type: "hello";
      token: string;
      protocolVersion: number;
      clientVersion: string;
      expectedGeneration?: number;
      expectedOwnerToken?: string;
    }
  | {
      type: "ready";
      pid: number;
      protocolVersion: number;
      hostVersion: string;
      piVersion?: string;
      generation?: number;
      ownerToken?: string;
      processStartedAt?: string;
    }
  | {
      type: "rejected";
      code: "AUTH_FAILED" | "PROTOCOL_MISMATCH" | "IDENTITY_MISMATCH";
      message: string;
      hostProtocolVersion?: number;
    }
  | {
      type: "channel";
      channelId: string;
      data: unknown;
    }
  | {
      type: "channel-close";
      channelId: string;
    }
  | {
      type: "control";
      data: unknown;
    };

export class JsonLinePeer {
  private readonly socket: Socket;
  private buffer = "";
  private readonly messageListeners = new Set<(message: HostWireMessage) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      for (const listener of this.closeListeners) listener();
    });
  }

  send(message: HostWireMessage): void {
    if (this.socket.destroyed) return;
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    this.socket.destroy();
  }

  onMessage(listener: (message: HostWireMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let message: HostWireMessage;
      try {
        message = JSON.parse(line) as HostWireMessage;
      } catch {
        this.close();
        return;
      }
      for (const listener of this.messageListeners) listener(message);
    }
  }
}

type PortListener = (value: unknown) => void;
type DomPortListener = (event: { data: unknown }) => void;

export class WireMessagePort {
  private readonly channelId: string;
  private readonly sendWireMessage: (message: HostWireMessage) => void;
  private readonly onLocalClose?: () => void;
  private readonly messageListeners = new Set<PortListener>();
  private readonly domMessageListeners = new Set<DomPortListener>();
  private readonly closeListeners = new Set<PortListener>();
  private closed = false;

  constructor(channelId: string, sendWireMessage: (message: HostWireMessage) => void, onLocalClose?: () => void) {
    this.channelId = channelId;
    this.sendWireMessage = sendWireMessage;
    this.onLocalClose = onLocalClose;
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    this.sendWireMessage({ type: "channel", channelId: this.channelId, data });
  }

  start(): void {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sendWireMessage({ type: "channel-close", channelId: this.channelId });
    this.onLocalClose?.();
    this.emitClose();
  }

  on(event: string, listener: PortListener): void {
    if (event === "message") this.messageListeners.add(listener);
    else this.closeListeners.add(listener);
  }

  addEventListener(event: string, listener: DomPortListener): void {
    if (event === "message") this.domMessageListeners.add(listener);
    else if (event === "close") this.closeListeners.add(listener as PortListener);
  }

  removeEventListener(event: string, listener: DomPortListener): void {
    if (event === "message") this.domMessageListeners.delete(listener);
    else if (event === "close") this.closeListeners.delete(listener as PortListener);
  }

  off(event: string, listener: PortListener): void {
    if (event === "message") this.messageListeners.delete(listener);
    else this.closeListeners.delete(listener);
  }

  receive(data: unknown): void {
    if (this.closed) return;
    for (const listener of this.messageListeners) listener(data);
    for (const listener of this.domMessageListeners) listener({ data });
  }

  remoteClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onLocalClose?.();
    this.emitClose();
  }

  private emitClose(): void {
    for (const listener of this.closeListeners) listener(undefined);
    this.messageListeners.clear();
    this.domMessageListeners.clear();
    this.closeListeners.clear();
  }
}
