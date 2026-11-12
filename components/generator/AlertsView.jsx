// Generator > Alerts: this user's email/push toggles for this site, plus push on this device.
// Push server actions (pushKey, pushSubscribe, pushUnsubscribe, pushTest) may not be deployed yet:
// a 404/400 shows a friendly "not available yet" note instead of an error.
import { useEffect, useState } from "react";
import { Button, Switch } from "@/components/ui/Button";
import { toast } from "@/components/ui/Alert";
import { TEXT, MUTED, FS } from "@/components/ui/tokens";
import { pushSupported, isStandalone, getSubscription, subscribePush, unsubscribePush } from "@/lib/push/client";
import { genApi, Card, ErrorNote, InfoNote } from "./shared";

const NOT_READY = "Push alerts aren't switched on for the app yet. Email alerts work now.";
const notReady = (e) => e?.status === 404 || e?.status === 400;
const isIOS = () => typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent || "") ;
// navigator.serviceWorker.ready never resolves without a worker: give up after 3 s.
const withTimeout = (p, ms = 3000) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

export function AlertsView({ state, siteKey, onChanged }) {
  const prefs = state.alerts || { email: true, push: true };
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [dev, setDev] = useState({ checked: false, sub: null });
  const [pushNote, setPushNote] = useState(null);

  const supported = typeof window !== "undefined" && pushSupported();
  const needsInstall = !supported && isIOS() && !isStandalone();

  useEffect(() => {
    let alive = true;
    if (!supported) { setDev({ checked: true, sub: null }); return; }
    withTimeout(getSubscription().catch(() => null)).then((sub) => { if (alive) setDev({ checked: true, sub }); });
    return () => { alive = false; };
  }, [supported]);

  async function setPref(k, v) {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await genApi("setAlerts", { site_key: siteKey, [k]: v }); toast(`${k === "email" ? "Email" : "Push"} alerts ${v ? "on" : "off"}`); await onChanged?.(false); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function enablePush() {
    if (busy) return;
    setBusy(true); setErr(null); setPushNote(null);
    try {
      const { publicKey } = await genApi("pushKey", { site_key: siteKey });
      const sub = await subscribePush(publicKey);
      await genApi("pushSubscribe", { site_key: siteKey, subscription: sub });
      setDev({ checked: true, sub });
      toast("Push alerts on for this device");
    } catch (e) {
      if (notReady(e)) setPushNote(NOT_READY); else setErr(e.message);
    } finally { setBusy(false); }
  }
  async function disablePush() {
    if (busy) return;
    setBusy(true); setErr(null); setPushNote(null);
    try {
      const endpoint = await unsubscribePush();
      setDev({ checked: true, sub: null });
      if (endpoint) await genApi("pushUnsubscribe", { site_key: siteKey, endpoint });
      toast("Push alerts off for this device");
    } catch (e) {
      if (notReady(e)) setPushNote(NOT_READY); else setErr(e.message);
    } finally { setBusy(false); }
  }
  async function testPush() {
    if (busy) return;
    setBusy(true); setErr(null); setPushNote(null);
    try { await genApi("pushTest", { site_key: siteKey }); toast("Test sent"); }
    catch (e) { if (notReady(e)) setPushNote(NOT_READY); else setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Card title="Generator alerts" icon="bell">
        <div style={{ fontSize: FS.footnote, color: MUTED, marginBottom: 12 }}>Get told when this site's generator starts, stops, or a command fails. These settings are yours only.</div>
        <div className="ui-group">
          <div className="ui-row">
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: FS.body, fontWeight: 600, color: TEXT }}>Email</div><div style={{ fontSize: FS.footnote, color: MUTED }}>To your account email</div></div>
            <Switch checked={!!prefs.email} onChange={(v) => setPref("email", v)} label="Email alerts" disabled={busy} />
          </div>
          <div className="ui-row">
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: FS.body, fontWeight: 600, color: TEXT }}>Push</div><div style={{ fontSize: FS.footnote, color: MUTED }}>To every device where push is on</div></div>
            <Switch checked={!!prefs.push} onChange={(v) => setPref("push", v)} label="Push alerts" disabled={busy} />
          </div>
        </div>
      </Card>

      <Card title="This device" icon="bell">
        {needsInstall ? (
          <InfoNote>On iPhone and iPad, push alerts only work in the installed app. Tap Share, then Add to Home Screen, and open Midnite Sentinel from there.</InfoNote>
        ) : !supported ? (
          <InfoNote>This browser doesn't support push alerts. Use email, or install the app on your phone.</InfoNote>
        ) : !dev.checked ? (
          <div className="ui-skel" aria-hidden="true" style={{ height: 44, borderRadius: 12 }} />
        ) : (
          <>
            <div style={{ fontSize: FS.body, color: TEXT, marginBottom: 12 }}>{dev.sub ? "Push alerts are on for this device." : "Push alerts are off for this device."}</div>
            <div className="gen-actions">
              {dev.sub
                ? <><Button disabled={busy} icon="bell" onClick={testPush}>Send test</Button><Button variant="destructive" disabled={busy} onClick={disablePush}>Turn off on this device</Button></>
                : <Button variant="primary" disabled={busy} icon="bell" onClick={enablePush}>Turn on push for this device</Button>}
            </div>
          </>
        )}
        {pushNote && <div style={{ marginTop: 12 }}><InfoNote>{pushNote}</InfoNote></div>}
        <ErrorNote>{err}</ErrorNote>
      </Card>
    </>
  );
}
