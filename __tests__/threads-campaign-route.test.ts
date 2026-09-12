import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  account: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.context,
  canManageWorkspace: () => true,
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    threadsAccount: { findFirst: mocks.account },
    threadsCampaign: { create: mocks.create },
  },
}));

import { POST } from "../app/api/threads/campaigns/route";

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

beforeEach(() => vi.clearAllMocks());

describe("Threads campaign API", () => {
  it("rejects unauthenticated creates", async () => {
    mocks.context.mockResolvedValue(null);
    const response = await POST(new NextRequest("https://example.com/api/threads/campaigns", {
      method: "POST",
      body: JSON.stringify(validBody),
    }));
    expect(response.status).toBe(401);
  });

  it("creates a paused campaign only for a workspace-owned account", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
    mocks.account.mockResolvedValue({ id: "account_1" });
    mocks.create.mockResolvedValue({ id: "campaign_1", ...validBody });
    const response = await POST(new NextRequest("https://example.com/api/threads/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    }));
    expect(response.status).toBe(201);
    expect(mocks.account).toHaveBeenCalledWith({
      where: { id: "account_1", workspaceId: "workspace_1" },
      select: { id: true },
    });
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: "workspace_1", isActive: false }),
    });
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
});
