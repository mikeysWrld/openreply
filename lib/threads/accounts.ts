import { prisma } from "@/lib/db/client";

export async function getWorkspaceThreadsAccount(
  workspaceId: string,
  accountId: string | null
) {
  return prisma.threadsAccount.findFirst({
    where: {
      workspaceId,
      ...(accountId && accountId !== "all" ? { id: accountId } : {}),
    },
    ...(!accountId || accountId === "all"
      ? { orderBy: { connectedAt: "desc" as const } }
      : {}),
  });
}

export async function canConnectThreadsAccount(
  workspaceId: string,
  threadsUserId: string
) {
  const existing = await prisma.threadsAccount.findUnique({
    where: { threadsUserId },
    select: { workspaceId: true },
  });
  return !existing || existing.workspaceId === workspaceId;
}
