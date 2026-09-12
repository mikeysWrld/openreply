import { NextResponse } from "next/server";
import { getBaseUrl, getMissingThreadsOAuthEnv } from "@/lib/env";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { createThreadsOAuthState, getThreadsAuthorizationUrl } from "@/lib/threads/oauth";

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.redirect(`${getBaseUrl()}/login`);
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${getBaseUrl()}/settings?threads=forbidden`);
  }
  const missing = getMissingThreadsOAuthEnv();
  if (missing.length) {
    return NextResponse.redirect(
      `${getBaseUrl()}/settings?threads=misconfigured&missing=${encodeURIComponent(missing.join(","))}`
    );
  }
  const redirectUri = `${getBaseUrl()}/api/threads/callback`;
  return NextResponse.redirect(
    getThreadsAuthorizationUrl(
      redirectUri,
      createThreadsOAuthState(context.workspaceId)
    )
  );
}
