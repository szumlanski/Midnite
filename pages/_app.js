import { useEffect } from "react";
import "@/styles/globals.css";
import { AlertHost } from "@/components/ui/Alert";

export default function App({ Component, pageProps }) {
  // Service worker (public/sw.js): install + push + offline page, no data caching. Production only so
  // `next dev` never serves stale bundles through a worker.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const register = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    if (document.readyState === "complete") register();
    else { window.addEventListener("load", register, { once: true }); return () => window.removeEventListener("load", register); }
  }, []);

  return (
    <>
      <Component {...pageProps} />
      <AlertHost />
    </>
  );
}
