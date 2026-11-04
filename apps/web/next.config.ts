import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NextConfig } from 'next';

// The whole repo shares one `.env` at the root (created by `pnpm env:init`).
const rootEnv = join(import.meta.dirname, '..', '..', '.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const apiUrl = process.env.MO_API_URL ?? 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Dev only: Next blocks dev assets for hostnames other than `localhost`. This project binds
  // everything to 127.0.0.1 (docs/10), so allow exactly that hostname. No effect in production.
  allowedDevOrigins: ['127.0.0.1'],
  // Hide the floating dev badge (keeps demo screenshots clean). Errors still show as overlays.
  devIndicators: false,
  // Browser calls `/api/*` on the web origin; Next.js forwards them to the NestJS API.
  // Cookies stay first-party and no CORS configuration is needed (docs/02, section 7).
  async rewrites() {
    return Promise.resolve([{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }]);
  },
};

export default nextConfig;
