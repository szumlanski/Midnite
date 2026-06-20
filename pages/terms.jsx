import Head from 'next/head';

const BG = "#F7F4EF";
const CARD = "#FFFFFF";
const BORDER = "#EAE4DC";
const TEXT = "#1C1917";
const MUTED = "#78716C";
const FAINT = "#A8A29E";
const SOLAR = "#D97706";
const BATTERY = "#16A34A";
const GRID_IN = "#DC2626";
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

export default function Terms() {
  const contactEmail = 'jason+midnite' + '@' + 'floridasolardesigngroup.com';

  return (
    <>
      <Head>
        <title>Terms &amp; Conditions — Midnite Sentinel</title>
        <meta name="robots" content="noindex" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
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
            maxWidth: 740,
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
              <a href="/faq" style={{ fontSize: 14, fontWeight: 500, color: MUTED, textDecoration: 'none' }}>
                FAQ
              </a>
              <a href="/" style={{
                fontSize: 14,
                fontWeight: 600,
                color: SOLAR,
                border: `1.5px solid ${SOLAR}`,
                borderRadius: 8,
                padding: '6px 16px',
                textDecoration: 'none',
              }}>
                Sign In
              </a>
            </div>
          </div>
        </nav>

        {/* Content */}
        <div style={{ maxWidth: 740, margin: '0 auto', padding: '56px 24px 80px' }}>

          {/* Header */}
          <div style={{ marginBottom: 48 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: SOLAR, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
              Legal
            </p>
            <h1 style={{ fontSize: 32, fontWeight: 800, color: TEXT, margin: '0 0 12px', letterSpacing: '-0.5px', lineHeight: 1.2 }}>
              Terms &amp; Conditions
            </h1>
            <p style={{ fontSize: 15, color: MUTED, margin: 0 }}>
              Effective Date: June 20, 2026
            </p>
          </div>

          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 16, padding: '40px 44px' }}>

            <p style={{ fontSize: 15, color: MUTED, lineHeight: 1.75, marginTop: 0, marginBottom: 32 }}>
              Please read these Terms &amp; Conditions ("Terms") carefully before using Midnite Sentinel (the
              "Service"), operated by <strong style={{ color: TEXT }}>Second Stream LLC</strong>, a Florida
              limited liability company ("Company," "we," "our," or "us"). By accessing or using the Service,
              you agree to be bound by these Terms. If you do not agree, do not use the Service.
            </p>

            <Section number="1" title="Acceptance of Terms">
              <p>
                By creating an account, accessing the Service at{' '}
                <a href="https://midnite-rose.vercel.app" style={{ color: SOLAR }}>midnite-rose.vercel.app</a>{' '}
                or any associated domain, or using any feature of the Service, you affirm that you are at
                least 18 years of age, have the legal capacity to enter into a binding agreement, and accept
                these Terms in full. If you are using the Service on behalf of an organization, you represent
                that you have authority to bind that organization to these Terms, and the terms "you" and "your"
                refer to that organization.
              </p>
              <p>
                Your continued use of the Service after any modification to these Terms constitutes your
                acceptance of the revised Terms.
              </p>
            </Section>

            <Section number="2" title="Description of Service">
              <p>
                Midnite Sentinel is a solar energy monitoring dashboard that aggregates, displays, and analyzes
                data from Midnite Electric solar inverter systems. The Service connects to your inverter system
                via the Midnite/Senergytec cloud API using credentials you provide, and presents real-time and
                historical energy production, consumption, battery status, grid interaction, and related
                performance data.
              </p>
              <p>
                Features may include, but are not limited to: live power-flow visualization, daily/monthly/annual
                energy reporting, per-inverter and per-MPPT analysis, battery health monitoring, fleet management
                for installers, data export, email alerts and threshold notifications, and user account
                management. The specific features available to you may depend on your account type and any
                applicable subscription tier.
              </p>
              <p>
                The Service is provided as a monitoring and informational tool only. It is{' '}
                <strong>not a substitute for professional engineering assessment, system maintenance, utility
                compliance review, or any other professional service.</strong> You should not rely solely on
                the Service to make decisions about your solar energy system, electrical infrastructure, or
                any related safety matters.
              </p>
            </Section>

            <Section number="3" title="User Accounts & Credentials">
              <p>
                To use the Service, you must create an account using a valid email address and password, or by
                authenticating through a supported third-party provider (such as Google OAuth), via our
                authentication provider Supabase. You are responsible for maintaining the confidentiality of
                your account credentials and for all activity that occurs under your account. You agree to
                notify us immediately of any unauthorized use of your account.
              </p>
              <p>
                To connect the Service to your Midnite inverter system, you must provide your Midnite/Senergytec
                account credentials (username and password). These credentials are:
              </p>
              <ul>
                <li>
                  Encrypted using <strong>AES-256-GCM</strong> encryption before storage, using a server-side
                  encryption key that is never exposed to the browser or stored in our database in recoverable form.
                </li>
                <li>
                  Stored only in our secure database (Supabase) and accessed exclusively by our server-side
                  proxy when making authorized requests to the Midnite API on your behalf.
                </li>
                <li>
                  Never transmitted in plaintext to the client or shared with any third party other than the
                  Midnite/Senergytec API for the purpose of fetching your inverter data.
                </li>
              </ul>
              <p>
                You represent that you have the right and authorization to provide any credentials you submit to
                the Service, and that doing so does not violate any agreement you have with any third party,
                including your inverter manufacturer or their cloud service provider.
              </p>
              <p>
                You may unlink your Midnite account at any time through the Settings page, which will cause your
                stored encrypted credentials to be deleted. We reserve the right to suspend or terminate accounts
                that we reasonably believe are being used fraudulently, abusively, or in violation of these Terms.
              </p>
            </Section>

            <Section number="4" title="Acceptable Use">
              <p>You agree to use the Service only for lawful purposes and in accordance with these Terms. You agree not to:</p>
              <ul>
                <li>
                  Use the Service in any way that violates applicable local, state, national, or international
                  laws or regulations.
                </li>
                <li>
                  Attempt to gain unauthorized access to any portion of the Service, its infrastructure, or any
                  third-party systems connected to or accessible through the Service.
                </li>
                <li>
                  Reverse-engineer, decompile, disassemble, or attempt to derive source code from any part of
                  the Service.
                </li>
                <li>
                  Use automated tools, scrapers, bots, or scripts to access the Service in a manner that places
                  excessive load on our infrastructure or the third-party APIs we depend on.
                </li>
                <li>
                  Use the Service to store, transmit, or process any malicious code, viruses, or other harmful
                  software.
                </li>
                <li>
                  Share your account credentials with any other person or allow any other person to access the
                  Service through your account, except through the officially supported account-sharing features.
                </li>
                <li>
                  Use the Service to harass, defame, or harm any person or organization.
                </li>
                <li>
                  Attempt to circumvent any security, rate-limiting, or access-control measures in the Service.
                </li>
              </ul>
              <p>
                We reserve the right to investigate and take appropriate legal or technical action against anyone
                who, in our sole discretion, violates these provisions, including removing content, suspending
                or terminating accounts, and reporting to law enforcement.
              </p>
            </Section>

            <Section number="5" title="Intellectual Property">
              <p>
                The Service and its original content, features, functionality, design, source code, trademarks,
                service marks, logos, and graphics are and will remain the exclusive property of Second Stream LLC
                and its licensors. These materials are protected by applicable copyright, trademark, patent, trade
                secret, and other intellectual property laws.
              </p>
              <p>
                You are granted a limited, non-exclusive, non-transferable, revocable license to access and use
                the Service for your personal or internal business purposes, subject to these Terms. This license
                does not include the right to: sublicense, sell, resell, transfer, or assign the Service or any
                part thereof; modify or create derivative works based on the Service; reproduce, distribute, or
                publicly display any part of the Service without our prior written consent.
              </p>
              <p>
                You retain ownership of any data you provide to the Service (such as your inverter credentials and
                account information). By providing such data, you grant us a limited license to process and use it
                solely to provide the Service to you, as described in these Terms and our Privacy Policy.
              </p>
            </Section>

            <Section number="6" title="Data & Privacy">
              <p>
                We take the privacy and security of your data seriously. The following summarizes how we handle
                your information:
              </p>
              <ul>
                <li>
                  <strong>Authentication data</strong> (email address, hashed password, OAuth tokens) is managed
                  by <strong>Supabase</strong>, our authentication and database provider. See Supabase's privacy
                  policy for details on how they handle this data.
                </li>
                <li>
                  <strong>Inverter credentials</strong> are encrypted with AES-256-GCM and stored in our Supabase
                  database. The plaintext password never leaves our server environment.
                </li>
                <li>
                  <strong>Energy and inverter data</strong> fetched from the Midnite/Senergytec API is used solely
                  to render your dashboard and generate alerts. We may store snapshots of this data (for example,
                  for offline detection and notification history) in our Supabase database, scoped to your account
                  and protected by row-level security policies.
                </li>
                <li>
                  <strong>Email notifications</strong>, when configured, are delivered via <strong>Resend</strong>,
                  a transactional email provider. Your email address is shared with Resend solely to deliver
                  messages you have requested.
                </li>
                <li>
                  <strong>We do not sell, rent, or trade your personal information</strong> to any third party
                  for marketing purposes, and we never will.
                </li>
                <li>
                  <strong>Aggregated, anonymized analytics</strong> (such as aggregate usage statistics) may be
                  used by us to improve the Service.
                </li>
              </ul>
              <p>
                By using the Service, you consent to the data practices described in these Terms. A full Privacy
                Policy governing data collection, retention, deletion rights, and related matters will be published
                as the Service matures. In the interim, these Terms govern our data practices.
              </p>
            </Section>

            <Section number="7" title="Third-Party Services">
              <p>
                The Service integrates with and depends on the following third-party services. Your use of the
                Service is subject to the terms and privacy policies of these providers:
              </p>
              <ul>
                <li>
                  <strong>Supabase</strong> — Authentication, database, and file storage. We use Supabase to
                  store your account information, encrypted credentials, and notification data.
                  (<a href="https://supabase.com/privacy" style={{ color: SOLAR }}>supabase.com/privacy</a>)
                </li>
                <li>
                  <strong>Vercel</strong> — Hosting and serverless compute. The Service is deployed on Vercel's
                  infrastructure.
                  (<a href="https://vercel.com/legal/privacy-policy" style={{ color: SOLAR }}>vercel.com/legal/privacy-policy</a>)
                </li>
                <li>
                  <strong>Resend</strong> — Transactional email delivery for notifications and alerts.
                  (<a href="https://resend.com/legal/privacy-policy" style={{ color: SOLAR }}>resend.com/legal/privacy-policy</a>)
                </li>
                <li>
                  <strong>Midnite Electric / Senergytec API</strong> — The third-party cloud API that provides
                  inverter data. We connect to this API using your credentials on your behalf. We are not
                  affiliated with Midnite Electric Co. and are not responsible for the availability, accuracy,
                  or terms of use of their API or cloud service.
                </li>
              </ul>
              <p>
                We are not responsible for the practices, terms, or actions of any third-party service provider.
                Any issues arising from third-party services must be addressed directly with those providers.
              </p>
            </Section>

            <Section number="8" title="Disclaimer of Warranties">
              <p>
                THE SERVICE IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS, WITHOUT WARRANTY OF ANY KIND,
                EXPRESS OR IMPLIED. TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, SECOND STREAM LLC
                EXPRESSLY DISCLAIMS ALL WARRANTIES, INCLUDING BUT NOT LIMITED TO:
              </p>
              <ul>
                <li>
                  IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND
                  NON-INFRINGEMENT.
                </li>
                <li>
                  WARRANTIES THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, TIMELY, SECURE, OR FREE OF
                  VIRUSES OR OTHER HARMFUL COMPONENTS.
                </li>
                <li>
                  WARRANTIES REGARDING THE ACCURACY, COMPLETENESS, RELIABILITY, OR USEFULNESS OF ANY DATA,
                  INFORMATION, OR RESULTS OBTAINED THROUGH THE SERVICE.
                </li>
              </ul>
              <p>
                THE SERVICE DISPLAYS DATA SOURCED FROM THIRD-PARTY INVERTER APIs. WE DO NOT WARRANT THAT SUCH
                DATA IS ACCURATE, UP-TO-DATE, OR FREE FROM ERRORS. ENERGY PRODUCTION AND CONSUMPTION FIGURES
                DISPLAYED ARE DERIVED FROM THIRD-PARTY TELEMETRY AND MAY DIFFER FROM ACTUAL METERED VALUES.
              </p>
              <p>
                THE SERVICE IS NOT A SUBSTITUTE FOR PROFESSIONAL ENGINEERING ASSESSMENT, UTILITY INTERCONNECTION
                COMPLIANCE, ELECTRICAL SAFETY INSPECTION, OR ANY OTHER PROFESSIONAL SERVICE. YOU SHOULD NOT
                RELY ON THE SERVICE ALONE TO MAKE DECISIONS AFFECTING SYSTEM SAFETY, ELECTRICAL INFRASTRUCTURE,
                REGULATORY COMPLIANCE, OR FINANCIAL MATTERS. ALWAYS CONSULT A QUALIFIED PROFESSIONAL FOR SUCH
                DECISIONS.
              </p>
            </Section>

            <Section number="9" title="Limitation of Liability">
              <p>
                TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL SECOND STREAM LLC, ITS
                MEMBERS, MANAGERS, EMPLOYEES, CONTRACTORS, AGENTS, LICENSORS, OR SERVICE PROVIDERS BE LIABLE
                FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES,
                INCLUDING BUT NOT LIMITED TO:
              </p>
              <ul>
                <li>LOSS OF PROFITS, REVENUE, OR ANTICIPATED SAVINGS;</li>
                <li>LOSS OF DATA, GOODWILL, OR BUSINESS OPPORTUNITIES;</li>
                <li>COSTS OF SUBSTITUTE SERVICES;</li>
                <li>
                  ANY DAMAGES ARISING FROM YOUR RELIANCE ON INACCURATE OR INCOMPLETE ENERGY DATA DISPLAYED
                  BY THE SERVICE;
                </li>
                <li>
                  ANY DAMAGES ARISING FROM UNAUTHORIZED ACCESS TO OR ALTERATION OF YOUR INVERTER SYSTEM OR DATA.
                </li>
              </ul>
              <p>
                THESE LIMITATIONS APPLY REGARDLESS OF THE THEORY OF LIABILITY (CONTRACT, TORT, STRICT LIABILITY,
                OR OTHERWISE), EVEN IF SECOND STREAM LLC HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
              </p>
              <p>
                IN ALL CASES, SECOND STREAM LLC'S TOTAL AGGREGATE LIABILITY TO YOU FOR ANY CLAIMS ARISING UNDER
                OR RELATED TO THESE TERMS OR THE SERVICE SHALL NOT EXCEED THE GREATER OF (A) ONE HUNDRED DOLLARS
                ($100.00 USD) OR (B) THE TOTAL FEES ACTUALLY PAID BY YOU TO SECOND STREAM LLC IN THE TWELVE (12)
                MONTHS PRECEDING THE CLAIM.
              </p>
              <p>
                SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OR LIMITATION OF LIABILITY FOR CONSEQUENTIAL OR
                INCIDENTAL DAMAGES, SO THE ABOVE LIMITATIONS MAY NOT APPLY TO YOU IN THEIR ENTIRETY.
              </p>
            </Section>

            <Section number="10" title="Indemnification">
              <p>
                You agree to defend, indemnify, and hold harmless Second Stream LLC and its members, managers,
                employees, contractors, agents, licensors, and service providers from and against any claims,
                liabilities, damages, judgments, awards, losses, costs, expenses, or fees (including reasonable
                attorneys' fees) arising out of or relating to:
              </p>
              <ul>
                <li>Your violation of these Terms;</li>
                <li>Your use of the Service in a manner not authorized by these Terms;</li>
                <li>
                  Your use or misuse of any data, information, or reports obtained through the Service;
                </li>
                <li>
                  Your violation of any applicable law, regulation, or third-party right, including any
                  intellectual property right or privacy right;
                </li>
                <li>
                  Any claim that your use of the Service caused damage to a third party.
                </li>
              </ul>
            </Section>

            <Section number="11" title="Subscription & Payment">
              <p>
                The Service is currently provided at no charge during its pre-launch phase. We reserve the right
                to introduce paid subscription tiers in the future. If and when paid tiers are introduced, the
                following terms will apply:
              </p>
              <ul>
                <li>
                  We will provide advance notice (no less than 30 days) of the introduction of any paid tiers
                  and the specific features that will require payment, via email to your registered account address
                  and/or notice posted on the Service.
                </li>
                <li>
                  Continued use of the Service after the effective date of any pricing change constitutes your
                  agreement to pay the applicable fees.
                </li>
                <li>
                  Subscription fees, billing cycles, refund policies, and cancellation procedures will be described
                  in the applicable subscription plan documentation at the time of purchase.
                </li>
                <li>
                  All fees are non-refundable except as required by applicable law or as expressly stated in the
                  subscription plan documentation.
                </li>
              </ul>
              <p>
                Until we provide notice of pricing changes, your access to currently available features will
                continue at no cost, subject to these Terms.
              </p>
            </Section>

            <Section number="12" title="Modifications to Terms">
              <p>
                We reserve the right to modify these Terms at any time at our sole discretion. When we make
                material changes, we will update the Effective Date at the top of this page and, where feasible,
                provide notice via email to your registered account address or through a notice displayed within
                the Service.
              </p>
              <p>
                Your continued use of the Service after the effective date of any revised Terms constitutes your
                acceptance of the changes. If you do not agree to the revised Terms, you must stop using the
                Service and may request deletion of your account by contacting us at the address below.
              </p>
              <p>
                We encourage you to review these Terms periodically to stay informed of any updates.
              </p>
            </Section>

            <Section number="13" title="Termination">
              <p>
                We may suspend or terminate your access to the Service, at our sole discretion, at any time and
                for any reason, including but not limited to your violation of these Terms, non-payment of fees
                (if applicable), extended inactivity, or if we determine that continued access poses a risk to
                the Service or other users. We will make reasonable efforts to provide advance notice of
                termination where practicable, except in cases of serious violation or legal necessity.
              </p>
              <p>
                You may terminate your account at any time by unlinking your Midnite account through the Settings
                page and contacting us to request account deletion. Upon termination, your right to use the Service
                will immediately cease.
              </p>
              <p>
                Upon termination of your account for any reason: (a) your encrypted Midnite credentials will be
                deleted from our database; (b) your energy data snapshots and notification history may be retained
                for up to 90 days before permanent deletion, unless you request earlier deletion; (c) any accrued
                rights or obligations of either party will survive termination. Sections 5, 6, 8, 9, 10, and 14
                of these Terms will survive any termination.
              </p>
            </Section>

            <Section number="14" title="Governing Law">
              <p>
                These Terms and any dispute arising out of or related to these Terms or the Service shall be
                governed by and construed in accordance with the laws of the State of Florida, without regard to
                its conflict-of-law provisions.
              </p>
              <p>
                Any legal action or proceeding arising under these Terms shall be brought exclusively in the
                state or federal courts located in Florida, and you hereby consent to the personal jurisdiction
                and venue of such courts. If any provision of these Terms is found by a court of competent
                jurisdiction to be invalid or unenforceable, the remaining provisions will continue in full
                force and effect.
              </p>
              <p>
                These Terms constitute the entire agreement between you and Second Stream LLC regarding your use
                of the Service, and supersede all prior and contemporaneous agreements, proposals, or
                representations, written or oral, concerning its subject matter.
              </p>
            </Section>

            <Section number="15" title="Contact" last>
              <p>
                If you have any questions, concerns, or requests regarding these Terms or the Service, please
                contact us at:
              </p>
              <div style={{
                background: BG,
                border: `1px solid ${BORDER}`,
                borderRadius: 10,
                padding: '20px 24px',
                marginTop: 16,
              }}>
                <p style={{ margin: '0 0 4px', fontWeight: 700, color: TEXT }}>Second Stream LLC</p>
                <p style={{ margin: '0 0 4px', color: MUTED, fontSize: 14 }}>Florida Limited Liability Company</p>
                <p style={{ margin: '0 0 4px', color: MUTED, fontSize: 14 }}>
                  Email:{' '}
                  <a href={'mailto:' + contactEmail} style={{ color: SOLAR, fontWeight: 600 }}>
                    {contactEmail}
                  </a>
                </p>
                <p style={{ margin: 0, color: MUTED, fontSize: 14 }}>
                  Service URL:{' '}
                  <a href="https://midnite-rose.vercel.app" style={{ color: SOLAR }}>
                    midnite-rose.vercel.app
                  </a>
                </p>
              </div>
            </Section>

          </div>

          {/* Footer */}
          <div style={{
            marginTop: 48,
            textAlign: 'center',
            borderTop: `1px solid ${BORDER}`,
            paddingTop: 32,
          }}>
            <p style={{ fontSize: 13, color: FAINT, margin: '0 0 6px' }}>
              © 2026 Second Stream LLC. All rights reserved.
            </p>
            <p style={{ fontSize: 12, color: FAINT, margin: 0 }}>
              Midnite Sentinel is not affiliated with Midnite Electric Co.
            </p>
          </div>

        </div>
      </div>
    </>
  );
}

function Section({ number, title, children, last }) {
  return (
    <section style={{ marginBottom: last ? 0 : 36 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          color: SOLAR,
          background: '#FEF3C7',
          border: '1px solid #FDE68A',
          borderRadius: 6,
          padding: '2px 8px',
          flexShrink: 0,
        }}>
          {number}
        </span>
        <h2 style={{
          fontSize: 18,
          fontWeight: 700,
          color: TEXT,
          margin: 0,
          letterSpacing: '-0.2px',
        }}>
          {title}
        </h2>
      </div>
      <div style={{ fontSize: 15, color: MUTED, lineHeight: 1.75, paddingLeft: 0 }}>
        {children}
      </div>
      {!last && (
        <div style={{ borderBottom: `1px solid ${BORDER}`, marginTop: 36 }} />
      )}
    </section>
  );
}
