import Head from 'next/head';
import { useState } from 'react';

const BG = "#F7F4EF";
const CARD = "#FFFFFF";
const BORDER = "#EAE4DC";
const TEXT = "#1C1917";
const MUTED = "#78716C";
const FAINT = "#A8A29E";
const SOLAR = "#D97706";
const BATTERY = "#16A34A";
const GRID_IN = "#DC2626";
const LOAD_C = "#2563EB";
const SANS = "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif";

function Logo({ size = 36 }) {
  const rays = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="256" height="256" rx="52" fill="#0D1F33" />
      {rays.map((deg) => {
        const rad = (deg * Math.PI) / 180;
        const sinR = Math.sin(rad);
        const cosR = Math.cos(rad);
        const x1 = 128 + sinR * 72;
        const y1 = 128 - cosR * 72;
        const x2 = 128 + sinR * 96;
        const y2 = 128 - cosR * 96;
        const dx = sinR * 7;
        const dy = -cosR * 7;
        return (
          <polygon
            key={deg}
            points={`${x1 + dy},${y1 - dx} ${x1 - dy},${y1 + dx} ${x2 - dy},${y2 + dx} ${x2 + dy},${y2 - dx}`}
            fill="#F59E0B"
          />
        );
      })}
      <circle cx="128" cy="128" r="66" fill="#F59E0B" />
      <circle cx="128" cy="128" r="44" fill="#0D1F33" />
      <circle cx="128" cy="128" r="28" fill="#00C8E8" />
      <circle cx="128" cy="128" r="12" fill="#0D1F33" />
      <circle cx="128" cy="128" r="5" fill="#FFFFFF" />
    </svg>
  );
}

