import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export const metadata: Metadata = {
  title: "行迹｜旅行笔记",
  description: "记录旅途中的文字与照片，在地图上回看自己的旅行笔记。",
  applicationName: "行迹",
  robots: {
    index: false,
    follow: false
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var s=localStorage.getItem('xingji.atlas-map-style');document.documentElement.dataset.atlasTheme=s==='paper'?'paper':'terrain'}catch(e){document.documentElement.dataset.atlasTheme='terrain'};try{document.documentElement.dataset.uiTheme=localStorage.getItem('xingji.ui-theme')==='dark'?'dark':'light'}catch(e){document.documentElement.dataset.uiTheme='light'}"
          }}
        />
        <link rel="preload" as="image" href="/textures/linen-board.webp" type="image/webp" />
        <link rel="preload" as="image" href="/textures/paper-cotton.webp" type="image/webp" />
        <link rel="preload" as="image" href="/textures/corner-sage.webp" type="image/webp" />
        <link rel="preload" as="image" href="/textures/corner-khaki.webp" type="image/webp" />
      </head>
      <body>{children}</body>
    </html>
  );
}
