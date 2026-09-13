import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  getThreadsWebhookQueue,
  THREADS_WEBHOOK_JOB_NAME,
} from "@/lib/queue/client";
import {
  parseThreadsReplyEvents,
  verifyThreadsWebhookSignature,
} from "@/lib/threads/webhook";

function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown error").slice(
    0,
    500,
  );
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (
    mode === "subscribe" &&
    token === process.env.WEBHOOK_VERIFY_TOKEN &&
    challenge !== null
  ) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json(
    { success: false, error: "Verification failed" },
    { status: 403 },
  );
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyThreadsWebhookSignature(rawBody, signature)) {
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  const events = parseThreadsReplyEvents(payload);
  const delivery = await prisma.webhookEvent.create({
    data: {
      object: "threads",
      payload: payload as Prisma.InputJsonValue,
      status: "PENDING",
    },
  });

  if (events.length === 0) {
    await prisma.webhookEvent.update({
      where: { id: delivery.id },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
    return NextResponse.json({ success: true });
  }

  try {
    await getThreadsWebhookQueue().add(
      THREADS_WEBHOOK_JOB_NAME,
      { webhookEventId: delivery.id, events },
      { jobId: `threads_webhook_${delivery.id}` },
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    await prisma.webhookEvent.update({
      where: { id: delivery.id },
      data: {
        status: "FAILED",
        errorMessage: failureMessage(error),
        processedAt: new Date(),
      },
    });
    return NextResponse.json(
      { success: false, error: "Webhook queueing failed" },
      { status: 500 },
    );
  }
}
