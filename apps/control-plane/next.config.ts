import type { NextConfig } from 'next';

const phaseAMobileOrigin = process.env.PHASE_A_FIXTURE_MODE === '1'
  ? process.env.MOBILE_WEB_ORIGIN
  : undefined;

const nextConfig: NextConfig = {
  output: 'standalone',
  experimental: {
    serverActions: {
      bodySizeLimit: '1mb',
    },
  },
  async headers() {
    if (!phaseAMobileOrigin) return [];
    return [{
      source: '/api/:path*',
      headers: [
        { key: 'Access-Control-Allow-Origin', value: phaseAMobileOrigin },
        { key: 'Access-Control-Allow-Credentials', value: 'true' },
        { key: 'Access-Control-Allow-Methods', value: 'GET,POST,DELETE,OPTIONS' },
        { key: 'Access-Control-Allow-Headers', value: 'Accept,Content-Type,Last-Event-ID' },
        { key: 'Vary', value: 'Origin' },
      ],
    }];
  },
};

export default nextConfig;
