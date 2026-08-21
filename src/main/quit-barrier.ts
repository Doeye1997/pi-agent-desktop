export interface QuitBarrierEvent {
  preventDefault(): void;
}

export function createQuitBarrier(options: {
  detach: () => Promise<void>;
  cleanup: () => void | Promise<void>;
  quit: () => void;
  log: (message: string) => void;
}) {
  let state: "open" | "running" | "released" = "open";
  let pending: Promise<void> = Promise.resolve();

  const handleBeforeQuit = (event: QuitBarrierEvent): void => {
    if (state === "released") return;
    event.preventDefault();
    if (state === "running") return;
    state = "running";
    pending = (async () => {
      try {
        await options.detach();
      } catch (error) {
        options.log(`session display detach failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await options.cleanup();
      } catch (error) {
        options.log(`quit cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      state = "released";
      options.quit();
    })();
  };

  return {
    handleBeforeQuit,
    wait: () => pending,
  };
}