const FAQ_SECTIONS = [
  {
    id: "getting-started",
    title: "Getting Started",
    questions: [
      {
        q: "What is Midnite Sentinel?",
        a: "Midnite Sentinel is a cloud-based monitoring and management platform for solar energy systems using Midnite inverters. It provides real-time power flow visualization, historical production and consumption charts (Day/Month/Year), fleet management for multi-site installations, smart email alerts, site-sharing capabilities, and detailed inverter settings comparison — all through a secure web dashboard accessible from any device.",
      },
      {
        q: "How do I sign up?",
        a: "Click \"Create free account\" on the home page, enter your email address and a password, accept the Terms & Conditions, and submit. No credit card is required. During pre-launch, all features including Pro are free. If Google sign-in is enabled, you can also use that.",
      },
      {
        q: "What is a \"Midnite account\" and how do I link one?",
        a: "After your Midnite Sentinel account is created, you'll be prompted to link your Midnite inverter system login — the same username and password used on the Midnite/Senergytec portal (view.midnitepower.com). Your credentials are encrypted with AES-256-GCM encryption before being stored and are never exposed in plaintext to your browser, our staff, or third parties. Go to Settings → Midnite to link, switch, or unlink accounts at any time.",
      },
      {
        q: "What inverters and account types are supported?",
        a: "Midnite Sentinel supports inverter systems accessible through the Midnite/Senergytec cloud API — including the MN 15-12KW-AIO (All-in-One) series and other Midnite-compatible inverters. Both installer accounts (Eagle API — manage fleets of end-user sites) and end-user accounts (Senergytec API — single site) are supported. Installer accounts unlock Fleet View and multi-site management.",
      },
      {
        q: "Is there a mobile app?",
        a: "Midnite Sentinel is a responsive web app — no download needed. It works on iOS and Android in your browser and is fully optimized for mobile, including a bottom navigation bar, touch-friendly controls, and a mobile camera upload for site photos. You can add it to your home screen for an app-like experience.",
      },
    ],
  },
  {
    id: "live-dashboard",
    title: "Live Dashboard & Power Flow",
    questions: [
      {
        q: "What does the Live tab show?",
        a: "The Live tab shows your solar system's current state: a real-time power flow diagram, individual inverter cards with live readings, the aggregated battery panel (SOC, SOH, capacity, rate, ETA), and lifetime energy totals. The power flow diagram updates every ~5 seconds; the inverter cards update every 5 minutes from the cloud cache.",
      },
      {
        q: "What is the Power Flow Diagram?",
        a: "The Power Flow Diagram is an animated SVG visualization showing how power is moving through your system right now. Nodes represent Solar, Grid, Battery, and Home (and optionally Generator and Smart Load when active). Animated dots travel along the connection lines — dot speed is proportional to the power level, so high-flow connections are obviously faster. Data comes from the live getHybridFlowgraphRealTimeData endpoint, which updates approximately every 5 seconds.",
      },
      {
        q: "How often does data update?",
        a: "Live power flow (LIVE ● indicator) updates every ~5 seconds via a real-time cloud relay. Inverter status readings (cards, battery panel) update every 5 minutes from the Midnite cloud cache. Historical charts (Day/Month/Year) are based on the same 5-minute interval data. The \"Updated X min ago\" chip shows exactly how stale the current readings are.",
      },
      {
        q: "What does \"Updated X min ago\" mean?",
        a: "That chip shows the time since your inverter last reported data to the Midnite cloud — the inverter's own report timestamp, not our server's fetch time. If it shows >10 minutes, your inverter may be offline or experiencing a connectivity issue. The chip turns amber as a heads-up. The LIVE ● indicator (green, ticking in seconds) is specific to the 5-second live flow feed.",
      },
      {
        q: "What is the Battery card?",
        a: "The Battery card aggregates battery data from all selected inverters: State of Charge (%), State of Health (%), total capacity in Ah and kWh (at nominal 51.2V), current net power (charging or discharging), rate as % of rated capacity per hour, estimated time to full charge or empty, voltage, and temperature. For open-loop / no-BMS setups (e.g. lead acid), SOH and temperature are hidden and SOC is labeled \"estimated.\"",
      },
      {
        q: "What is \"EPS\" or \"balance-derived load\"?",
        a: "AIO (All-in-One) inverters serve the house load through an EPS (Emergency Power Supply) port rather than the standard AC load port. On these units the standard load reading is 0 — the real house load comes from the EPS port. Midnite Sentinel auto-detects this and uses the correct source. \"Balance-derived load\" is a calculation (PV + grid import + battery discharge − battery charge − grid export) that works universally regardless of which port the load flows through.",
      },
    ],
  },
  {
    id: "charts",
    title: "Charts — Day, Month, Year & Explorer",
    questions: [
      {
        q: "What does the Day chart show?",
        a: "The Day chart is a stacked area chart at 5-minute resolution. Solar production fills above zero in blue shades; house consumption fills below zero in orange shades (both per-inverter when multiple are selected). Grid exchange and battery net are shown as lines; battery SOC tracks on a right-side axis. A draggable brush at the bottom lets you zoom into any time window.",
      },
      {
        q: "What are MPPT bands on the Day chart?",
        a: "When exactly one inverter is selected, the Day chart switches to per-MPPT mode, splitting production into individual bands — MPPT 1, MPPT 2, MPPT 3. This shows the contribution of each string or array segment throughout the day, pulled from the inverter's 5-minute CSV export. This per-string data is not available when multiple inverters are selected (the multi-inverter view aggregates by inverter instead).",
      },
      {
        q: "Why does the Day summary match the Month chart?",
        a: "By design. The Day tab's summary tiles (Produced/Consumed/Exported/etc.) come from the monthly rollup endpoint's daily entry — not by integrating the 5-minute power curve. This guarantees that Day and Month always agree. The 5-minute curve is for shape/visualization only; the totals are authoritative from the month rollup.",
      },
      {
        q: "What is the Explorer tab?",
        a: "Explorer lets you chart any raw inverter parameter over a date range of up to 7 days at 5-minute resolution. Choose parameters from categories (Power, Voltage, Current, Frequency, Battery, Temperature, Energy Today, Energy Lifetime). Multiple parameters with different units get separate stacked chart panels. Useful for correlating battery voltage with SOC, diagnosing temperature spikes, or investigating production patterns over several days. Uses a single-inverter selector (one at a time).",
      },
    ],
  },
  {
    id: "fleet-view",
    title: "Fleet View",
    questions: [
      {
        q: "What is Fleet View?",
        a: "Fleet View is a real-time status dashboard for installer/admin accounts managing multiple sites. It shows all sites in a sortable, searchable table with columns for site status (Online/Partial/Offline), current PV power, house load, battery SOC, grid exchange, PV today, exported today, and last update time. KPI summary cards at the top show fleet-wide totals and a count of sites needing attention.",
      },
      {
        q: "Who can see Fleet View?",
        a: "Fleet View appears automatically for accounts linked to an installer-type Midnite account, which can manage multiple end-user sites via the Eagle API. Single-site end-user accounts go directly to the site dashboard. If you've been granted view-only access to a shared site, you'll also see Fleet View if there are multiple shared sites on that account.",
      },
      {
        q: "What do the status indicators mean (Online, Partial, Offline)?",
        a: "These come from the live power flow endpoint's per-inverter online flag — not just whether the API returned data (stale cached data can make offline sites appear \"online\"). Online = all inverters at the site responding live. Partial = some are live, some aren't. Offline = none are responding in the live feed.",
      },
      {
        q: "Can I export Fleet data?",
        a: "Yes — click the ⬇ CSV button in the Fleet View header to download the current table (all sites, all columns) as a CSV file. The file is named with today's date.",
      },
    ],
  },
  {
    id: "alerts",
    title: "Alerts & Notifications",
    questions: [
      {
        q: "How do I set up an alert?",
        a: "Go to Settings → Notifications. Each inverter (device) in your linked account is listed. Click \"Add rule\" next to a device, choose a trigger type from the dropdown, set a threshold value, optionally set a time gate (e.g., only alert after 6 PM) and a cooldown period, then save. Email alerts will be sent when the condition is met.",
      },
      {
        q: "What trigger types are available?",
        a: "Battery SOC below / above threshold, Battery SOH below threshold, Battery temperature above threshold, Inverter temperature above threshold, House load above threshold, Grid import above threshold, Grid export above threshold, Grid voltage above / below threshold, PV produced today below threshold (time-gated — useful for checking production before sunset), and Device offline (triggered when the heartbeat detects a gap in reporting).",
      },
      {
        q: "What is a cooldown period?",
        a: "Cooldown is the minimum number of minutes between repeated alert emails for the same rule. Default is 60 minutes. It prevents alert flooding when a condition persists for a long time (e.g., battery stays low for 3 hours). Set longer cooldowns for persistent conditions; shorter for transient spikes.",
      },
      {
        q: "What is the daily email cap?",
        a: "To protect your inbox, each user has a daily limit on alert emails (default: 50). When the limit is reached, further alerts are suppressed until midnight. A single \"daily limit reached\" heads-up email is sent. Rules continue to evaluate — only delivery is paused. You can change thresholds or cooldowns in Settings → Notifications to reduce volume.",
      },
      {
        q: "Why isn't my alert email arriving?",
        a: "Check that a Resend API key is configured (Settings → Notifications shows a banner if email isn't set up). Also check your spam/junk folder. During pre-launch, the default sender is a shared testing address — adding it to your contacts helps. Verify your cooldown hasn't prevented a re-trigger. Use the \"Send test\" button in Notifications to verify end-to-end delivery.",
      },
      {
        q: "How does device offline detection work?",
        a: "A scheduled heartbeat runs every 5 minutes. For each device with active rules, it fetches the current status, stores a snapshot in the database, and evaluates all enabled rules. The \"Device offline\" trigger compares snapshot timestamps — if the gap between the most recent snapshot's report time and the previous one exceeds a threshold, the alert fires. This is based on what the inverter actually reported, not our fetch time.",
      },
    ],
  },
  {
    id: "site-sharing",
    title: "Site Sharing",
    questions: [
      {
        q: "How do I share a site with someone?",
        a: "In the dashboard header, click \"↗ Share\" (or go to Settings → Sharing). Enter the recipient's email address and click Share. If they have a Midnite Sentinel account, the site appears in their account switcher immediately. If not, they receive an invitation email asking them to sign up — the site will appear automatically when they do (using that email address).",
      },
      {
        q: "What can a shared (view-only) user access?",
        a: "Shared users get read-only access to the specific site(s) shared with them. They can view Live, Day, Month, Year, and Explorer tabs, see Fleet View if multiple sites are shared, and see the site photo set by the owner. They cannot access Admin tools, create alerts, share the site with others, change any settings, or modify site photos.",
      },
      {
        q: "Are my Midnite credentials exposed to the recipient?",
        a: "No — never. Your credentials are stored encrypted on our server. When a shared user views your site, the server fetches data using your encrypted credentials (decrypted server-side, scope-limited to the shared site only) and returns only the monitoring data. The recipient has no way to see or extract your Midnite login.",
      },
      {
        q: "How do I revoke access?",
        a: "Go to Settings → Sharing. Under \"Sites you're sharing,\" each active share has a Revoke button. Clicking it immediately terminates access — the recipient will no longer see the site on their next page load.",
      },
      {
        q: "Can I share multiple sites with the same person?",
        a: "Yes — you can create separate shares for each site. Each share is independent (can be revoked individually). The recipient will see all their shared sites in their account switcher.",
      },
    ],
  },
  {
    id: "settings",
    title: "Settings & Account",
    questions: [
      {
        q: "How do I change my email or password?",
        a: "Go to Settings → Security. You can update your Midnite Sentinel account email (may require confirmation) or set a new password there.",
      },
      {
        q: "How do I add a profile photo or display name?",
        a: "Go to Settings → Profile. Upload an avatar image and set a display name. The display name appears in the account header and in share notification emails you send.",
      },
      {
        q: "How do I add a site photo?",
        a: "Go to Settings → Site Photos to upload a photo for any of your sites. On mobile, open Fleet View and tap the thumbnail icon next to a site to take a photo directly with your camera or choose one from your gallery. Site photos appear in Fleet View and may appear in other parts of the app in the future.",
      },
      {
        q: "How do I unlink or switch my Midnite account?",
        a: "Go to Settings → Midnite. Users can unlink and re-link a different Midnite login. Admin accounts can manage and switch between multiple linked Midnite accounts using the account switcher in the header.",
      },
      {
        q: "What is the Admin panel?",
        a: "The Admin panel (visible to installer/admin accounts) provides diagnostic tools: a fleet-wide energy register readout, an API debug runner with preset actions, device shadow register probing (reads live inverter register values), and an access log showing recent logins and site views. It's a power-user tool for system diagnostics and configuration comparison.",
      },
    ],
  },
  {
    id: "pricing",
    title: "Pricing & Plans",
    questions: [
      {
        q: "What's the difference between Free and Pro?",
        a: "Free includes live dashboard, Day/Month/Year charts, and monitoring for one site. Pro (pricing TBD) adds fleet management for multiple sites, smart alerts and email notifications, site sharing, the Explorer tab for raw data analysis, and per-inverter settings comparison. During pre-launch, all Pro features are available to all users at no charge.",
      },
      {
        q: "What does \"pre-launch\" mean for pricing?",
        a: "Midnite Sentinel is in an active pre-commercial phase. During this period, we're building, testing, and refining the platform with real users. All features — including those planned for the paid Pro tier — are free to use. We will notify all users by email before any paid plans go live.",
      },
      {
        q: "Will I lose access to features when paid plans launch?",
        a: "You won't be charged without explicitly opting in. When we introduce paid plans, we'll provide advance notice and a clear path for choosing a plan. A free tier with basic monitoring will remain available.",
      },
      {
        q: "How do I contact support?",
        a: "Use the contact link in the footer or email us directly. We aim to respond within 1–2 business days. For feature requests or bugs, we welcome specific feedback.",
      },
    ],
  },
];

