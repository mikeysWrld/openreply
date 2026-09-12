import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("campaign channel navigation", () => {
  it("separates Instagram and Threads campaigns", () => {
    const hub = readFileSync("app/(dashboard)/campaigns/page.tsx", "utf8");
    expect(hub).toContain("Instagram Campaigns");
    expect(hub).toContain("Threads Campaigns");
    expect(existsSync("app/(dashboard)/campaigns/instagram/page.tsx")).toBe(true);
    expect(existsSync("app/(dashboard)/campaigns/threads/page.tsx")).toBe(true);
  });

  it("defaults the Threads form to the approved campaign", () => {
    const form = readFileSync("components/threads-campaign-form.tsx", "utf8");
    for (const keyword of ["golfr", "golf", "interested", "cool", "website", "golfer", "free"]) {
      expect(form).toContain(`"${keyword}"`);
    }
    expect(form).toContain("感謝你的關注！立即加入 Beta 測試名單：https://golfr.ai/");
  });

  it("targets all posts by default and offers an accessible specific-post option", () => {
    const form = readFileSync("components/threads-campaign-form.tsx", "utf8");
    expect(form).toContain("useState(true)");
    expect(form).toContain('name="postTarget"');
    expect(form).toContain("All posts");
    expect(form).toContain("Specific post");
    expect(form).toContain("campaign.matchAnyPost");
    expect(form).toContain('campaign.postId ?? ""');
    expect(form).toContain("matchAnyPost &&");
  });

  it("submits an atomic all-posts or specific-post target", () => {
    const form = readFileSync("components/threads-campaign-form.tsx", "utf8");
    expect(form).toContain("matchAnyPost,");
    expect(form).toContain("postId: matchAnyPost ? null : postId");
    expect(form).toContain("postUrl: matchAnyPost ? null : postUrl");
    expect(form).toContain("if (saving) return;");
    expect(form).toContain("!matchAnyPost && (!postId || !postUrl)");
  });

  it("preserves a specific campaign post URL before owned posts load", () => {
    const form = readFileSync("components/threads-campaign-form.tsx", "utf8");
    expect(form).toContain('const [postUrl, setPostUrl] = useState("")');
    expect(form).toContain('setPostUrl(campaign.postUrl ?? "")');
    expect(form).toContain("setPostUrl(selectedPost?.permalink ?? \"\")");
    expect(form).toContain('setPostId(""); setPostUrl("")');
  });

  it("only fetches and renders owned posts for specific-post targeting", () => {
    const form = readFileSync("components/threads-campaign-form.tsx", "utf8");
    expect(form).toContain("if (!accountId || matchAnyPost)");
    expect(form).toContain("}, [accountId, matchAnyPost])");
    expect(form).toContain("{!matchAnyPost && (");
  });

  it("surfaces owned-post API failures separately from save errors", () => {
    const form = readFileSync("components/threads-campaign-form.tsx", "utf8");
    expect(form).toContain('const [postsError, setPostsError] = useState("")');
    expect(form).toContain("!response.ok || !payload.success");
    expect(form).toContain('payload.error || "Could not load Threads posts"');
    expect(form).toContain('setPostsError("")');
    expect(form).toContain("setPosts([])");
  });

  it("shows post loading and empty states with accessible errors", () => {
    const form = readFileSync("components/threads-campaign-form.tsx", "utf8");
    expect(form).toContain("postsLoading");
    expect(form).toContain("Loading posts…");
    expect(form).toContain("disabled={postsLoading}");
    expect(form).toContain("accountId && !postsLoading && !postsError && posts.length === 0");
    expect(form).toContain("Publish a Threads post first");
    expect(form).toContain('role="alert"');
    expect(form).toContain('aria-live="polite"');
  });

  it("lets managers delete a Threads campaign", () => {
    const list = readFileSync("app/(dashboard)/campaigns/threads/page.tsx", "utf8");
    expect(list).toContain('method: "DELETE"');
    expect(list).toContain("Delete");
  });

  it("labels all-post campaigns without linking to a post", () => {
    const list = readFileSync("app/(dashboard)/campaigns/threads/page.tsx", "utf8");
    expect(list).toContain("matchAnyPost: boolean");
    expect(list).toContain("postUrl: string | null");
    expect(list).toContain('campaign.matchAnyPost ? <span');
    expect(list).toContain("All posts");
    expect(list).toContain("campaign.postUrl && <a");
    expect(list).toContain("choose all posts or a specific post");
  });
});
