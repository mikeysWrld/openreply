import Link from "next/link";
import { ThreadsCampaignForm } from "@/components/threads-campaign-form";

export default async function EditThreadsCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div className="mx-auto max-w-3xl space-y-6">
    <div><Link href="/campaigns/threads" className="text-sm text-muted hover:text-foreground">← Threads Campaigns</Link><h1 className="mt-3 text-3xl font-black">Edit Threads Campaign</h1></div>
    <ThreadsCampaignForm campaignId={id} />
  </div>;
}
