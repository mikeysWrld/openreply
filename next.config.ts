import type { NextConfig } from "next";

const contentSecurityPolicy = [
  "default-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // Next.js emits inline bootstrap scripts during server rendering. A nonce-
  // based policy would force every route dynamic, so inline scripts are the
  // narrow compatibility concession here; eval and third-party scripts remain
  // blocked.
  "script-src 'self' 'unsafe-inline'",
  // React inline style props and Next.js-generated styles require inline CSS.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.cdninstagram.com https://*.fbcdn.net",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob: https://*.cdninstagram.com https://*.fbcdn.net",
].join("; ");

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
