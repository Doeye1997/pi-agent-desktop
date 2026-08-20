import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  HOST_DISCOVERY_FILE,
  JsonLinePeer,
  STANDALONE_HOST_PROTOCOL_VERSION,
  WireMessagePort,
  type HostDiscoveryRecord,
  type HostWireMessage,
} from "../shared/standalone-host-wire.ts";

export interface StandaloneHostConnection {
  readonly pid: number;
  readonly hostVersion: string;
  readonly piVersion: string | null;
  createChannel(): WireMessagePort;
  sendControl(data: unknown): void;
  onControl(listener: (data: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export function readHostDiscovery(userDataDirectory: string): HostDiscoveryRecord | null {
  try {
    const value = JSON.parse(
      readFileSync(path.join(userDataDirectory, HOST_DISCOVERY_FILE), "utf8"),
    ) as Partial<HostDiscoveryRecord>;
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0) return null;
    if (!Number.isInteger(value.port) || Number(value.port) <= 0) return null;
    if (typeof value.token !== "string" || value.token.length < 16) return null;
    if (!Number.isInteger(value.protocolVersion)) return null;
    if (typeof value.hostVersion !== "string") return null;
    if (typeof value.startedAt !== "string") return null;
    return value as HostDiscoveryRecord;
  } catch {
    return null;
  }
}

export function connectStandaloneHost(
  userDataDirectory: string,
  options: {
    clientVersion?: string;
    protocolVersion?: number;
    timeoutMs?: number;
  } = {},
): Promise<StandaloneHostConnection> {
  const discovery = readHostDiscovery(userDataDirectory);
  if (!discovery) return Promise.reject(new Error("Agent Host discovery is unavailable"));
  const protocolVersion = options.protocolVersion ?? STANDALONE_HOST_PROTOCOL_VERSION;
  const timeoutMs = options.timeoutMs ?? 5_000;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: discovery.port });
    const peer = new JsonLinePeer(socket);
    const channels = new Map<string, WireMessagePort>();
    const controlListeners = new Set<(data: unknown) => void>();
    const closeListeners = new Set<() => void>();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      peer.close();
      reject(new Error("Agent Host connection timed out"));
    }, timeoutMs);

    const cleanupHandshake = () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanupHandshake();
      reject(error);
    };
    socket.once("error", onError);

    peer.onMessage((message) => {
      if (!settled) {
        if (message.type === "rejected") {
          settled = true;
          cleanupHandshake();
          peer.close();
          const error = new Error(message.message) as Error & { code?: string; hostProtocolVersion?: number };
          error.code = message.code;
          error.hostProtocolVersion = message.hostProtocolVersion;
          reject(error);
          return;
        }
        if (message.type !== "ready") return;
        settled = true;
        cleanupHandshake();
        resolve({
          pid: message.pid,
          hostVersion: message.hostVersion,
          piVersion: typeof message.piVersion === "string" ? message.piVersion : null,
          createChannel() {
            const channelId = randomUUID();
            const port = new WireMessagePort(
              channelId,
              (wireMessage) => peer.send(wireMessage),
              () => {
                channels.delete(channelId);
              },
            );
            channels.set(channelId, port);
            return port;
          },
          sendControl(data) {
            peer.send({ type: "control", data });
          },
          onControl(listener) {
            controlListeners.add(listener);
            return () => controlListeners.delete(listener);
          },
          onClose(listener) {
            closeListeners.add(listener);
            return () => closeListeners.delete(listener);
          },
          close() {
            for (const port of channels.values()) port.remoteClose();
            channels.clear();
            peer.close();
          },
        });
        return;
      }
      if (message.type === "channel") channels.get(message.channelId)?.receive(message.data);
      if (message.type === "channel-close") channels.get(message.channelId)?.remoteClose();
      if (message.type === "control") {
        for (const listener of controlListeners) listener(message.data);
      }
    });
    peer.onClose(() => {
      for (const port of channels.values()) port.remoteClose();
      channels.clear();
      for (const listener of closeListeners) listener();
      controlListeners.clear();
      closeListeners.clear();
      if (!settled) onError(new Error("Agent Host connection closed during handshake"));
    });
    socket.once("connect", () => {
      const hello: HostWireMessage = {
        type: "hello",
        token: discovery.token,
        protocolVersion,
        clientVersion: options.clientVersion ?? "test",
      };
      peer.send(hello);
    });
  });
}
