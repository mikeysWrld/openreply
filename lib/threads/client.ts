const GRAPH_URL = "https://graph.threads.net";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type ThreadsContainerStatusValue =
  | "IN_PROGRESS"
  | "FINISHED"
  | "PUBLISHED"
  | "ERROR"
  | "EXPIRED";

export interface ThreadsContainerStatus {
  id: string;
  status: ThreadsContainerStatusValue;
  error_message?: string;
}

export interface ThreadsProfile {
  id: string;
  username: string;
  threads_profile_picture_url?: string;
  threads_biography?: string;
}

export interface ThreadsPost {
  id: string;
  text?: string;
  timestamp?: string;
  permalink?: string;
  media_type?: string;
  shortcode?: string;
}

export interface ThreadsReply extends ThreadsPost {
  username?: string;
  owner?: { id: string };
  is_reply?: boolean;
  is_reply_owned_by_me?: boolean;
  root_post?: { id: string };
  replied_to?: { id: string };
}

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

async function readResponse<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & {
    error?: { message?: string; code?: number };
  };
  if (!response.ok) {
    throw new ThreadsApiError(
      data.error?.message ?? "Threads API request failed",
      response.status,
      data.error?.code ?? null,
      response.status === 429 || response.status >= 500
    );
  }
  return data;
}

function graphUrl(path: string, token: string, params?: Record<string, string>) {
  const url = new URL(path, GRAPH_URL);
  const search = new URLSearchParams({ access_token: token, ...params });
  url.search = search.toString();
  return url;
}

function requestTimeoutMs(): number {
  const configured = process.env.THREADS_REQUEST_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

async function threadsFetch(
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
      error instanceof Error && error.name === "AbortError"
        ? "timed out"
        : "failed before receiving a response";
    throw new ThreadsApiError(`Threads API request ${reason}`, 0, null, true);
  }
}

export async function getThreadsProfile(
  accessToken: string
): Promise<ThreadsProfile> {
  const response = await threadsFetch(
    graphUrl("/me", accessToken, {
      fields: "id,username,threads_profile_picture_url,threads_biography",
    })
  );
  return readResponse<ThreadsProfile>(response);
}

async function getPaged<T>(initialUrl: URL, max: number): Promise<T[]> {
  const results: T[] = [];
  let next: string | null = initialUrl.toString();
  while (next && results.length < max) {
    const response: Response = await threadsFetch(next);
    const page: {
      data: T[];
      paging?: { next?: string };
    } = await readResponse(response);
    results.push(...page.data.slice(0, max - results.length));
    next = page.paging?.next ?? null;
  }
  return results;
}

export function getOwnedThreads(
  accessToken: string,
  limit = 50
): Promise<ThreadsPost[]> {
  return getPaged<ThreadsPost>(
    graphUrl("/me/threads", accessToken, {
      fields: "id,text,timestamp,permalink,media_type,shortcode",
      limit: String(Math.min(limit, 100)),
    }),
    limit
  );
}

export function getThreadsConversation(
  accessToken: string,
  rootPostId: string,
  limit = 250
): Promise<ThreadsReply[]> {
  return getPaged<ThreadsReply>(
    graphUrl(`/${rootPostId}/conversation`, accessToken, {
      fields:
        "id,text,timestamp,permalink,username,owner,is_reply,is_reply_owned_by_me,root_post,replied_to",
      // The poller only requests a bounded page, so ask Meta for newest-first
      // results. Otherwise active conversations eventually pin us to old replies.
      reverse: "true",
      limit: "100",
    }),
    limit
  );
}

export async function createThreadsReplyContainer(
  accessToken: string,
  userId: string,
  replyToId: string,
  text: string
): Promise<string> {
  const createResponse = await threadsFetch(
    graphUrl(`/${userId}/threads`, accessToken, {
      media_type: "TEXT",
      text,
      reply_to_id: replyToId,
    }),
    { method: "POST" }
  );
  const container = await readResponse<{ id: string }>(createResponse);
  return container.id;
}

export async function getThreadsContainerStatus(
  accessToken: string,
  containerId: string
): Promise<ThreadsContainerStatus> {
  const response = await threadsFetch(
    graphUrl(`/${containerId}`, accessToken, {
      fields: "id,status,error_message",
    })
  );
  return readResponse<ThreadsContainerStatus>(response);
}

export async function publishThreadsReplyContainer(
  accessToken: string,
  userId: string,
  containerId: string
): Promise<string> {
  const publishResponse = await threadsFetch(
    graphUrl(`/${userId}/threads_publish`, accessToken, {
      creation_id: containerId,
    }),
    { method: "POST" }
  );
  const published = await readResponse<{ id: string }>(publishResponse);
  return published.id;
}
