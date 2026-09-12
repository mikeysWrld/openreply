import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { decryptToken } from "@/lib/meta/oauth";
import { getWorkspaceThreadsAccount } from "@/lib/threads/accounts";
import { getOwnedThreads } from "@/lib/threads/client";

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const account = await getWorkspaceThreadsAccount(
    workspaceId,
    request.nextUrl.searchParams.get("threadsAccountId")
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Threads account not connected" },
      { status: 400 }
    );
  }
  try {
    const posts = await getOwnedThreads(decryptToken(account.accessToken), 100);
    return NextResponse.json({ success: true, data: posts });
  } catch (error) {
    console.error("[Threads Posts] Failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch Threads posts" },
      { status: 500 }
    );
  }
}
