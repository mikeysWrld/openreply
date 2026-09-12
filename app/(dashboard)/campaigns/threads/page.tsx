"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Campaign = {
  id: string; name: string; matchAnyPost: boolean; postUrl: string | null; keywords: string[]; replyMessage: string;
  isActive: boolean; threadsAccount: { username: string };
  analytics: { pending: number; sent: number; failed: number };
};

export default function ThreadsCampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => fetch("/api/threads/campaigns", { cache: "no-store" })
    .then((r) => r.json()).then((p) => { if (p.success) setCampaigns(p.data); })
    .finally(() => setLoading(false)), []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(campaign: Campaign) {
    await fetch(`/api/threads/campaigns?id=${campaign.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isActive: !campaign.isActive }) });
    await load();
  }

  async function remove(campaign: Campaign) {
    if (!window.confirm(`Delete “${campaign.name}”? Reply history will also be removed.`)) return;
    await fetch(`/api/threads/campaigns?id=${campaign.id}`, { method: "DELETE" });
    await load();
  }

  return <div className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><Link href="/campaigns" className="text-sm text-muted hover:text-foreground">← Campaign channels</Link><h1 className="mt-2 text-3xl font-black">Threads Campaigns</h1><p className="mt-2 text-sm text-muted">Keyword-triggered public replies on your Threads posts.</p></div><Link href="/campaigns/threads/new" className="rounded bg-accent px-4 py-2.5 text-sm font-semibold text-white">New Threads Campaign</Link></div>
    {loading ? <div className="panel h-40 rounded" /> : campaigns.length === 0 ? <div className="panel rounded p-10 text-center"><p className="font-semibold">No Threads campaigns yet</p><p className="mt-2 text-sm text-muted">Connect Threads in Settings, then choose all posts or a specific post to monitor.</p></div> : <div className="space-y-3">{campaigns.map((campaign) => <article key={campaign.id} className="panel rounded p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><h2 className="font-bold">{campaign.name}</h2><span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">@{campaign.threadsAccount.username}</span><span className={campaign.isActive ? "text-xs text-success" : "text-xs text-muted"}>{campaign.isActive ? "Active" : "Paused"}</span></div><div className="mt-3 flex flex-wrap gap-1.5">{campaign.keywords.map((keyword) => <span key={keyword} className="rounded bg-accent/10 px-2 py-1 text-xs text-accent">{keyword}</span>)}</div><p className="mt-3 text-sm text-muted">“{campaign.replyMessage}”</p><p className="mt-3 text-xs text-muted">{campaign.analytics.sent} sent · {campaign.analytics.failed} failed · {campaign.analytics.pending} pending</p></div><div className="flex flex-wrap gap-2">{campaign.matchAnyPost ? <span className="rounded border border-border px-3 py-2 text-xs text-muted">All posts</span> : campaign.postUrl && <a href={campaign.postUrl} target="_blank" rel="noreferrer" className="rounded border border-border px-3 py-2 text-xs">View post</a>}<Link href={`/campaigns/threads/${campaign.id}/edit`} className="rounded border border-border px-3 py-2 text-xs">Edit</Link><button onClick={() => void toggle(campaign)} className="rounded border border-border px-3 py-2 text-xs">{campaign.isActive ? "Pause" : "Activate"}</button><button onClick={() => void remove(campaign)} className="rounded border border-error/40 px-3 py-2 text-xs text-error">Delete</button></div></div></article>)}</div>}
  </div>;
}
