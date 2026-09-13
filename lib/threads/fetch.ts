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

export function invalidThreadsResponse(): ThreadsApiError {
  return new ThreadsApiError(
    "Threads API returned an invalid response",
    502,
    null,
    true
  );
}

export function isThreadsRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireThreadsString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidThreadsResponse();
  }
  return value;
}

function redactValue(message: string, value: string): string {
  if (!value) return message;
  const variants = new Set([
    value,
    encodeURIComponent(value),
    new URLSearchParams({ value }).toString().slice("value=".length),
  ]);
  let redacted = message;
  for (const variant of variants) {
    if (variant) redacted = redacted.split(variant).join("[REDACTED]");
  }
  return redacted;
}

export function redactThreadsSecrets(
  message: string,
  secrets: readonly string[]
): string {
  return secrets.reduce(redactValue, message);
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function readThreadsJson<T>(
  response: Response,
  fallbackMessage: string,
  secrets: readonly string[] = []
): Promise<T> {
  let data: unknown;
  try {
    const body = await response.text();
    data = body ? JSON.parse(body) : undefined;
  } catch {
    data = undefined;
  }

  const payload = isThreadsRecord(data) ? data : undefined;
  const nestedError = isThreadsRecord(payload?.error)
    ? payload.error
    : undefined;
  if (!response.ok) {
    const message = redactThreadsSecrets(
      (typeof nestedError?.message === "string" ? nestedError.message : undefined) ??
        (typeof payload?.error_message === "string"
          ? payload.error_message
          : fallbackMessage),
      secrets
    );
    throw new ThreadsApiError(
      message,
      response.status,
      typeof nestedError?.code === "number" ? nestedError.code : null,
      retryableStatus(response.status)
    );
  }
  if (!isThreadsRecord(data)) {
    throw invalidThreadsResponse();
  }
  return data as T;
}

export function getThreadsRequestTimeoutMs(): number {
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
      signal: AbortSignal.timeout(getThreadsRequestTimeoutMs()),
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
