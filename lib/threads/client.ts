import {
  readThreadsJson,
  redactThreadsSecrets,
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
  return readThreadsJson<ThreadsProfile>(
    response,
    "Threads API request failed",
    [accessToken]
  );
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
    const page: {
      data: T[];
      paging?: { next?: string };
    } = await readThreadsJson(response, "Threads API request failed", [accessToken]);
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
    limit,
    accessToken
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
  const container = await readThreadsJson<{ id: string }>(
    createResponse,
    "Threads API request failed",
    [accessToken]
  );
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
  const container = await readThreadsJson<ThreadsContainerStatus>(
    response,
    "Threads API request failed",
    [accessToken]
  );
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
  const published = await readThreadsJson<{ id: string }>(
    publishResponse,
    "Threads API request failed",
    [accessToken]
  );
  return published.id;
}
