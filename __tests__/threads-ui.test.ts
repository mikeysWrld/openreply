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
});
