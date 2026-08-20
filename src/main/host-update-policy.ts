import type { HostStatus } from "./host-manager";

export function updateBlockingSessionCount(status: HostStatus, knownRunningCount: number): number {
  if (status === "ready") return Math.max(0, knownRunningCount);
  return Math.max(1, knownRunningCount);
}

export function assertHostReadyForUpdate(status: HostStatus | undefined): void {
  if (status !== "ready") {
    throw new Error("Agent Host must be connected before installing an update");
  }
}
