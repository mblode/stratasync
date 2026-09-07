/* oxlint-disable eslint-plugin-promise/avoid-new -- polling the server is how a figure waits for a real write to arrive */

/**
 * Wait for a real write to reach the server.
 *
 * The figures that need this run at zero latency, so what is being waited on
 * is not the wire: it is batching, which holds a mutation for `batchDelay`
 * before it is sent. The deadline is a floor under a figure that would
 * otherwise wait for something that is never going to happen.
 */
export const until = (test: () => boolean, timeoutMs = 2000): Promise<void> =>
  new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (test() || Date.now() > deadline) {
        resolve();
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
