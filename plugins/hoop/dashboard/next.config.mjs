/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output bakes the minimal runtime tree under .next/standalone.
  // The Docker runtime stage copies that and runs `node server.js` — no
  // npm install at runtime.
  output: "standalone",
  // Required in Next 14 to make `instrumentation.ts` run at server boot
  // (auto-enabled in Next 15). Used to prime the sandbox client + register
  // the shutdown drainer.
  experimental: {
    instrumentationHook: true,
  },
};

export default nextConfig;
