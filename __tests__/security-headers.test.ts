import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("global security response headers", () => {
  it("applies a production-safe baseline to every route", async () => {
    expect(nextConfig.headers).toBeTypeOf("function");

    const rules = await nextConfig.headers!();
    const catchAll = rules.find((rule) => rule.source === "/(.*)");
    const headers = new Map(
      catchAll?.headers.map(({ key, value }) => [key.toLowerCase(), value])
    );

    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin"
    );
    expect(headers.get("permissions-policy")).toContain("camera=()");
    expect(headers.get("permissions-policy")).toContain("microphone=()");
    expect(headers.get("permissions-policy")).toContain("geolocation=()");
  });

  it("enforces a narrow CSP without blocking Next.js or Instagram media", async () => {
    const rules = await nextConfig.headers!();
    const csp = rules
      .find((rule) => rule.source === "/(.*)")
      ?.headers.find(
        ({ key }) => key.toLowerCase() === "content-security-policy"
      )?.value;

    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain(
      "img-src 'self' data: blob: https://*.cdninstagram.com https://*.fbcdn.net"
    );
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain(
      "media-src 'self' blob: https://*.cdninstagram.com https://*.fbcdn.net"
    );
  });
});
