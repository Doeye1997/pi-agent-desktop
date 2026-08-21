import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const RUNTIME_REGISTRY_FILE = "runtime-registry.json";
export const RUNTIME_LOCK_FILE = "runtime-registry.lock";
export const RUNTIME_GENERATION_FILE = "runtime-generation";
export const LEGACY_HOST_DISCOVERY_FILE = "agent-host.json";
export const LEGACY_HOST_LOCK_FILE = "agent-host.lock";
export const RUNTIME_REGISTRY_SCHEMA_VERSION = 1;
export const DEFAULT_RUNTIME_LEASE_MS = 15_000;

export type SessionRuntimeState =
  | "starting"
  | "running-attached"
  | "running-detached"
  | "stopping"
  | "exited"
  | "orphaned";

export interface RuntimeOwnerIdentity {
  pid: number;
  generation: number;
  ownerToken: string;
  processStartedAt: string;
}

export interface RuntimeRegistryRecord {
  schemaVersion: 1;
  owner: RuntimeOwnerIdentity;
  endpoint: {
    port: number;
    token: string;
  };
  protocolVersion: number;
  hostVersion: string;
  lease: {
    renewedAt: string;
    expiresAt: string;
  };
  sessions: Record<string, SessionRuntimeState>;
}

export interface RuntimeRegistryWrite {
  owner: RuntimeOwnerIdentity;
  endpoint: RuntimeRegistryRecord["endpoint"];
  protocolVersion: number;
  hostVersion: string;
  sessions: Record<string, SessionRuntimeState>;
}

function validPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validSessionState(value: unknown): value is SessionRuntimeState {
  return (
    value === "starting" ||
    value === "running-attached" ||
    value === "running-detached" ||
    value === "stopping" ||
    value === "exited" ||
    value === "orphaned"
  );
}

function parseRuntimeRegistry(value: unknown): RuntimeRegistryRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<RuntimeRegistryRecord>;
  if (record.schemaVersion !== RUNTIME_REGISTRY_SCHEMA_VERSION) return null;
  if (!record.owner || typeof record.owner !== "object") return null;
  if (!validPositiveInteger(record.owner.pid)) return null;
  if (!validPositiveInteger(record.owner.generation)) return null;
  if (typeof record.owner.ownerToken !== "string" || record.owner.ownerToken.length < 16) return null;
  if (!validTimestamp(record.owner.processStartedAt)) return null;
  if (!record.endpoint || typeof record.endpoint !== "object") return null;
  if (!validPositiveInteger(record.endpoint.port)) return null;
  if (typeof record.endpoint.token !== "string" || record.endpoint.token.length < 16) return null;
  if (!validPositiveInteger(record.protocolVersion)) return null;
  if (typeof record.hostVersion !== "string") return null;
  if (!record.lease || typeof record.lease !== "object") return null;
  if (!validTimestamp(record.lease.renewedAt) || !validTimestamp(record.lease.expiresAt)) return null;
  if (!record.sessions || typeof record.sessions !== "object" || Array.isArray(record.sessions)) return null;
  for (const [sessionId, state] of Object.entries(record.sessions)) {
    if (!sessionId || !validSessionState(state)) return null;
  }
  return record as RuntimeRegistryRecord;
}

export function runtimeOwnerMatches(left: RuntimeOwnerIdentity, right: RuntimeOwnerIdentity): boolean {
  return (
    left.pid === right.pid &&
    left.generation === right.generation &&
    left.ownerToken === right.ownerToken &&
    left.processStartedAt === right.processStartedAt
  );
}

function registryPath(directory: string): string {
  return path.join(directory, RUNTIME_REGISTRY_FILE);
}

function generationPath(directory: string): string {
  return path.join(directory, RUNTIME_GENERATION_FILE);
}

function withLease(record: RuntimeRegistryWrite, leaseMs = DEFAULT_RUNTIME_LEASE_MS): RuntimeRegistryRecord {
  const renewedAtMs = Date.now();
  return {
    schemaVersion: RUNTIME_REGISTRY_SCHEMA_VERSION,
    ...record,
    sessions: { ...record.sessions },
    lease: {
      renewedAt: new Date(renewedAtMs).toISOString(),
      expiresAt: new Date(renewedAtMs + leaseMs).toISOString(),
    },
  };
}

export function createRuntimeOwner(options: {
  pid?: number;
  generation: number;
  processStartedAt?: string;
  ownerToken?: string;
}): RuntimeOwnerIdentity {
  return {
    pid: options.pid ?? process.pid,
    generation: options.generation,
    ownerToken: options.ownerToken ?? randomUUID(),
    processStartedAt:
      options.processStartedAt ?? new Date(Date.now() - Math.max(0, process.uptime() * 1_000)).toISOString(),
  };
}

export function readRuntimeRegistry(directory: string): RuntimeRegistryRecord | null {
  try {
    return parseRuntimeRegistry(JSON.parse(readFileSync(registryPath(directory), "utf8")));
  } catch {
    return null;
  }
}

export function writeRuntimeRegistry(
  directory: string,
  record: RuntimeRegistryWrite,
  leaseMs = DEFAULT_RUNTIME_LEASE_MS,
): RuntimeRegistryRecord {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const next = withLease(record, leaseMs);
  const destination = registryPath(directory);
  const temporary = `${destination}.${record.owner.pid}.${record.owner.generation}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return next;
}

export function renewRuntimeRegistry(
  directory: string,
  owner: RuntimeOwnerIdentity,
  sessions: Record<string, SessionRuntimeState>,
  leaseMs = DEFAULT_RUNTIME_LEASE_MS,
): boolean {
  const current = readRuntimeRegistry(directory);
  if (!current || !runtimeOwnerMatches(current.owner, owner)) return false;
  writeRuntimeRegistry(
    directory,
    {
      owner,
      endpoint: current.endpoint,
      protocolVersion: current.protocolVersion,
      hostVersion: current.hostVersion,
      sessions,
    },
    leaseMs,
  );
  return true;
}

export function removeRuntimeRegistry(directory: string, owner: RuntimeOwnerIdentity): boolean {
  const current = readRuntimeRegistry(directory);
  if (!current || !runtimeOwnerMatches(current.owner, owner)) return false;
  rmSync(registryPath(directory), { force: true });
  return true;
}

export function runtimeRegistryExpired(record: RuntimeRegistryRecord, now = Date.now()): boolean {
  return Date.parse(record.lease.expiresAt) <= now;
}

export function nextRuntimeGeneration(directory: string): number {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let persistedGeneration = 0;
  try {
    const value = Number(readFileSync(generationPath(directory), "utf8").trim());
    if (validPositiveInteger(value)) persistedGeneration = value;
  } catch {
    persistedGeneration = 0;
  }
  const registryGeneration = readRuntimeRegistry(directory)?.owner.generation ?? 0;
  const generation = Math.max(persistedGeneration, registryGeneration) + 1;
  const destination = generationPath(directory);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${generation}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return generation;
}
