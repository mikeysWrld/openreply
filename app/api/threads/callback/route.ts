import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { encryptToken } from "@/lib/meta/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";
import { canConnectThreadsAccount } from "@/lib/threads/accounts";
import { getThreadsProfile } from "@/lib/threads/client";
import {
  exchangeLongLivedThreadsToken,
  exchangeThreadsCode,
  verifyThreadsOAuthState,
} from "@/lib/threads/oauth";

export async function GET(request: NextRequest) {
  const baseUrl = getBaseUrl();
  if (request.nextUrl.searchParams.get("error")) {
    return NextResponse.redirect(`${baseUrl}/settings?threads=denied`);
  }
  const code = request.nextUrl.searchParams.get("code");
  const state = verifyThreadsOAuthState(request.nextUrl.searchParams.get("state"));
  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl}/settings?threads=invalid`);
  }
  const session = await auth();
  if (!session?.user?.id) return NextResponse.redirect(`${baseUrl}/login`);
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: state.workspaceId, userId: session.user.id },
  });
  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/settings?threads=forbidden`);
  }

  try {
    const redirectUri = `${baseUrl}/api/threads/callback`;
    const short = await exchangeThreadsCode(code, redirectUri);
    const long = await exchangeLongLivedThreadsToken(short.accessToken);
    const profile = await getThreadsProfile(long.accessToken);
    if (!(await canConnectThreadsAccount(state.workspaceId, profile.id))) {
      return NextResponse.redirect(`${baseUrl}/settings?threads=already_connected`);
    }
    await prisma.threadsAccount.upsert({
      where: { threadsUserId: profile.id },
      create: {
        workspaceId: state.workspaceId,
        threadsUserId: profile.id,
        username: profile.username,
        accessToken: encryptToken(long.accessToken),
        tokenExpiresAt: new Date(Date.now() + long.expiresIn * 1000),
      },
      update: {
        username: profile.username,
        accessToken: encryptToken(long.accessToken),
        tokenExpiresAt: new Date(Date.now() + long.expiresIn * 1000),
      },
    });
    return NextResponse.redirect(`${baseUrl}/settings?threads=connected`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown error";
    await prisma.operationalEvent.create({
      data: {
        source: "SYSTEM",
        level: "ERROR",
        workspaceId: state.workspaceId,
        message: "Threads connection failed",
        payload: { reason },
      },
    }).catch(() => {});
    return NextResponse.redirect(
      `${baseUrl}/settings?threads=failed&reason=${encodeURIComponent(reason.slice(0, 200))}`
    );
  }
}
