/**
 * Retry for the CLI-backed providers.
 *
 * A 6-hour run makes thousands of sequential CLI calls; a single transient
 * failure (rate limit, timeout, malformed output) must cost one retry, not the
 * run. Retries are bounded and backed off; a call that fails three times is a
 * real error and should surface.
 */
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 15_000;
/** Rate-limit waits: up to this many, each as long as the provider asks. */
const LIMIT_ATTEMPTS = 24;

export async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LIMIT_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const hint = error as { noRetry?: boolean; retryAfterMs?: number };
      // A provider can mark an error as pointless to retry (a rejected request)...
      if (hint?.noRetry) break;
      // ...or as a rate limit, which is worth waiting out for longer than three
      // short tries: a subscription window can close for many minutes.
      if (hint?.retryAfterMs) {
        if (attempt >= LIMIT_ATTEMPTS) break;
        console.error(`[retry] ${label} waiting ${hint.retryAfterMs / 1000}s (${String(error).slice(0, 120)}), attempt ${attempt} of ${LIMIT_ATTEMPTS}`);
        await new Promise(resolve => setTimeout(resolve, hint.retryAfterMs));
        continue;
      }
      if (attempt === MAX_ATTEMPTS) break;
      const delay = BASE_DELAY_MS * attempt;
      console.error(`[retry] ${label} attempt ${attempt} failed (${String(error).slice(0, 160)}); retrying in ${delay / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
