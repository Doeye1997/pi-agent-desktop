import { randomUUID } from "node:crypto";
import type { BrowserErrorCode, BrowserRecovery } from "../contract/browser.ts";
import { ElectronMainUnavailableError, sendHostMessageToMain, subscribeMainControlMessages } from "./host-control.ts";

type ParentRpcError = {
  message: string;
  code?: BrowserErrorCode;
  retryable?: boolean;
  recovery?: BrowserRecovery;
  details?: Record<string, unknown>;
};
type ParentRpcResult = { type: "host-rpc-result"; id: string; ok: boolean; result?: unknown; error?: ParentRpcError };
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  timeoutMs: number;
};

const pending = new Map<string, Pending>();
let installed = false;

export class MainProcessRpcError extends Error {
  readonly code?: BrowserErrorCode;
  readonly retryable: boolean;
  readonly recovery?: BrowserRecovery;
  readonly details?: Record<string, unknown>;

  constructor(value: ParentRpcError) {
    const recovery = value.recovery
      ? ` Recovery: ${value.recovery.remediation}; reason=${value.recovery.reason}; retryable=${value.recovery.retryable}.`
      : "";
    super(value.code ? `${value.code}: ${value.message}.${recovery}` : value.message);
    this.name = "MainProcessRpcError";
    this.code = value.code;
    this.retryable = value.retryable === true;
    this.recovery = value.recovery ? structuredClone(value.recovery) : undefined;
    this.details = value.details ? structuredClone(value.details) : undefined;
  }
}

function installListener(): void {
  if (installed) return;
  installed = true;
  subscribeMainControlMessages((value) => {
    const message = value as ParentRpcResult | { type: "main-disconnected" };
    if (message?.type === "main-disconnected") {
      for (const [id, request] of pending) {
        if (request.timer) clearTimeout(request.timer);
        request.timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          request.reject(new ElectronMainUnavailableError(request.timeoutMs));
        }, request.timeoutMs);
      }
      return;
    }
    if (message?.type !== "host-rpc-result") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (request.timer) clearTimeout(request.timer);
    if (message.ok) request.resolve(message.result);
    else request.reject(new MainProcessRpcError(message.error ?? { message: "Main process request failed" }));
  });
}

export function callMain<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
  installListener();
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeoutMs });
    void sendHostMessageToMain({ type: "host-rpc", id, method, params }, timeoutMs).then(
      () => {
        const request = pending.get(id);
        if (!request) return;
        request.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Main process request timed out: ${method}`));
        }, timeoutMs);
      },
      (error) => {
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        if (request.timer) clearTimeout(request.timer);
        reject(error);
      },
    );
  });
}
