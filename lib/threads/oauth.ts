import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { requireEnv } from "@/lib/env";
import { readThreadsJson, threadsFetch } from "@/lib/threads/fetch";

const AUTHORIZE_URL = "https://threads.net/oauth/authorize";
const GRAPH_URL = "https://graph.threads.net";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const SCOPES = [
  "threads_basic",
  "threads_read_replies",
  "threads_content_publish",
].join(",");

interface ThreadsOAuthState {
  workspaceId: string;
  ts: number;
}

function sign(value: string): string {
  return createHmac("sha256", requireEnv("NEXTAUTH_SECRET"))
    .update(value)
    .digest("base64url");
}

export function createThreadsOAuthState(workspaceId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ workspaceId, ts: Date.now() } satisfies ThreadsOAuthState)
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyThreadsOAuthState(
  state: string | null
): ThreadsOAuthState | null {
  if (!state) return null;
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;

  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as ThreadsOAuthState;
    if (
      !parsed.workspaceId ||
      !Number.isFinite(parsed.ts) ||
      Date.now() - parsed.ts > STATE_MAX_AGE_MS
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function getThreadsAuthorizationUrl(
  redirectUri: string,
  state: string
): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: requireEnv("THREADS_APP_ID"),
    redirect_uri: redirectUri,
    scope: SCOPES,
    response_type: "code",
    state,
  }).toString();
  return url.toString();
}

export async function exchangeThreadsCode(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; userId: string }> {
  const appSecret = requireEnv("THREADS_APP_SECRET");
  const url = new URL(`${GRAPH_URL}/oauth/access_token`);
  url.search = new URLSearchParams({
    client_id: requireEnv("THREADS_APP_ID"),
    client_secret: appSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }).toString();
  const response = await threadsFetch(url, { method: "POST" });
  const data = await readThreadsJson<{
    access_token: string;
    user_id: string | number;
  }>(response, "Threads OAuth request failed", [code, appSecret]);
  return { accessToken: data.access_token, userId: String(data.user_id) };
}

export async function exchangeLongLivedThreadsToken(
  shortLivedToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const appSecret = requireEnv("THREADS_APP_SECRET");
  const url = new URL(`${GRAPH_URL}/access_token`);
  url.search = new URLSearchParams({
    grant_type: "th_exchange_token",
    client_secret: appSecret,
    access_token: shortLivedToken,
  }).toString();
  const response = await threadsFetch(url);
  const data = await readThreadsJson<{
    access_token: string;
    expires_in: number;
  }>(response, "Threads OAuth request failed", [shortLivedToken, appSecret]);
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}
