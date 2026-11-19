import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 頻道資料由 scripts/sync-channels.mjs 產生於 public/channels.json
  // 網站以靜態檔方式提供該 JSON，APK 亦讀取同一份來源產生。
  async headers() {
    return [
      {
        source: '/channels.json',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=60, stale-while-revalidate=300' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
        ],
      },
    ];
  },
};

export default nextConfig;
