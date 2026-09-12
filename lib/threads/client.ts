import {
  invalidThreadsResponse,
  isThreadsRecord,
  readThreadsJson,
  redactThreadsSecrets,
  requireThreadsString,
  threadsFetch,
} from "@/lib/threads/fetch";

const GRAPH_URL = "https://graph.threads.net";

export { ThreadsApiError } from "@/lib/threads/fetch";

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

const THREADS_CONTAINER_STATUSES = new Set<ThreadsContainerStatusValue>([
  "IN_PROGRESS",
  "FINISHED",
  "PUBLISHED",
  "ERROR",
  "EXPIRED",
]);

function requiredResponseId(value: unknown): string {
  return requireThreadsString(value);
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

export interface ThreadsPostDetails {
  id: string;
  permalink: string;
  owner: { id: string };
}

export interface ThreadsReply extends ThreadsPost {
  username?: string;
  owner?: { id: string };
  is_reply?: boolean;
  is_reply_owned_by_me?: boolean;
  root_post?: { id: string };
  replied_to?: { id: string };
}

function graphUrl(path: string, token: string, params?: Record<string, string>) {
  const url = new URL(path, GRAPH_URL);
  const search = new URLSearchParams({ access_token: token, ...params });
  url.search = search.toString();
  return url;
}

export async function getThreadsProfile(
  accessToken: string
): Promise<ThreadsProfile> {
  const response = await threadsFetch(
    graphUrl("/me", accessToken, {
      fields: "id,username,threads_profile_picture_url,threads_biography",
    })
  );
  const profile = await readThreadsJson<Record<string, unknown>>(
    response,
    "Threads API request failed",
    [accessToken]
  );
  return {
    ...profile,
    id: requireThreadsString(profile.id),
    username: requireThreadsString(profile.username),
  } as ThreadsProfile;
}

async function getPaged<T>(
  initialUrl: URL,
  max: number,
  accessToken: string
): Promise<T[]> {
  const results: T[] = [];
  let next: string | null = initialUrl.toString();
  while (next && results.length < max) {
    const response: Response = await threadsFetch(next);
    const page = await readThreadsJson<Record<string, unknown>>(
      response,
      "Threads API request failed",
      [accessToken]
    );
    if (!Array.isArray(page.data)) throw invalidThreadsResponse();
    const items = page.data.map((item) => {
      if (!isThreadsRecord(item)) throw invalidThreadsResponse();
      requireThreadsString(item.id);
      return item as T;
    });
    results.push(...items.slice(0, max - results.length));

    if (page.paging === undefined) {
      next = null;
    } else {
      if (!isThreadsRecord(page.paging)) throw invalidThreadsResponse();
      if (page.paging.next === undefined) {
        next = null;
      } else {
        const nextUrl = requireThreadsString(page.paging.next);
        let parsedNext: URL;
        try {
          parsedNext = new URL(nextUrl);
        } catch {
          throw invalidThreadsResponse();
        }
        if (parsedNext.origin !== GRAPH_URL) throw invalidThreadsResponse();
        next = parsedNext.toString();
      }
    }
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
    limit,
    accessToken
  );
}

export function isCanonicalThreadsPermalink(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "threads.net" || url.hostname.endsWith(".threads.net")) &&
      url.username === "" &&
      url.password === "" &&
      url.port === "";
  } catch {
    return false;
  }
}

export async function getThreadsPostDetails(
  accessToken: string,
  postId: string
): Promise<ThreadsPostDetails> {
  const response = await threadsFetch(
    graphUrl(`/${encodeURIComponent(postId)}`, accessToken, {
      fields: "id,permalink,owner",
    })
  );
  const post = await readThreadsJson<Record<string, unknown>>(
    response,
    "Threads API request failed",
    [accessToken]
  );
  const id = requireThreadsString(post.id);
  if (id !== postId || !isThreadsRecord(post.owner)) {
    throw invalidThreadsResponse();
  }
  const ownerId = requireThreadsString(post.owner.id);
  if (!isCanonicalThreadsPermalink(post.permalink)) {
    throw invalidThreadsResponse();
  }
  return { id, permalink: post.permalink, owner: { id: ownerId } };
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
    limit,
    accessToken
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
  const container = await readThreadsJson<{ id?: unknown }>(
    createResponse,
    "Threads API request failed",
    [accessToken]
  );
  return requiredResponseId(container.id);
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
  const data = await readThreadsJson<{
    id?: unknown;
    status?: unknown;
    error_message?: unknown;
  }>(
    response,
    "Threads API request failed",
    [accessToken]
  );
  const id = requiredResponseId(data.id);
  if (id !== containerId) throw invalidThreadsResponse();
  if (
    typeof data.status !== "string" ||
    !THREADS_CONTAINER_STATUSES.has(data.status as ThreadsContainerStatusValue)
  ) {
    throw invalidThreadsResponse();
  }
  const container: ThreadsContainerStatus = {
    id,
    status: data.status as ThreadsContainerStatusValue,
    ...(typeof data.error_message === "string"
      ? { error_message: data.error_message }
      : {}),
  };
  if (container.error_message) {
    container.error_message = redactThreadsSecrets(
      container.error_message,
      [accessToken]
    );
  }
  return container;
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
  const published = await readThreadsJson<{ id?: unknown }>(
    publishResponse,
    "Threads API request failed",
    [accessToken]
  );
  return requiredResponseId(published.id);
}
