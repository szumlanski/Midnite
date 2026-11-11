// Browser-side Web Push helpers. The server side (VAPID keys, storing subscriptions, sending) lives
// elsewhere; these only talk to the service worker registered from pages/_app.js (public/sw.js).
//
// iOS / iPadOS: Web Push works only inside the app installed to the Home Screen (iOS 16.4+). In a Safari
// tab `PushManager` is missing, so pushSupported() returns false there. Ask users to install first.
// Permission must be requested from a user gesture (a button tap), so call subscribePush() from a click.

export function pushSupported() {
  if (typeof window === "undefined") return false;
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

// True when running as the installed app (Home Screen / standalone window).
export function isStandalone() {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  } catch { return false; }
}

async function registration() {
  // Waits for the service worker registered in _app.js. Resolves only once one is active.
  return navigator.serviceWorker.ready;
}

function urlBase64ToUint8Array(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// The current PushSubscription as JSON ({endpoint, expirationTime, keys:{p256dh, auth}}), or null.
export async function getSubscription() {
  if (!pushSupported()) return null;
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  return sub ? sub.toJSON() : null;
}

// Ask for permission (if needed) and subscribe. Returns the PushSubscription JSON.
// Throws an Error with a readable message when unsupported or permission is denied.
export async function subscribePush(vapidPublicKey) {
  if (!pushSupported()) throw new Error("Push notifications are not supported here. On iPhone, add the app to your Home Screen first.");
  if (!vapidPublicKey) throw new Error("Missing VAPID public key.");
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") throw new Error(perm === "denied" ? "Notifications are blocked. Turn them on in your browser or system settings." : "Notification permission was not granted.");
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
  }
  return sub.toJSON();
}

// Unsubscribe this browser. Returns the endpoint that was removed (so the server can delete it), or null.
export async function unsubscribePush() {
  if (!pushSupported()) return null;
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}
