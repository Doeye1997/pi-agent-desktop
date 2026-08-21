import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

type WatchListener = (eventType: string, filename: string | Buffer | null) => void;
type WatchOptions = { encoding?: BufferEncoding | "buffer"; persistent?: boolean; recursive?: boolean; signal?: AbortSignal };

type PathSnapshot =
  | { kind: "file"; signature: string }
  | { kind: "directory"; entries: Map<string, string> };

function statSignature(filePath: string): string {
  const stat = fs.statSync(filePath);
  return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.mode}`;
}

function snapshotPath(filePath: string): PathSnapshot {
  const stat = fs.statSync(filePath);
  if (!stat.isDirectory()) return { kind: "file", signature: statSignature(filePath) };
  const entries = new Map<string, string>();
  for (const name of fs.readdirSync(filePath)) {
    try {
      entries.set(name, statSignature(path.join(filePath, name)));
    } catch {
      // The entry changed between readdir and stat; the next poll will report it.
    }
  }
  return { kind: "directory", entries };
}

class PollingFsWatcher extends EventEmitter {
  private closed = false;
  private snapshot: PathSnapshot;
  private readonly timer: NodeJS.Timeout;
  private readonly abortHandler: (() => void) | undefined;

  constructor(
    private readonly filePath: string,
    listener: WatchListener | undefined,
    options: WatchOptions,
    intervalMs: number,
  ) {
    super();
    this.snapshot = snapshotPath(filePath);
    if (listener) this.on("change", listener);
    this.timer = setInterval(() => this.poll(), intervalMs);
    if (options.persistent === false) this.timer.unref();
    if (options.signal) {
      this.abortHandler = () => this.close();
      options.signal.addEventListener("abort", this.abortHandler, { once: true });
      if (options.signal.aborted) this.close();
    }
  }

  private poll(): void {
    if (this.closed) return;
    let next: PathSnapshot;
    try {
      next = snapshotPath(this.filePath);
    } catch (error) {
      this.emit("error", error);
      return;
    }
    if (this.snapshot.kind === "file" && next.kind === "file") {
      if (this.snapshot.signature !== next.signature) this.emit("change", "change", path.basename(this.filePath));
    } else if (this.snapshot.kind === "directory" && next.kind === "directory") {
      const names = new Set([...this.snapshot.entries.keys(), ...next.entries.keys()]);
      for (const name of names) {
        const previous = this.snapshot.entries.get(name);
        const current = next.entries.get(name);
        if (previous === current) continue;
        this.emit("change", previous === undefined || current === undefined ? "rename" : "change", name);
      }
    } else {
      this.emit("change", "rename", path.basename(this.filePath));
    }
    this.snapshot = next;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.emit("close");
  }

  ref(): this {
    this.timer.ref();
    return this;
  }

  unref(): this {
    this.timer.unref();
    return this;
  }
}

export function installWindowsSafeWatch(options: {
  platform?: NodeJS.Platform;
  intervalMs?: number;
} = {}): () => void {
  if ((options.platform ?? process.platform) !== "win32") return () => undefined;
  const originalWatch = fs.watch;
  const intervalMs = options.intervalMs ?? 500;
  const replacement = ((
    filePath: fs.PathLike,
    watchOptionsOrListener?: WatchOptions | WatchListener,
    maybeListener?: WatchListener,
  ) => {
    const watchOptions = typeof watchOptionsOrListener === "function" ? {} : (watchOptionsOrListener ?? {});
    const listener = typeof watchOptionsOrListener === "function" ? watchOptionsOrListener : maybeListener;
    return new PollingFsWatcher(path.resolve(filePath.toString()), listener, watchOptions, intervalMs) as fs.FSWatcher;
  }) as typeof fs.watch;
  fs.watch = replacement;
  syncBuiltinESMExports();
  return () => {
    if (fs.watch !== replacement) return;
    fs.watch = originalWatch;
    syncBuiltinESMExports();
  };
}
