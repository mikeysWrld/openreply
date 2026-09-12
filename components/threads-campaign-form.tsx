"use client";

import { useEffect, useState } from "react";
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

export function ThreadsCampaignForm({ campaignId }: { campaignId?: string }) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
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

  useEffect(() => {
    fetch("/api/threads/accounts")
      .then((response) => response.json())
      .then((payload) => {
        const next = payload.data?.threadsAccounts ?? [];
        setAccounts(next);
        if (!campaignId && next[0]) setAccountId(next[0].id);
      });
    if (campaignId) {
      fetch("/api/threads/campaigns")
        .then((response) => response.json())
        .then((payload) => {
          const campaign = payload.data?.find((item: { id: string }) => item.id === campaignId);
          if (!campaign) return;
          setName(campaign.name);
          setAccountId(campaign.threadsAccountId);
          setMatchAnyPost(campaign.matchAnyPost);
          setPostId(campaign.postId ?? "");
          setPostUrl(campaign.postUrl ?? "");
          setKeywords(campaign.keywords.join(", "));
          setReplyMessage(campaign.replyMessage);
          setWholeWordMatch(campaign.wholeWordMatch);
          setIsActive(campaign.isActive);
        });
    }
  }, [campaignId]);

  useEffect(() => {
    let ignore = false;
    if (!accountId || matchAnyPost) return;
    fetch(`/api/threads/posts?threadsAccountId=${encodeURIComponent(accountId)}`)
      .then((response) => response.json())
      .then((payload) => {
        if (!ignore) setPosts(payload.success ? payload.data : []);
      })
      .catch(() => {
        if (!ignore) setError("Could not load Threads posts");
      });
    return () => { ignore = true; };
  }, [accountId, matchAnyPost]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!accountId || (!matchAnyPost && (!postId || !postUrl))) return;
    setSaving(true);
    setError("");
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
    const payload = await response.json();
    if (!payload.success) {
      setError(payload.error ?? "Could not save Threads campaign");
      setSaving(false);
      return;
    }
    router.push("/campaigns/threads");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="panel space-y-6 rounded p-5 sm:p-7">
      <label className="block text-sm font-semibold">Campaign name
        <input className="mt-2 w-full rounded border border-border bg-surface px-4 py-3" value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="block text-sm font-semibold">Threads account
        <select className="mt-2 w-full rounded border border-border bg-surface px-4 py-3" value={accountId} onChange={(e) => { setAccountId(e.target.value); setPostId(""); setPostUrl(""); setPosts([]); setError(""); }} required disabled={Boolean(campaignId)}>
          <option value="">Choose account</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>@{account.username}</option>)}
        </select>
      </label>
      <fieldset>
        <legend className="text-sm font-semibold">Post targeting</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-3 rounded border border-border p-4 text-sm">
            <input type="radio" name="postTarget" value="all" checked={matchAnyPost} onChange={() => { setMatchAnyPost(true); setPostId(""); setPostUrl(""); setPosts([]); setError(""); }} />
            All posts
          </label>
          <label className="flex items-center gap-3 rounded border border-border p-4 text-sm">
            <input type="radio" name="postTarget" value="specific" checked={!matchAnyPost} onChange={() => { setMatchAnyPost(false); setError(""); }} />
            Specific post
          </label>
        </div>
      </fieldset>
      {!matchAnyPost && (
        <label className="block text-sm font-semibold">Threads post
          <select className="mt-2 w-full rounded border border-border bg-surface px-4 py-3" value={postId} onChange={(e) => { const selectedPost = posts.find((post) => post.id === e.target.value); setPostId(e.target.value); setPostUrl(selectedPost?.permalink ?? ""); }} required>
            <option value="">Choose a post</option>
            {posts.map((post) => <option key={post.id} value={post.id}>{post.text?.slice(0, 90) || post.id}</option>)}
          </select>
        </label>
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
      {accounts.length === 0 && <p className="text-sm text-warning">Connect a Threads account in Settings first.</p>}
      {error && <p className="text-sm text-error">{error}</p>}
      <button disabled={saving || !accountId || (!matchAnyPost && (!postId || !postUrl))} className="rounded bg-accent px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Saving…" : "Save Threads campaign"}</button>
    </form>
  );
}
