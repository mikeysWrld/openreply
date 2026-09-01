import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeInstagramAccountToWebhooks } from "../lib/meta/client";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("subscribeInstagramAccountToWebhooks", () => {
  it("subscribes the account to every webhook field OpenReply handles", async () => {
    vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await subscribeInstagramAccountToWebhooks(
      "instagram-account-id",
      "access-token"
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.instagram.com/v25.0/instagram-account-id/subscribed_apps",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer access-token",
        },
        body: JSON.stringify({
          subscribed_fields: [
            "comments",
            "messages",
            "messaging_postbacks",
            "messaging_seen",
          ],
        }),
      }
    );
  });
});
