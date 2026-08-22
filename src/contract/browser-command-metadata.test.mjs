import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_COMMAND_METADATA,
  BROWSER_HOST_METHODS,
  browserPermissionForMethod,
  browserScreenshotCost,
} from "./browser.ts";

test("Browser command metadata exhaustively owns availability, permission, and screenshot cost", () => {
  assert.deepEqual(new Set(Object.keys(BROWSER_COMMAND_METADATA)), BROWSER_HOST_METHODS);
  assert.equal(BROWSER_COMMAND_METADATA["browser.capabilities"].availability, "internal");
  assert.equal(BROWSER_COMMAND_METADATA["browser.open"].availability, "agent");
  assert.equal(browserPermissionForMethod("browser.open"), "read");
  assert.equal(browserPermissionForMethod("browser.click"), "interact");
  assert.equal(browserPermissionForMethod("browser.networkList"), "advanced");
  assert.equal(browserScreenshotCost("browser.inspect", {}), 0);
  assert.equal(browserScreenshotCost("browser.inspect", { screenshot: { enabled: true } }), 1);
  assert.equal(browserScreenshotCost("browser.screenshot", {}), 1);
  assert.equal(browserScreenshotCost("browser.visualCompare", {}), 2);
});
