import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getThreadsPostDetails, ThreadsApiError } from "@/lib/threads/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

const campaignFields = {
  name: z.string().trim().min(1).max(100),
  threadsAccountId: z.string().min(1),
  keywords: z.array(z.string().trim().min(1).max(50)).min(1).max(10),
  wholeWordMatch: z.boolean().default(true),
  replyMessage: z.string().trim().min(1).max(500),
  isActive: z.boolean().default(false),
};

const threadsPostId = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid Threads post ID");

const targetFields = {
  matchAnyPost: z.boolean(),
  postId: threadsPostId.nullable(),
  postUrl: z.string().nullable().optional(),
};

const createSchema = z.object({
  ...campaignFields,
  ...targetFields,
  matchAnyPost: targetFields.matchAnyPost.default(false),
}).superRefine((data, context) => {
  if (!data.matchAnyPost && !data.postId) {
    context.addIssue({
      code: "custom",
      message: "A post ID is required for a specific-post campaign",
      path: ["postId"],
    });
  }
}).transform((data) => data.matchAnyPost
  ? { ...data, postId: null, postUrl: null, postVerifiedAt: null }
  : data
);

const editableUpdateFields = {
  threadsAccountId: z.never().optional(),
  name: campaignFields.name.optional(),
  keywords: campaignFields.keywords.optional(),
  wholeWordMatch: z.boolean().optional(),
  replyMessage: campaignFields.replyMessage.optional(),
  isActive: z.boolean().optional(),
};

const unchangedTargetSchema = z.object({
  matchAnyPost: z.never().optional(),
  postId: z.never().optional(),
  postUrl: z.never().optional(),
});

const allPostsTargetSchema = z.object({
  matchAnyPost: z.literal(true),
  postId: z.null().optional(),
  postUrl: z.null().optional(),
}).transform((data) => ({
  ...data,
  postId: null,
  postUrl: null,
  postVerifiedAt: null,
}));

const specificPostTargetSchema = z.object({
  matchAnyPost: z.literal(false),
  postId: threadsPostId,
  postUrl: z.string().nullable().optional(),
});

const updateSchema = z.intersection(
  z.object(editableUpdateFields),
  z.union([unchangedTargetSchema, allPostsTargetSchema, specificPostTargetSchema])
);

async function getCanonicalOwnedPostUrl(
  encryptedAccessToken: string,
  threadsUserId: string,
  postId: string
): Promise<string | null> {
  const post = await getThreadsPostDetails(
    decryptToken(encryptedAccessToken),
    postId
  );
  return post.owner.id === threadsUserId ? post.permalink : null;
}

function postNotOwnedResponse() {
  return NextResponse.json(
    { success: false, error: "Threads post not found for this account" },
    { status: 400 }
  );
}

function postVerificationFailedResponse() {
  return NextResponse.json(
    { success: false, error: "Failed to verify Threads post ownership" },
    { status: 502 }
  );
}

function isNotOwnedMetaError(error: unknown): boolean {
  return error instanceof ThreadsApiError &&
    !error.retryable &&
    (error.status === 404 || (error.status === 400 && error.code === 100));
}

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
    select: { id: true, accessToken: true, threadsUserId: true },
  });
  if (!account) {
    return NextResponse.json({ success: false, error: "Threads account not found" }, { status: 400 });
  }
  let postUrl = parsed.data.postUrl;
  if (!parsed.data.matchAnyPost) {
    try {
      postUrl = await getCanonicalOwnedPostUrl(
        account.accessToken,
        account.threadsUserId,
        parsed.data.postId!
      );
    } catch (error) {
      if (isNotOwnedMetaError(error)) return postNotOwnedResponse();
      console.error("[Threads Campaigns] Failed to verify post ownership");
      return postVerificationFailedResponse();
    }
    if (!postUrl) return postNotOwnedResponse();
  }
  const campaign = await prisma.threadsCampaign.create({
    data: {
      workspaceId: context.workspaceId,
      ...parsed.data,
      activatedAt: parsed.data.isActive ? new Date() : null,
      postUrl,
      postVerifiedAt: parsed.data.matchAnyPost ? null : new Date(),
    },
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
  let updateData: Prisma.ThreadsCampaignUpdateManyMutationInput = parsed.data;
  let updateWhere: Prisma.ThreadsCampaignWhereInput = {
    id,
    workspaceId: context.workspaceId,
  };
  let guardedActivation = false;
  const suppliesSpecificTarget = parsed.data.matchAnyPost === false;
  const requestsActivation = parsed.data.isActive === true;
  const activatesExistingTarget =
    parsed.data.matchAnyPost === undefined && requestsActivation;
  if (suppliesSpecificTarget || requestsActivation) {
    const campaign = await prisma.threadsCampaign.findFirst({
      where: { id, workspaceId: context.workspaceId },
      select: {
        id: true,
        isActive: true,
        matchAnyPost: true,
        postId: true,
        threadsAccount: {
          select: { accessToken: true, threadsUserId: true },
        },
      },
    });
    if (!campaign) {
      return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
    }

    if (requestsActivation && !campaign.isActive) {
      updateData = { ...updateData, activatedAt: new Date() };
    }

    if (activatesExistingTarget) {
      guardedActivation = true;
      updateWhere = {
        ...updateWhere,
        matchAnyPost: campaign.matchAnyPost,
        postId: campaign.postId,
      };
    }

    if (suppliesSpecificTarget || !campaign.matchAnyPost) {
      const postId = suppliesSpecificTarget ? parsed.data.postId : campaign.postId;
      if (!postId) {
        return NextResponse.json(
          { success: false, error: "Specific-post campaign is missing a post ID" },
          { status: 400 }
        );
      }

      let postUrl: string | null;
      try {
        postUrl = await getCanonicalOwnedPostUrl(
          campaign.threadsAccount.accessToken,
          campaign.threadsAccount.threadsUserId,
          postId
        );
      } catch (error) {
        if (isNotOwnedMetaError(error)) return postNotOwnedResponse();
        console.error("[Threads Campaigns] Failed to verify post ownership");
        return postVerificationFailedResponse();
      }
      if (!postUrl) return postNotOwnedResponse();
      updateData = { ...updateData, postUrl, postVerifiedAt: new Date() };
    }
  }
  const updated = await prisma.threadsCampaign.updateMany({
    where: updateWhere,
    data: updateData,
  });
  if (!updated.count && guardedActivation) {
    return NextResponse.json(
      { success: false, error: "Campaign target changed; retry activation" },
      { status: 409 }
    );
  }
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
