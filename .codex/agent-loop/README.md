# Agent loop pack

Living cheap-dev + demo + release-target + docs map for this repo.

- Shared policy: `hero-anti-overdefense` (global)
- Project loop: `doe-cheap-loop`
- Update when situations teach cheaper paths
- On Windows, run the full unit suite where its Plugin worker test may call `taskkill`; restricted sandboxes produce a false failure and leak the test worker.
- Resolve `os.tmpdir()` descendants with `realpathSync.native` before `fs.watch`; 8.3 short paths can trigger a native libuv assertion.
