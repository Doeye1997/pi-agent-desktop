import { createRpcServer } from "../contract/rpc.ts";
import { startStandaloneHostServer } from "./standalone-host-server.ts";

const userDataDirectory = process.env.PI_DESKTOP_USER_DATA;
if (!userDataDirectory) throw new Error("PI_DESKTOP_USER_DATA is required");

const rpcServer = createRpcServer();
let running = false;
let heldValue: string | null = null;
let result: string | null = null;
let releaseHold: (() => void) | undefined;

rpcServer.handle({
  "fixture.hold": async (params: unknown) => {
    const body = params as { value?: unknown };
    running = true;
    heldValue = typeof body.value === "string" ? body.value : "";
    standaloneServer.notifyBusyChanged();
    await new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    return { ok: true as const };
  },
  "fixture.status": () => ({ running, result }),
  "fixture.release": () => {
    result = heldValue;
    running = false;
    releaseHold?.();
    releaseHold = undefined;
    standaloneServer.notifyBusyChanged();
    return { ok: true as const };
  },
} as never);

const standaloneServer = await startStandaloneHostServer({
  userDataDirectory,
  hostVersion: "fixture",
  rpcServer,
  isBusy: () => running,
  idleExitDelayMs: 50,
  onControl: (value) => {
    const message = value as { type?: string };
    if (message.type === "replace-when-idle") standaloneServer.requestExitWhenIdle();
  },
  onExitRequested: () => {
    setImmediate(() => process.exit(0));
  },
});
