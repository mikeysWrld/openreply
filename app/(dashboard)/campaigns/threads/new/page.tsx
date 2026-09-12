import Link from "next/link";
import { ThreadsCampaignForm } from "@/components/threads-campaign-form";

export default function NewThreadsCampaignPage() {
  return <div className="mx-auto max-w-3xl space-y-6">
    <div><Link href="/campaigns/threads" className="text-sm text-muted hover:text-foreground">← Threads Campaigns</Link><h1 className="mt-3 text-3xl font-black">New Threads Campaign</h1></div>
    <ThreadsCampaignForm />
  </div>;
}
