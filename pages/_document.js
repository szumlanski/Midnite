import { Html, Head, Main, NextScript } from "next/document";

// Plus Jakarta Sans is loaded once here for every page (index, faq, terms).
export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
        <meta name="theme-color" content="#F7F4EF" />
        {/* PWA: install manifest, home-screen icon, and iOS standalone mode (see public/manifest.webmanifest). */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Sentinel" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="application-name" content="Midnite Sentinel" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
