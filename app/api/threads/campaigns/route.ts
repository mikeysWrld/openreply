import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

const campaignFields = {
  name: z.string().trim().min(1).max(100),
  threadsAccountId: z.string().min(1),
  postId: z.string().min(1),
  postUrl: z.string().url(),
  keywords: z.array(z.string().trim().min(1).max(50)).min(1).max(10),
  wholeWordMatch: z.boolean().default(true),
  replyMessage: z.string().trim().min(1).max(500),
  isActive: z.boolean().default(false),
};

const createSchema = z.object(campaignFields);
const updateSchema = z.object({
  name: campaignFields.name.optional(),
  postId: campaignFields.postId.optional(),
  postUrl: campaignFields.postUrl.optional(),
  keywords: campaignFields.keywords.optional(),
  wholeWordMatch: z.boolean().optional(),
  replyMessage: campaignFields.replyMessage.optional(),
  isActive: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const accountId = request.nextUrl.searchParams.get("threadsAccountId");
  const campaigns = await prisma.threadsCampaign.findMany({
    where: {
      workspaceId: context.workspaceId,
      ...(accountId && accountId !== "all" ? { threadsAccountId: accountId } : {}),
    },
    include: {
      threadsAccount: { select: { username: true, threadsUserId: true } },
      _count: { select: { replyLogs: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  const counts = await prisma.threadsReplyLog.groupBy({
    by: ["threadsCampaignId", "status"],
    where: { workspaceId: context.workspaceId },
    _count: { _all: true },
  });
  return NextResponse.json({
    success: true,
    data: campaigns.map((campaign) => ({
      ...campaign,
      analytics: counts
        .filter((row) => row.threadsCampaignId === campaign.id)
        .reduce(
          (result, row) => ({ ...result, [row.status.toLowerCase()]: row._count._all }),
          { pending: 0, sent: 0, failed: 0 }
        ),
    })),
  });
}

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message }, { status: 400 });
  }
  const account = await prisma.threadsAccount.findFirst({
    where: { id: parsed.data.threadsAccountId, workspaceId: context.workspaceId },
    select: { id: true },
  });
  if (!account) {
    return NextResponse.json({ success: false, error: "Threads account not found" }, { status: 400 });
  }
  const campaign = await prisma.threadsCampaign.create({
    data: { workspaceId: context.workspaceId, ...parsed.data },
  });
  return NextResponse.json({ success: true, data: campaign }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  const id = request.nextUrl.searchParams.get("id");
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!id || !parsed.success) return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
  const updated = await prisma.threadsCampaign.updateMany({
    where: { id, workspaceId: context.workspaceId },
    data: parsed.data,
  });
  if (!updated.count) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ success: false, error: "Campaign ID required" }, { status: 400 });
  const deleted = await prisma.threadsCampaign.deleteMany({
    where: { id, workspaceId: context.workspaceId },
  });
  if (!deleted.count) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  return NextResponse.json({ success: true });
}
