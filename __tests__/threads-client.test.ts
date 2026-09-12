import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ThreadsApiError,
  createThreadsReplyContainer,
  getThreadsContainerStatus,
  getOwnedThreads,
  getThreadsConversation,
  getThreadsProfile,
  publishThreadsReplyContainer,
} from "../lib/threads/client";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Threads API client", () => {
  it("loads the authenticated profile without exposing the token in the path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: "42", username: "golfrai" }), { status: 200 }
    )));
    await expect(getThreadsProfile("secret-token")).resolves.toEqual({
      id: "42",
      username: "golfrai",
    });
    const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(url.pathname).toBe("/me");
    expect(url.searchParams.get("access_token")).toBe("secret-token");
  });

  it("loads owned posts and a flattened conversation", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "post_1" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "reply_1", text: "golfr" }] }), { status: 200 }))
    );
    await expect(getOwnedThreads("token", 10)).resolves.toEqual([{ id: "post_1" }]);
    await expect(getThreadsConversation("token", "post_1")).resolves.toEqual([
      { id: "reply_1", text: "golfr" },
    ]);
    const conversation = new URL(vi.mocked(fetch).mock.calls[1][0] as string);
    expect(conversation.pathname).toBe("/post_1/conversation");
    expect(conversation.searchParams.get("reverse")).toBe("true");
  });

  it("creates a text reply container", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "container_1" }), { status: 200 })
    ));
    await expect(
      createThreadsReplyContainer("token", "42", "reply_1", "感謝你的關注！")
    ).resolves.toBe("container_1");
    const create = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(create.pathname).toBe("/42/threads");
    expect(create.searchParams.get("media_type")).toBe("TEXT");
    expect(create.searchParams.get("reply_to_id")).toBe("reply_1");
  });

  it("loads a reply container status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: "container_1",
        status: "ERROR",
        error_message: "Invalid reply",
      }), { status: 200 })
    ));

    await expect(getThreadsContainerStatus("token", "container_1")).resolves.toEqual({
      id: "container_1",
      status: "ERROR",
      error_message: "Invalid reply",
    });
    const status = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(status.pathname).toBe("/container_1");
    expect(status.searchParams.get("fields")).toBe("id,status,error_message");
  });

  it("publishes an existing reply container", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "published_1" }), { status: 200 })
    ));

    await expect(
      publishThreadsReplyContainer("token", "42", "container_1")
    ).resolves.toBe("published_1");
    const publish = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(publish.pathname).toBe("/42/threads_publish");
    expect(publish.searchParams.get("creation_id")).toBe("container_1");
  });

  it("uses the configured request timeout duration", async () => {
    vi.stubEnv("THREADS_REQUEST_TIMEOUT_MS", "1234");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "42", username: "golfrai" }), { status: 200 })
    ));

    await getThreadsProfile("token");

    expect(vi.mocked(fetch).mock.calls[0][1]).toEqual(expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(timeout).toHaveBeenCalledWith(1234);
  });

  it("defaults the request timeout to 15000 milliseconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "42", username: "golfrai" }), { status: 200 })
    ));

    await getThreadsProfile("token");

    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it.each(["", "0", "-1", "1.5", "NaN", "Infinity"])(
    "falls back to 15000 milliseconds for invalid timeout %j",
    async (configured) => {
      vi.stubEnv("THREADS_REQUEST_TIMEOUT_MS", configured);
      const timeout = vi.spyOn(AbortSignal, "timeout");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "42", username: "golfrai" }), { status: 200 })
      ));

      await getThreadsProfile("token");

      expect(timeout).toHaveBeenCalledWith(15_000);
    }
  );

  it("classifies ordinary network failures as retryable without leaking tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      new Error("socket failed for access_token=super-secret")
    ));

    const error = await getThreadsProfile("super-secret").catch((value) => value);

    expect(error).toBeInstanceOf(ThreadsApiError);
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(0);
    expect(error.message).not.toContain("super-secret");
  });

  it("classifies timeout failures as retryable without leaking tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError")
    ));

    const error = await getThreadsProfile("super-secret").catch((value) => value);

    expect(error).toBeInstanceOf(ThreadsApiError);
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(0);
    expect(error.message).not.toContain("super-secret");
  });

  it("classifies retryable failures and excludes tokens from messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "temporary", code: 2 } }), { status: 503 }
    )));
    const error = await getThreadsProfile("super-secret").catch((value) => value);
    expect(error).toBeInstanceOf(ThreadsApiError);
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain("super-secret");
  });
});
