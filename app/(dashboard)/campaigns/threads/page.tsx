"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type Campaign = {
  id: string; name: string; matchAnyPost: boolean; postUrl: string | null; keywords: string[]; replyMessage: string;
  isActive: boolean; threadsAccount: { username: string };
  analytics: { pending: number; sent: number; failed: number };
};

type ApiPayload = { success?: boolean; data?: unknown; error?: string };

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function ThreadsCampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionCampaignId, setActionCampaignId] = useState<string | null>(null);
  const mutationInFlightRef = useRef(false);
  const loadRequestIdRef = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++loadRequestIdRef.current;
    try {
      const response = await fetch("/api/threads/campaigns", { cache: "no-store", signal });
      const payload = await response.json() as ApiPayload;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Could not load Threads campaigns");
      }
      if (!Array.isArray(payload.data)) {
        throw new Error("Could not load Threads campaigns");
      }
      if (requestId !== loadRequestIdRef.current || signal?.aborted) return;
      setLoadError("");
      setCampaigns(payload.data as Campaign[]);
    } catch (loadFailure: unknown) {
      if (requestId !== loadRequestIdRef.current || signal?.aborted) return;
      setLoadError(errorMessage(loadFailure, "Could not load Threads campaigns"));
    } finally {
      if (requestId === loadRequestIdRef.current && !signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => { void load(controller.signal); }, 0);
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
      loadRequestIdRef.current += 1;
    };
  }, [load]);

  function retryLoad() {
    setLoading(true);
    setLoadError("");
    void load();
  }

  async function mutate(campaign: Campaign, method: "PATCH" | "DELETE") {
    if (mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setActionCampaignId(campaign.id);
    setActionError("");
    try {
      const response = await fetch(`/api/threads/campaigns?id=${encodeURIComponent(campaign.id)}`, {
        method,
        ...(method === "PATCH" ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ isActive: !campaign.isActive }),
        } : {}),
      });
      const payload = await response.json() as ApiPayload;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || `Could not ${method === "PATCH" ? "update" : "delete"} Threads campaign`);
      }
      await load();
    } catch (actionFailure: unknown) {
      setActionError(errorMessage(actionFailure, `Could not ${method === "PATCH" ? "update" : "delete"} Threads campaign`));
    } finally {
      mutationInFlightRef.current = false;
      setActionCampaignId(null);
    }
  }

  async function toggle(campaign: Campaign) {
    await mutate(campaign, "PATCH");
  }

  async function remove(campaign: Campaign) {
    if (!window.confirm(`Delete “${campaign.name}”? Reply history will also be removed.`)) return;
    await mutate(campaign, "DELETE");
  }

  return <div className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><Link href="/campaigns" className="text-sm text-muted hover:text-foreground">← Campaign channels</Link><h1 className="mt-2 text-3xl font-black">Threads Campaigns</h1><p className="mt-2 text-sm text-muted">Keyword-triggered public replies on your Threads posts.</p></div><Link href="/campaigns/threads/new" className="rounded bg-accent px-4 py-2.5 text-sm font-semibold text-white">New Threads Campaign</Link></div>
    {actionError && <p role="alert" className="rounded border border-error/40 p-4 text-sm text-error">{actionError}</p>}
    {loading && campaigns.length > 0 && <p role="status" className="text-sm text-muted">Refreshing Threads campaigns…</p>}
    {loadError && campaigns.length > 0 && <div role="alert" className="rounded border border-error/40 p-4 text-sm text-error"><p>{loadError}</p><button type="button" onClick={retryLoad} className="mt-2 rounded border border-border px-3 py-1.5 text-foreground">Retry</button></div>}
    {loading && campaigns.length === 0 ? <div className="panel h-40 rounded" /> : loadError && campaigns.length === 0 ? <div role="alert" className="panel rounded p-10 text-center"><p className="font-semibold text-error">{loadError}</p><button type="button" onClick={retryLoad} className="mt-4 rounded border border-border px-4 py-2 text-sm">Retry</button></div> : campaigns.length === 0 ? <div className="panel rounded p-10 text-center"><p className="font-semibold">No Threads campaigns yet</p><p className="mt-2 text-sm text-muted">Connect Threads in Settings, then choose all posts or a specific post to monitor.</p></div> : null}
    {campaigns.length > 0 && <div className="space-y-3">{campaigns.map((campaign) => <article key={campaign.id} className="panel rounded p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><h2 className="font-bold">{campaign.name}</h2><span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">@{campaign.threadsAccount.username}</span><span className={campaign.isActive ? "text-xs text-success" : "text-xs text-muted"}>{campaign.isActive ? "Active" : "Paused"}</span></div><div className="mt-3 flex flex-wrap gap-1.5">{campaign.keywords.map((keyword) => <span key={keyword} className="rounded bg-accent/10 px-2 py-1 text-xs text-accent">{keyword}</span>)}</div><p className="mt-3 text-sm text-muted">“{campaign.replyMessage}”</p><p className="mt-3 text-xs text-muted">{campaign.analytics.sent} sent · {campaign.analytics.failed} failed · {campaign.analytics.pending} pending</p></div><div className="flex flex-wrap gap-2">{campaign.matchAnyPost ? <span className="rounded border border-border px-3 py-2 text-xs text-muted">All posts</span> : campaign.postUrl && <a href={campaign.postUrl} target="_blank" rel="noreferrer" className="rounded border border-border px-3 py-2 text-xs">View post</a>}<Link href={`/campaigns/threads/${campaign.id}/edit`} className="rounded border border-border px-3 py-2 text-xs">Edit</Link><button type="button" disabled={Boolean(actionCampaignId)} onClick={() => void toggle(campaign)} className="rounded border border-border px-3 py-2 text-xs disabled:opacity-50">{campaign.isActive ? "Pause" : "Activate"}</button><button type="button" disabled={Boolean(actionCampaignId)} onClick={() => void remove(campaign)} className="rounded border border-error/40 px-3 py-2 text-xs text-error disabled:opacity-50">Delete</button></div></div></article>)}</div>}
  </div>;
}
