import { calculateRetryDelay } from "../src/retry";
import type { LiveEditingRetryConfig } from "../src/types";

const baseConfig: LiveEditingRetryConfig = {
  baseDelayMs: 500,
  jitter: 0.2,
  maxDelayMs: 5000,
  maxRetries: 3,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe(calculateRetryDelay, () => {
  it("hard-caps the jittered delay at maxDelayMs", () => {
    // Math.random() === 1 drives the jitter to its positive extreme:
    // (1 * 2 - 1) === 1, so the delay would overshoot maxDelayMs without the clamp.
    vi.spyOn(Math, "random").mockReturnValue(1);

    for (let attempt = 0; attempt <= 10; attempt += 1) {
      const delay = calculateRetryDelay(attempt, baseConfig);
      expect(delay).toBeLessThanOrEqual(baseConfig.maxDelayMs);
    }
  });

  it("caps at maxDelayMs once the exponential backoff saturates", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);

    // attempt 4: 500 * 2**4 === 8000, clamped to 5000; jitter would push to 6000.
    expect(calculateRetryDelay(4, baseConfig)).toBe(baseConfig.maxDelayMs);
  });

  it("returns the exponential delay unchanged when jitter is 0", () => {
    const config: LiveEditingRetryConfig = { ...baseConfig, jitter: 0 };
    // Math.random must never be consulted on the jitter === 0 path.
    const randomSpy = vi.spyOn(Math, "random");

    expect(calculateRetryDelay(0, config)).toBe(500);
    expect(calculateRetryDelay(1, config)).toBe(1000);
    expect(calculateRetryDelay(2, config)).toBe(2000);
    // Saturates at maxDelayMs.
    expect(calculateRetryDelay(4, config)).toBe(5000);
    expect(randomSpy).not.toHaveBeenCalled();
  });
});
