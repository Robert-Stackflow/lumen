(function exposeRuntime(root) {
  function preferencePatch(current, baseline) {
    if (!baseline) return { ...current };
    return Object.fromEntries(Object.entries(current).filter(([key, value]) =>
      JSON.stringify(value) !== JSON.stringify(baseline[key])));
  }

  class AdaptivePoller {
    constructor(task, delay) {
      this.task = task;
      this.delay = delay;
      this.timer = null;
      this.stopped = true;
    }

    start(initialDelay = 0) {
      if (!this.stopped) return;
      this.stopped = false;
      this.timer = setTimeout(() => void this.tick(), initialDelay);
    }

    stop() {
      this.stopped = true;
      clearTimeout(this.timer);
      this.timer = null;
    }

    async tick() {
      if (this.stopped) return;
      try {
        await this.task();
      } finally {
        if (!this.stopped) this.timer = setTimeout(() => void this.tick(), this.delay());
      }
    }
  }

  root.LumenRuntime = { AdaptivePoller, preferencePatch };
}(globalThis));
