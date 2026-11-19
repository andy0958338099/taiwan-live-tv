import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '台灣電視直播 | Taiwan Live TV',
  description:
    '台灣電視頻道直播平台：分類瀏覽、搜尋、收藏與最近觀看紀錄。頻道清單皆標註來源與授權狀態。',
  keywords: ['台灣電視', '直播', 'Taiwan Live TV', 'HLS', '電視頻道'],
  openGraph: {
    title: '台灣電視直播',
    description: '台灣電視頻道直播平台',
    type: 'website',
    locale: 'zh_TW',
  },
};

export const viewport: Viewport = {
  themeColor: '#0b0b0f',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant-TW">
      <body>{children}</body>
    </html>
  );
}
