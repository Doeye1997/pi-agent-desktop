type ControlListener = (message: unknown) => void;

let broadcastMessage: (message: unknown) => void = () => undefined;
let sendMessageToMain: (message: unknown, timeoutMs?: number) => Promise<void> = async () => {
  throw new Error("Electron Main is unavailable");
};
const listeners = new Set<ControlListener>();

export class ElectronMainUnavailableError extends Error {
  readonly code = "ELECTRON_MAIN_UNAVAILABLE";
  readonly retryable = true;
  readonly details: { waitedMs: number };

  constructor(waitedMs: number) {
    super(`Electron Main did not reconnect within ${waitedMs}ms`);
    this.name = "ElectronMainUnavailableError";
    this.details = { waitedMs };
  }
}

export function configureHostControl(options: {
  broadcast: (message: unknown) => void;
  sendToMain: (message: unknown, timeoutMs?: number) => Promise<void>;
}): void {
  broadcastMessage = options.broadcast;
  sendMessageToMain = options.sendToMain;
}

export function postHostMessage(message: unknown): void {
  broadcastMessage(message);
}

export function sendHostMessageToMain(message: unknown, timeoutMs?: number): Promise<void> {
  return sendMessageToMain(message, timeoutMs);
}

export function receiveMainControlMessage(message: unknown): void {
  for (const listener of listeners) listener(message);
}

export function subscribeMainControlMessages(listener: ControlListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
