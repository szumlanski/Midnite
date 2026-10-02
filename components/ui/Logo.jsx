// Midnite Sentinel mark: navy tile, 8 amber pill rays, amber disc, navy ring, cyan iris, navy pupil, white
// core (256x256, centered at 128,128). public/favicon.svg and public/logo.svg must match this drawing.
export const Logo = ({ size = 32, title }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}>
    <rect width="256" height="256" rx="40" fill="#0D1F33"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(0 128 128)"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(45 128 128)"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(90 128 128)"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(135 128 128)"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(180 128 128)"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(225 128 128)"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(270 128 128)"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(315 128 128)"/>
    <circle cx="128" cy="128" r="66" fill="#F59E0B"/>
    <circle cx="128" cy="128" r="44" fill="#0D1F33"/>
    <circle cx="128" cy="128" r="28" fill="#00C8E8"/>
    <circle cx="128" cy="128" r="12" fill="#0D1F33"/>
    <circle cx="128" cy="128" r="5" fill="#FFFFFF"/>
  </svg>
);
