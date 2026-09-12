import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentWorkspaceId: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: mocks.getCurrentWorkspaceId,
}));
vi.mock("@/lib/db/client", () => ({
  prisma: { threadsAccount: { findMany: mocks.findMany } },
}));

import { GET as listThreadsAccounts } from "../app/api/threads/accounts/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Threads account routes", () => {
  it("rejects unauthenticated account listing", async () => {
    mocks.getCurrentWorkspaceId.mockResolvedValue(null);
    const response = await listThreadsAccounts();
    expect(response.status).toBe(401);
  });

  it("returns only accounts in the active workspace without tokens", async () => {
    mocks.getCurrentWorkspaceId.mockResolvedValue("workspace_1");
    mocks.findMany.mockResolvedValue([
      { id: "account_1", username: "golfrai", threadsUserId: "42" },
    ]);
    const response = await listThreadsAccounts();
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace_1" },
      select: expect.not.objectContaining({ accessToken: true }),
    }));
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { threadsAccounts: [{ id: "account_1" }] },
    });
  });
});
