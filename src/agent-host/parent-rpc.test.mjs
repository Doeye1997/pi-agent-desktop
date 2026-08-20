import assert from "node:assert/strict";
import test from "node:test";

import { configureHostControl, ElectronMainUnavailableError, receiveMainControlMessage } from "./host-control.ts";
import { callMain } from "./parent-rpc.ts";

test("callMain preserves the structured unavailable error at the reconnect deadline", async () => {
  configureHostControl({
    broadcast() {},
    sendToMain: (_message, timeoutMs = 30_000) =>
      new Promise((_, reject) => {
        setTimeout(() => reject(new ElectronMainUnavailableError(timeoutMs)), timeoutMs);
      }),
  });

  await assert.rejects(
    callMain("browser.capabilities", undefined, 10),
    (error) => error.code === "ELECTRON_MAIN_UNAVAILABLE" && error.details?.waitedMs === 10,
  );
});

test("callMain returns structured unavailable when Main disconnects after accepting the request", async () => {
  configureHostControl({
    broadcast() {},
    async sendToMain() {},
  });

  const pending = callMain("browser.capabilities", undefined, 10);
  await new Promise((resolve) => setImmediate(resolve));
  receiveMainControlMessage({ type: "main-disconnected" });
  await assert.rejects(
    pending,
    (error) => error.code === "ELECTRON_MAIN_UNAVAILABLE" && error.details?.waitedMs === 10,
  );
});
