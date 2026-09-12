import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  account: vi.fn(),
  campaign: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
  decryptToken: vi.fn(),
  getOwnedThreads: vi.fn(),
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.context,
  canManageWorkspace: () => true,
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    threadsAccount: { findFirst: mocks.account },
    threadsCampaign: {
      findFirst: mocks.campaign,
      create: mocks.create,
      updateMany: mocks.updateMany,
    },
  },
}));
vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: mocks.decryptToken,
}));
vi.mock("@/lib/threads/client", () => ({
  getOwnedThreads: mocks.getOwnedThreads,
}));

import { PATCH, POST } from "../app/api/threads/campaigns/route";

const validBody = {
  name: "Threads 公開回覆",
  threadsAccountId: "account_1",
  postId: "post_1",
  postUrl: "https://www.threads.net/@golfrai/post/abc",
  keywords: ["golfr", "golf"],
  wholeWordMatch: true,
  replyMessage: "感謝你的關注！立即加入 Beta 測試名單：https://golfr.ai/",
  isActive: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decryptToken.mockReturnValue("plain-token");
});

describe("Threads campaign API", () => {
  it("rejects unauthenticated creates", async () => {
    mocks.context.mockResolvedValue(null);
    const response = await POST(new NextRequest("https://example.com/api/threads/campaigns", {
      method: "POST",
      body: JSON.stringify(validBody),
    }));
    expect(response.status).toBe(401);
  });

  it("creates a paused campaign only for a workspace-owned account and stores its canonical permalink", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
    mocks.account.mockResolvedValue({ id: "account_1", accessToken: "encrypted-token" });
    mocks.getOwnedThreads.mockResolvedValue([{
      id: "post_1",
      permalink: "https://www.threads.net/@golfrai/post/canonical",
    }]);
    mocks.create.mockResolvedValue({ id: "campaign_1", ...validBody });
    const response = await POST(new NextRequest("https://example.com/api/threads/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    }));
    expect(response.status).toBe(201);
    expect(mocks.account).toHaveBeenCalledWith({
      where: { id: "account_1", workspaceId: "workspace_1" },
      select: { id: true, accessToken: true },
    });
    expect(mocks.decryptToken).toHaveBeenCalledWith("encrypted-token");
    expect(mocks.getOwnedThreads).toHaveBeenCalledWith("plain-token", 100);
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_1",
        isActive: false,
        postUrl: "https://www.threads.net/@golfrai/post/canonical",
      }),
    });
  });

  it("rejects a specific post not listed for the account without writing", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
    mocks.account.mockResolvedValue({ id: "account_1", accessToken: "encrypted-token" });
    mocks.getOwnedThreads.mockResolvedValue([{
      id: "owned_post",
      permalink: "https://www.threads.net/@golfrai/post/owned",
    }]);

    const response = await POST(new NextRequest("https://example.com/api/threads/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Threads post not found for this account",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns a safe 502 when loading owned posts fails", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
    mocks.account.mockResolvedValue({ id: "account_1", accessToken: "encrypted-token" });
    mocks.getOwnedThreads.mockRejectedValue(new Error("token=secret-value"));

    const response = await POST(new NextRequest("https://example.com/api/threads/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Failed to verify Threads post ownership",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects an empty keyword list", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
    const response = await POST(new NextRequest("https://example.com/api/threads/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, keywords: [] }),
    }));
    expect(response.status).toBe(400);
  });

  it("normalizes post fields when creating an all-posts campaign", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
    mocks.account.mockResolvedValue({ id: "account_1", accessToken: "encrypted-token" });
    mocks.create.mockResolvedValue({ id: "campaign_1" });

    const response = await POST(new NextRequest("https://example.com/api/threads/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, matchAnyPost: true }),
    }));

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_1",
        matchAnyPost: true,
        postId: null,
        postUrl: null,
      }),
    });
    expect(mocks.decryptToken).not.toHaveBeenCalled();
    expect(mocks.getOwnedThreads).not.toHaveBeenCalled();
  });

  it("rejects a specific-post create without valid target fields", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });

    const response = await POST(new NextRequest("https://example.com/api/threads/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, matchAnyPost: false, postId: "", postUrl: null }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.account).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("normalizes post fields when switching a campaign to all posts", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
    mocks.updateMany.mockResolvedValue({ count: 1 });

    const response = await PATCH(new NextRequest("https://example.com/api/threads/campaigns?id=campaign_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchAnyPost: true,
        postId: null,
        postUrl: null,
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "campaign_1", workspaceId: "workspace_1" },
      data: { matchAnyPost: true, postId: null, postUrl: null },
    });
    expect(mocks.getOwnedThreads).not.toHaveBeenCalled();
  });

  it("rejects non-null post fields when switching to all posts", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });

    const response = await PATCH(new NextRequest("https://example.com/api/threads/campaigns?id=campaign_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchAnyPost: true,
        postId: "stale_post",
        postUrl: "https://www.threads.net/@golfrai/post/stale",
      }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an incomplete switch to a specific post", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });

    const response = await PATCH(new NextRequest("https://example.com/api/threads/campaigns?id=campaign_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ matchAnyPost: false, postId: "post_2" }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("updates isActive without requiring target fields", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
    mocks.updateMany.mockResolvedValue({ count: 1 });

    const response = await PATCH(new NextRequest("https://example.com/api/threads/campaigns?id=campaign_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: true }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "campaign_1", workspaceId: "workspace_1" },
      data: { isActive: true },
    });
    expect(mocks.campaign).not.toHaveBeenCalled();
    expect(mocks.getOwnedThreads).not.toHaveBeenCalled();
  });

  it("validates a specific-post PATCH against the campaign account and stores the canonical permalink", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
    mocks.campaign.mockResolvedValue({
      id: "campaign_1",
      threadsAccount: { accessToken: "campaign-encrypted-token" },
    });
    mocks.getOwnedThreads.mockResolvedValue([{
      id: "post_2",
      permalink: "https://www.threads.net/@golfrai/post/canonical-2",
    }]);
    mocks.updateMany.mockResolvedValue({ count: 1 });

    const response = await PATCH(new NextRequest("https://example.com/api/threads/campaigns?id=campaign_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchAnyPost: false,
        postId: "post_2",
        postUrl: "https://attacker.example/forged",
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.campaign).toHaveBeenCalledWith({
      where: { id: "campaign_1", workspaceId: "workspace_1" },
      select: { id: true, threadsAccount: { select: { accessToken: true } } },
    });
    expect(mocks.decryptToken).toHaveBeenCalledWith("campaign-encrypted-token");
    expect(mocks.getOwnedThreads).toHaveBeenCalledWith("plain-token", 100);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "campaign_1", workspaceId: "workspace_1" },
      data: {
        matchAnyPost: false,
        postId: "post_2",
        postUrl: "https://www.threads.net/@golfrai/post/canonical-2",
      },
    });
  });

  it("rejects a specific-post PATCH when the campaign does not exist", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
    mocks.campaign.mockResolvedValue(null);

    const response = await PATCH(new NextRequest("https://example.com/api/threads/campaigns?id=missing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchAnyPost: false,
        postId: "post_2",
        postUrl: "https://www.threads.net/@golfrai/post/post-2",
      }),
    }));

    expect(response.status).toBe(404);
    expect(mocks.getOwnedThreads).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a specific-post PATCH when the post is not owned by the campaign account", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
    mocks.campaign.mockResolvedValue({
      id: "campaign_1",
      threadsAccount: { accessToken: "campaign-encrypted-token" },
    });
    mocks.getOwnedThreads.mockResolvedValue([]);

    const response = await PATCH(new NextRequest("https://example.com/api/threads/campaigns?id=campaign_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchAnyPost: false,
        postId: "foreign_post",
        postUrl: "https://www.threads.net/@someone/post/foreign",
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Threads post not found for this account",
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("returns a safe 502 when PATCH cannot load the campaign account's posts", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
    mocks.campaign.mockResolvedValue({
      id: "campaign_1",
      threadsAccount: { accessToken: "campaign-encrypted-token" },
    });
    mocks.getOwnedThreads.mockRejectedValue(new Error("campaign-encrypted-token"));

    const response = await PATCH(new NextRequest("https://example.com/api/threads/campaigns?id=campaign_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchAnyPost: false,
        postId: "post_2",
        postUrl: "https://www.threads.net/@golfrai/post/post-2",
      }),
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Failed to verify Threads post ownership",
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a supplied Threads account on PATCH", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });

    const response = await PATCH(new NextRequest("https://example.com/api/threads/campaigns?id=campaign_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: true, threadsAccountId: "account_2" }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
