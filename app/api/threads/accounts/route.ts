import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

export const runtime = "nodejs";

export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const threadsAccounts = await prisma.threadsAccount.findMany({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: {
      id: true,
      username: true,
      threadsUserId: true,
      connectedAt: true,
      tokenExpiresAt: true,
    },
  });
  return NextResponse.json({
    success: true,
    data: {
      threadsAccounts,
      selectedThreadsAccountId: threadsAccounts[0]?.id ?? null,
    },
  });
}