function AccordionItem({ question, answer, isOpen, onToggle }) {
  return (
    <div style={{
      borderBottom: `1px solid ${BORDER}`,
    }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          padding: '18px 0',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: SANS,
        }}
        aria-expanded={isOpen}
      >
        <span style={{
          fontSize: 15,
          fontWeight: 600,
          color: isOpen ? SOLAR : TEXT,
          lineHeight: 1.45,
          transition: 'color 0.15s',
        }}>
          {question}
        </span>
        <span style={{
          flexShrink: 0,
          fontSize: 13,
          color: isOpen ? SOLAR : FAINT,
          marginTop: 2,
          transition: 'color 0.15s, transform 0.2s',
          display: 'inline-block',
          transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
        }}>
          ▼
        </span>
      </button>
      {isOpen && (
        <div style={{
          paddingBottom: 20,
          fontSize: 15,
          color: MUTED,
          lineHeight: 1.75,
        }}>
          {answer}
        </div>
      )}
    </div>
  );
}

function FAQSection({ section, openIndex, onToggle, globalOffset }) {
  return (
    <div style={{ marginBottom: 40 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 4,
      }}>
        <h2 style={{
          fontSize: 17,
          fontWeight: 700,
          color: TEXT,
          margin: 0,
          letterSpacing: '-0.2px',
        }}>
          {section.title}
        </h2>
      </div>
      <div style={{
        background: CARD,
        border: `1px solid ${BORDER}`,
        borderRadius: 14,
        padding: '0 24px',
        marginTop: 12,
      }}>
        {section.questions.map((item, i) => {
          const globalIdx = globalOffset + i;
          return (
            <AccordionItem
              key={i}
              question={item.q}
              answer={item.a}
              isOpen={openIndex === globalIdx}
              onToggle={() => onToggle(globalIdx)}
            />
          );
        })}
      </div>
    </div>
  );
}

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState(null);

  function handleToggle(idx) {
    setOpenIndex(prev => prev === idx ? null : idx);
  }

  // Pre-compute global offsets for each section
  let offset = 0;
  const sectionsWithOffsets = FAQ_SECTIONS.map(section => {
    const o = offset;
    offset += section.questions.length;
    return { section, offset: o };
  });

  const totalQuestions = offset;

  return (
    <>
      <Head>
        <title>FAQ — Midnite Sentinel</title>
        <meta name="description" content="Frequently asked questions about Midnite Sentinel, the real-time solar monitoring platform for Midnite inverter systems." />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </Head>

      <div style={{ background: BG, minHeight: '100vh', fontFamily: SANS, color: TEXT }}>

        {/* Sticky Nav */}
        <nav style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          background: CARD,
          borderBottom: `1px solid ${BORDER}`,
          padding: '0 24px',
        }}>
          <div style={{
            maxWidth: 860,
            margin: '0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: 60,
          }}>
            <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
              <Logo size={32} />
              <span style={{ fontWeight: 700, fontSize: 16, color: TEXT, letterSpacing: '-0.3px' }}>
                Midnite Sentinel
              </span>
            </a>
            <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
              <a href="/terms" style={{ fontSize: 14, fontWeight: 500, color: MUTED, textDecoration: 'none' }}>
                Terms
              </a>
              <a href="/" style={{
                fontSize: 14,
                fontWeight: 600,
                color: '#FFFFFF',
                background: SOLAR,
                borderRadius: 8,
                padding: '6px 16px',
                textDecoration: 'none',
              }}>
                Sign In
              </a>
            </div>
          </div>
        </nav>

        {/* Hero */}
        <div style={{
          background: CARD,
          borderBottom: `1px solid ${BORDER}`,
          padding: '56px 24px 52px',
          textAlign: 'center',
        }}>
          <p style={{
            fontSize: 13,
            fontWeight: 600,
            color: SOLAR,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: 12,
            marginTop: 0,
          }}>
            Help Center
          </p>
          <h1 style={{
            fontSize: 36,
            fontWeight: 800,
            color: TEXT,
            margin: '0 0 14px',
            letterSpacing: '-0.6px',
            lineHeight: 1.15,
          }}>
            Frequently Asked Questions
          </h1>
          <p style={{
            fontSize: 17,
            color: MUTED,
            margin: '0 auto',
            maxWidth: 480,
            lineHeight: 1.6,
          }}>
            Everything you need to know about Midnite Sentinel
          </p>
          <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
            {FAQ_SECTIONS.map(s => (
              <a
                key={s.id}
                href={`#${s.id}`}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: MUTED,
                  background: BG,
                  border: `1px solid ${BORDER}`,
                  borderRadius: 20,
                  padding: '5px 12px',
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                  transition: 'border-color 0.15s, color 0.15s',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.color = SOLAR;
                  e.currentTarget.style.borderColor = SOLAR;
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.color = MUTED;
                  e.currentTarget.style.borderColor = BORDER;
                }}
              >
                {s.title}
              </a>
            ))}
          </div>
        </div>

        {/* Main Content */}
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px 80px' }}>

          <div style={{ display: 'flex', gap: 40, alignItems: 'flex-start' }}>

            {/* Sidebar — desktop only */}
            <aside style={{
              width: 200,
              flexShrink: 0,
              position: 'sticky',
              top: 80,
              display: 'none',
            }}
              className="faq-sidebar"
            >
              <p style={{ fontSize: 11, fontWeight: 700, color: FAINT, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
                Sections
              </p>
              <nav>
                {FAQ_SECTIONS.map(s => (
                  <a
                    key={s.id}
                    href={`#${s.id}`}
                    style={{
                      display: 'block',
                      fontSize: 13,
                      fontWeight: 500,
                      color: MUTED,
                      textDecoration: 'none',
                      padding: '6px 0',
                      borderLeft: `2px solid transparent`,
                      paddingLeft: 12,
                      marginLeft: -12,
                      lineHeight: 1.4,
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.color = SOLAR;
                      e.currentTarget.style.borderLeftColor = SOLAR;
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.color = MUTED;
                      e.currentTarget.style.borderLeftColor = 'transparent';
                    }}
                  >
                    {s.title}
                  </a>
                ))}
              </nav>
            </aside>

            {/* Accordion content */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {sectionsWithOffsets.map(({ section, offset: sectionOffset }) => (
                <div key={section.id} id={section.id}>
                  <FAQSection
                    section={section}
                    openIndex={openIndex}
                    onToggle={handleToggle}
                    globalOffset={sectionOffset}
                  />
                </div>
              ))}

              {/* Contact callout */}
              <div style={{
                background: CARD,
                border: `1px solid ${BORDER}`,
                borderRadius: 14,
                padding: '28px 28px',
                marginTop: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 20,
                flexWrap: 'wrap',
              }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <p style={{ fontSize: 15, fontWeight: 700, color: TEXT, margin: '0 0 4px' }}>
                    Still have questions?
                  </p>
                  <p style={{ fontSize: 14, color: MUTED, margin: 0, lineHeight: 1.6 }}>
                    We're happy to help. Reach out and we'll get back to you within 1–2 business days.
                  </p>
                </div>
                <a
                  href="mailto:jason+midnite@floridasolardesigngroup.com"
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: SOLAR,
                    border: `1.5px solid ${SOLAR}`,
                    borderRadius: 8,
                    padding: '8px 20px',
                    textDecoration: 'none',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  Contact Support
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          borderTop: `1px solid ${BORDER}`,
          padding: '32px 24px',
          textAlign: 'center',
          background: CARD,
        }}>
          <p style={{ fontSize: 13, color: FAINT, margin: '0 0 8px' }}>
            © 2025 Second Stream LLC. All rights reserved.
          </p>
          <p style={{ fontSize: 12, color: FAINT, margin: 0 }}>
            <a href="/" style={{ color: FAINT, textDecoration: 'none' }}>Home</a>
            {' · '}
            <a href="/terms" style={{ color: FAINT, textDecoration: 'none' }}>Terms & Conditions</a>
            {' · '}
            Midnite Sentinel is not affiliated with Midnite Electric Co.
          </p>
        </div>

      </div>

      <style>{`
        @media (min-width: 700px) {
          .faq-sidebar {
            display: block !important;
          }
        }
      `}</style>
    </>
  );
}
