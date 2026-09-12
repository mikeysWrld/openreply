"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const DEFAULT_KEYWORDS = [
  "golfr",
  "golf",
  "interested",
  "cool",
  "website",
  "golfer",
  "free",
];
const DEFAULT_REPLY = "感謝你的關注！立即加入 Beta 測試名單：https://golfr.ai/";

type Account = { id: string; username: string };
type Post = { id: string; text?: string; permalink?: string };
type CampaignDetails = {
  id: string;
  name: string;
  threadsAccountId: string;
  matchAnyPost: boolean;
  postId: string | null;
  postUrl: string | null;
  keywords: string[];
  replyMessage: string;
  wholeWordMatch: boolean;
  isActive: boolean;
};
type ApiPayload = { success?: boolean; data?: unknown; error?: string };

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function ThreadsCampaignForm({ campaignId }: { campaignId?: string }) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState("");
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState("");
  const [campaignLoading, setCampaignLoading] = useState(Boolean(campaignId));
  const [campaignLoadError, setCampaignLoadError] = useState("");
  const [accountsAttempt, setAccountsAttempt] = useState(0);
  const [campaignAttempt, setCampaignAttempt] = useState(0);
  const [postsAttempt, setPostsAttempt] = useState(0);
  const [name, setName] = useState("Threads 公開回覆");
  const [accountId, setAccountId] = useState("");
  const [matchAnyPost, setMatchAnyPost] = useState(true);
  const [postId, setPostId] = useState("");
  const [postUrl, setPostUrl] = useState("");
  const [keywords, setKeywords] = useState(DEFAULT_KEYWORDS.join(", "));
  const [replyMessage, setReplyMessage] = useState(DEFAULT_REPLY);
  const [wholeWordMatch, setWholeWordMatch] = useState(true);
  const [isActive, setIsActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submitInFlightRef = useRef(false);

  useEffect(() => {
    let ignore = false;

    async function loadAccounts() {
      setAccountsLoading(true);
      setAccountsError("");
      try {
        const response = await fetch("/api/threads/accounts");
        const payload = await response.json() as ApiPayload;
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || "Could not load Threads accounts");
        }
        const next = (payload.data as { threadsAccounts?: unknown } | undefined)?.threadsAccounts;
        if (!Array.isArray(next)) {
          throw new Error("Could not load Threads accounts");
        }
        if (!ignore) {
          setAccounts(next as Account[]);
          if (!campaignId && next[0]) setAccountId((next[0] as Account).id);
        }
      } catch (loadError: unknown) {
        if (!ignore) {
          setAccounts([]);
          setAccountsError(errorMessage(loadError, "Could not load Threads accounts"));
        }
      } finally {
        if (!ignore) setAccountsLoading(false);
      }
    }

    void loadAccounts();
    return () => { ignore = true; };
  }, [campaignId, accountsAttempt]);

  useEffect(() => {
    let ignore = false;

    async function loadCampaign() {
      if (!campaignId) return;
      setCampaignLoading(true);
      setCampaignLoadError("");
      try {
        const response = await fetch("/api/threads/campaigns", { cache: "no-store" });
        const payload = await response.json() as ApiPayload;
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || "Could not load Threads campaign");
        }
        if (!Array.isArray(payload.data)) {
          throw new Error("Could not load Threads campaign");
        }
        const campaign = payload.data.find((item) => (item as { id?: string }).id === campaignId) as CampaignDetails | undefined;
        if (!campaign) {
          throw new Error("Threads campaign not found");
        }
        if (!ignore) {
          setName(campaign.name);
          setAccountId(campaign.threadsAccountId);
          setMatchAnyPost(campaign.matchAnyPost);
          setPostId(campaign.postId ?? "");
          setPostUrl(campaign.postUrl ?? "");
          setPostsLoading(!campaign.matchAnyPost && Boolean(campaign.threadsAccountId));
          setPostsError("");
          setKeywords(campaign.keywords.join(", "));
          setReplyMessage(campaign.replyMessage);
          setWholeWordMatch(campaign.wholeWordMatch);
          setIsActive(campaign.isActive);
        }
      } catch (loadError: unknown) {
        if (!ignore) {
          setCampaignLoadError(errorMessage(loadError, "Could not load Threads campaign"));
        }
      } finally {
        if (!ignore) setCampaignLoading(false);
      }
    }

    void loadCampaign();
    return () => { ignore = true; };
  }, [campaignId, campaignAttempt]);

  useEffect(() => {
    let ignore = false;
    if (!accountId || matchAnyPost) return;
    fetch(`/api/threads/posts?threadsAccountId=${encodeURIComponent(accountId)}`)
      .then(async (response) => {
        const payload = await response.json() as ApiPayload;
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || "Could not load Threads posts");
        }
        if (!Array.isArray(payload.data)) {
          throw new Error("Could not load Threads posts");
        }
        return payload.data as Post[];
      })
      .then((nextPosts) => {
        if (!ignore) {
          setPosts(nextPosts);
          setPostsError("");
        }
      })
      .catch((loadError: unknown) => {
        if (!ignore) {
          setPostsError(loadError instanceof Error ? loadError.message : "Could not load Threads posts");
        }
      })
      .finally(() => {
        if (!ignore) setPostsLoading(false);
      });
    return () => { ignore = true; };
  }, [accountId, matchAnyPost, postsAttempt]);

  function retryPosts() {
    setPostsLoading(true);
    setPostsError("");
    setPostsAttempt((attempt) => attempt + 1);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitInFlightRef.current) return;
    if (saving) return;
    if (!accountId || (!matchAnyPost && (!postId || !postUrl))) return;
    submitInFlightRef.current = true;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(
        `/api/threads/campaigns${campaignId ? `?id=${encodeURIComponent(campaignId)}` : ""}`,
        {
          method: campaignId ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            ...(campaignId ? {} : { threadsAccountId: accountId }),
            matchAnyPost,
            postId: matchAnyPost ? null : postId,
            postUrl: matchAnyPost ? null : postUrl,
            keywords: keywords.split(",").map((value) => value.trim()).filter(Boolean),
            wholeWordMatch,
            replyMessage,
            isActive,
          }),
        }
      );
      const payload = await response.json() as ApiPayload;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Could not save Threads campaign");
      }
      router.push("/campaigns/threads");
      router.refresh();
    } catch (saveError: unknown) {
      setError(errorMessage(saveError, "Could not save Threads campaign"));
      submitInFlightRef.current = false;
      setSaving(false);
    }
  }

  if (campaignLoading) {
    return <div className="panel h-40 rounded" aria-label="Loading Threads campaign" />;
  }

  if (campaignLoadError) {
    return <div role="alert" className="panel rounded p-6 text-sm text-error">
      <p>{campaignLoadError}</p>
      <button type="button" onClick={() => setCampaignAttempt((attempt) => attempt + 1)} className="mt-4 rounded border border-border px-4 py-2 text-foreground">Retry</button>
    </div>;
  }

  return (
    <form onSubmit={submit} className="panel space-y-6 rounded p-5 sm:p-7">
      <label className="block text-sm font-semibold">Campaign name
        <input className="mt-2 w-full rounded border border-border bg-surface px-4 py-3" value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="block text-sm font-semibold">Threads account
        <select className="mt-2 w-full rounded border border-border bg-surface px-4 py-3" value={accountId} onChange={(e) => { const nextAccountId = e.target.value; setAccountId(nextAccountId); setPostId(""); setPostUrl(""); setPosts([]); setPostsLoading(Boolean(nextAccountId) && !matchAnyPost); setPostsError(""); setError(""); }} required disabled={Boolean(campaignId) || accountsLoading || Boolean(accountsError)}>
          <option value="">Choose account</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>@{account.username}</option>)}
        </select>
      </label>
      <fieldset>
        <legend className="text-sm font-semibold">Post targeting</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-3 rounded border border-border p-4 text-sm">
            <input type="radio" name="postTarget" value="all" checked={matchAnyPost} onChange={() => { setMatchAnyPost(true); setPostId(""); setPostUrl(""); setPosts([]); setPostsLoading(false); setPostsError(""); setError(""); }} />
            All posts
          </label>
          <label className="flex items-center gap-3 rounded border border-border p-4 text-sm">
            <input type="radio" name="postTarget" value="specific" checked={!matchAnyPost} onChange={() => { setMatchAnyPost(false); setPostsLoading(Boolean(accountId)); setPostsError(""); setError(""); }} />
            Specific post
          </label>
        </div>
      </fieldset>
      {!matchAnyPost && (
        <div>
          <label className="block text-sm font-semibold">Threads post
            <select className="mt-2 w-full rounded border border-border bg-surface px-4 py-3" value={postId} onChange={(e) => { const selectedPost = posts.find((post) => post.id === e.target.value); setPostId(e.target.value); setPostUrl(selectedPost?.permalink ?? ""); }} required disabled={postsLoading}>
              <option value="">{postsLoading ? "Loading posts…" : "Choose a post"}</option>
              {posts.map((post) => <option key={post.id} value={post.id}>{post.text?.slice(0, 90) || post.id}</option>)}
            </select>
          </label>
          {postsLoading && <span role="status" className="mt-2 block text-xs font-normal text-muted">Loading Threads posts…</span>}
          {postsError && <span role="alert" className="mt-2 block text-xs font-normal text-error">{postsError}<button type="button" onClick={retryPosts} className="ml-2 rounded border border-border px-2 py-1 text-foreground">Retry</button></span>}
          {accountId && !postsLoading && !postsError && posts.length === 0 && <span aria-live="polite" className="mt-2 block text-xs font-normal text-muted">No Threads posts found. Publish a Threads post first.</span>}
        </div>
      )}
      <label className="block text-sm font-semibold">Keywords
        <input className="mt-2 w-full rounded border border-border bg-surface px-4 py-3" value={keywords} onChange={(e) => setKeywords(e.target.value)} required />
        <span className="mt-1 block text-xs font-normal text-muted">Separate keywords with commas.</span>
      </label>
      <label className="block text-sm font-semibold">Public reply
        <textarea className="mt-2 min-h-28 w-full rounded border border-border bg-surface px-4 py-3" value={replyMessage} onChange={(e) => setReplyMessage(e.target.value)} maxLength={500} required />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-3 rounded border border-border p-4 text-sm"><input type="checkbox" checked={wholeWordMatch} onChange={(e) => setWholeWordMatch(e.target.checked)} /> Match whole words</label>
        <label className="flex items-center gap-3 rounded border border-border p-4 text-sm"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Activate immediately</label>
      </div>
      {accountsError && <div role="alert" className="text-sm text-error"><p>{accountsError}</p><button type="button" onClick={() => setAccountsAttempt((attempt) => attempt + 1)} className="mt-2 rounded border border-border px-3 py-1.5 text-foreground">Retry</button></div>}
      {!accountsLoading && !accountsError && accounts.length === 0 && <p className="text-sm text-warning">Connect a Threads account in Settings first.</p>}
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
      <button disabled={saving || accountsLoading || Boolean(accountsError) || !accountId || (!matchAnyPost && (!postId || !postUrl))} className="rounded bg-accent px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Saving…" : "Save Threads campaign"}</button>
    </form>
  );
}
