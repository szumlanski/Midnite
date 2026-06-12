/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Baked in at build time so the UI can show which build is live (deploy vs cache check).
  env: {
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
    NEXT_PUBLIC_COMMIT: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7),
  },
};

export default nextConfig;
