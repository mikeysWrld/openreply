const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class ThreadsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: number | null,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "ThreadsApiError";
  }
}

function requestTimeoutMs(): number {
  const configured = process.env.THREADS_REQUEST_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

export async function threadsFetch(
  input: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  try {
    return await fetch(input, {
      ...init,
      signal: AbortSignal.timeout(requestTimeoutMs()),
    });
  } catch (error) {
    const reason =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
        ? "timed out"
        : "failed before receiving a response";
    throw new ThreadsApiError(`Threads API request ${reason}`, 0, null, true);
  }
}
