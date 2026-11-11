// "Install the app" banner. Bottom of the screen, above the phone tab bar and the home indicator.
// - Chrome / Edge / Android: captures `beforeinstallprompt` and shows a real Install button.
// - iPhone / iPad: no install API exists, so it explains Share, then Add to Home Screen (with the share glyph).
// - Hidden when already running as the installed app, and once dismissed (remembered in localStorage).
// Styling: .ui-install in styles/globals.css.
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { Button, IconButton } from "./Button";
import { Logo } from "./Logo";

const DISMISS_KEY = "midnite_install_hint_dismissed";
const SHOW_DELAY_MS = 2500;

// The browser can fire beforeinstallprompt before the dashboard mounts, so listen from module load.
let deferredPrompt = null;
const promptListeners = new Set();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep Chrome's mini-infobar away; we show our own banner
    deferredPrompt = e;
    promptListeners.forEach((fn) => fn(e));
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    try { localStorage.setItem(DISMISS_KEY, "installed"); } catch { /* storage blocked */ }
    promptListeners.forEach((fn) => fn(null));
  });
}

function isStandalone() {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  } catch { return false; }
}

function isIOS() {
  const ua = navigator.userAgent || "";
  // iPadOS 13+ reports itself as a Mac; touch support gives it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function wasDismissed() {
  try { return !!localStorage.getItem(DISMISS_KEY); } catch { return false; }
}

export function InstallHint({ enabled = true }) {
  const [mode, setMode] = useState(null); // null | "prompt" | "ios"
  const [ready, setReady] = useState(false); // the 2.5 s delay has passed
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled || isStandalone() || wasDismissed()) return;
    const pick = (e) => setMode(e ? "prompt" : isIOS() ? "ios" : null);
    pick(deferredPrompt);
    promptListeners.add(pick);
    const t = setTimeout(() => setReady(true), SHOW_DELAY_MS);
    return () => { promptListeners.delete(pick); clearTimeout(t); };
  }, [enabled]);

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* storage blocked */ }
    setMode(null);
  };

  const install = async () => {
    const e = deferredPrompt;
    if (!e) return dismiss();
    setBusy(true);
    try {
      await e.prompt();
      const choice = await e.userChoice;
      deferredPrompt = null; // a prompt event can only be used once
      if (choice?.outcome === "accepted") {
        try { localStorage.setItem(DISMISS_KEY, "installed"); } catch { /* storage blocked */ }
      }
      setMode(null);
    } catch {
      setMode(null);
    } finally {
      setBusy(false);
    }
  };

  if (!enabled || !ready || !mode) return null;

  return (
    <aside className="ui-install" aria-label="Install Midnite Sentinel">
      <span className="ui-install-logo" aria-hidden="true"><Logo size={40} /></span>
      <div className="ui-install-text">
        <div className="ui-install-title">Install Midnite Sentinel</div>
        {mode === "ios" ? (
          <div className="ui-install-sub">
            Tap <span className="ui-install-glyph"><Icon name="share" /></span> Share, then
            {" "}<strong>Add to Home Screen</strong>. iPhone alerts need the installed app.
          </div>
        ) : (
          <div className="ui-install-sub">Open it from your home screen in its own window, without the browser bar.</div>
        )}
        {mode === "prompt" && (
          <div className="ui-install-actions">
            <Button variant="primary" size="sm" icon="download" onClick={install} disabled={busy}>Install</Button>
            <Button variant="plain" size="sm" onClick={dismiss}>Not now</Button>
          </div>
        )}
      </div>
      <IconButton icon="x" label="Dismiss" className="ui-install-close" onClick={dismiss} />
    </aside>
  );
}
