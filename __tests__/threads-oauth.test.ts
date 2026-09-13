import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMissingThreadsOAuthEnv } from "../lib/env";
import { ThreadsApiError } from "../lib/threads/client";
import {
  createThreadsOAuthState,
  exchangeLongLivedThreadsToken,
  exchangeThreadsCode,
  getThreadsAuthorizationUrl,
  verifyThreadsOAuthState,
} from "../lib/threads/oauth";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
    vi.stubEnv("THREADS_REQUEST_TIMEOUT_MS", "2345");
    const timeout = vi.spyOn(AbortSignal, "timeout");
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
    expect(vi.mocked(fetch).mock.calls[0][1]).toEqual(expect.objectContaining({
      method: "POST",
      signal: expect.any(AbortSignal),
    }));
    expect(timeout).toHaveBeenCalledWith(2345);
  });

  it.each([
    {},
    { access_token: "", user_id: "42" },
    { access_token: "short", user_id: null },
    { access_token: "short", user_id: {} },
  ])("rejects a malformed short-token payload", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 })
    ));

    const error = await exchangeThreadsCode(
      "secret-code",
      "https://example.com/api/threads/callback"
    ).catch((value) => value);

    expect(error).toBeInstanceOf(ThreadsApiError);
    expect(error.status).toBe(502);
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain("secret-code");
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
    expect(vi.mocked(fetch).mock.calls[0][1]).toEqual(expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    {},
    { access_token: "", expires_in: 5184000 },
    { access_token: "long", expires_in: "5184000" },
    { access_token: "long", expires_in: null },
  ])("rejects a malformed long-token payload", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 })
    ));

    const error = await exchangeLongLivedThreadsToken("secret-short-token")
      .catch((value) => value);

    expect(error).toBeInstanceOf(ThreadsApiError);
    expect(error.status).toBe(502);
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain("secret-short-token");
  });

  it("classifies OAuth network failures as retryable without leaking tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      new Error("socket failed while sending short-secret-token")
    ));

    const error = await exchangeLongLivedThreadsToken("short-secret-token")
      .catch((value) => value);

    expect(error).toBeInstanceOf(ThreadsApiError);
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(0);
    expect(error.message).not.toContain("short-secret-token");
  });

  it("redacts OAuth code and app secret from Meta error responses", async () => {
    const code = "oauth/code value";
    const appSecret = "app/secret value";
    vi.stubEnv("THREADS_APP_SECRET", appSecret);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        error: {
          message: `bad ${code} ${encodeURIComponent(code)} ${appSecret} ${encodeURIComponent(appSecret)}`,
        },
      }),
      { status: 400 }
    )));

    const error = await exchangeThreadsCode(
      code,
      "https://example.com/api/threads/callback"
    ).catch((value) => value);

    expect(error).toBeInstanceOf(ThreadsApiError);
    expect(error.message).not.toContain(code);
    expect(error.message).not.toContain(encodeURIComponent(code));
    expect(error.message).not.toContain(appSecret);
    expect(error.message).not.toContain(encodeURIComponent(appSecret));
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
