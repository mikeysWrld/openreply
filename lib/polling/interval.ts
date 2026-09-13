const DEFAULT_THREADS_POLL_INTERVAL_MS = 5 * 60_000;

export function getThreadsPollIntervalMs(
  value = process.env.THREADS_POLL_INTERVAL_MS,
): number {
  if (!value) return DEFAULT_THREADS_POLL_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_THREADS_POLL_INTERVAL_MS;
  }
  return Math.floor(parsed);
}
