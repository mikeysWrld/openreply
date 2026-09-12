import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMissingThreadsOAuthEnv } from "../lib/env";
import {
  createThreadsOAuthState,
  exchangeLongLivedThreadsToken,
  exchangeThreadsCode,
  getThreadsAuthorizationUrl,
  verifyThreadsOAuthState,
} from "../lib/threads/oauth";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-that-is-long-enough");
  vi.stubEnv("THREADS_APP_ID", "threads-app-id");
  vi.stubEnv("THREADS_APP_SECRET", "threads-app-secret");
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
});

describe("Threads OAuth", () => {
  it("signs and verifies workspace state", () => {
    const state = createThreadsOAuthState("workspace_1");
    expect(verifyThreadsOAuthState(state)?.workspaceId).toBe("workspace_1");
    expect(verifyThreadsOAuthState(`${state}tampered`)).toBeNull();
  });

  it("builds the authorization URL with only required scopes", () => {
    const url = new URL(
      getThreadsAuthorizationUrl("https://example.com/api/threads/callback", "signed")
    );
    expect(url.origin + url.pathname).toBe("https://threads.net/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("threads-app-id");
    expect(url.searchParams.get("scope")).toBe(
      "threads_basic,threads_read_replies,threads_content_publish"
    );
    expect(url.searchParams.get("state")).toBe("signed");
  });

  it("exchanges an authorization code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: "short", user_id: "42" }), {
          status: 200,
        })
      )
    );
    await expect(
      exchangeThreadsCode("code", "https://example.com/api/threads/callback")
    ).resolves.toEqual({ accessToken: "short", userId: "42" });
    const calledUrl = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/oauth/access_token");
    expect(calledUrl.searchParams.get("grant_type")).toBe("authorization_code");
  });

  it("exchanges a short-lived token for a long-lived token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: "long", expires_in: 5184000 }), {
          status: 200,
        })
      )
    );
    await expect(exchangeLongLivedThreadsToken("short")).resolves.toEqual({
      accessToken: "long",
      expiresIn: 5184000,
    });
    const calledUrl = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/access_token");
    expect(calledUrl.searchParams.get("grant_type")).toBe("th_exchange_token");
    expect(calledUrl.searchParams.get("access_token")).toBe("short");
  });
});

describe("Threads environment", () => {
  it("reports only missing Threads OAuth variables", () => {
    vi.stubEnv("THREADS_APP_ID", "");
    vi.stubEnv("THREADS_APP_SECRET", "");
    expect(getMissingThreadsOAuthEnv()).toEqual([
      "THREADS_APP_ID",
      "THREADS_APP_SECRET",
    ]);
  });
});
