// One stroke icon set for the whole app (24x24 grid, 1.8 stroke, round caps, currentColor).
// Sized in em so an icon matches the text it sits next to. Decorative unless `label` is given.
// Shapes follow the Lucide style (ISC license).

const P = (d) => <path d={d} />;

const ICONS = {
  back: P("M15 18l-6-6 6-6"),
  chevron: P("M9 18l6-6-6-6"),
  "chevron-down": P("M6 9l6 6 6-6"),
  "chevron-up": P("M18 15l-6-6-6 6"),
  more: (<><circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" /></>),
  sun: (<><circle cx="12" cy="12" r="4" />{P("M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41")}</>),
  battery: (<><rect x="2" y="7" width="17" height="10" rx="2.5" />{P("M22 11v2")}</>),
  "battery-charging": (<>{P("M8 7H4.5A2.5 2.5 0 0 0 2 9.5v5A2.5 2.5 0 0 0 4.5 17H7M15 7h1.5A2.5 2.5 0 0 1 19 9.5v5a2.5 2.5 0 0 1-2.5 2.5H13M22 11v2M11.5 7L9 12h4l-2.5 5")}</>),
  home: P("M3 10.5L12 3l9 7.5M5.5 9v11a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9"),
  pylon: P("M7 22l4-19h2l4 19M5 6.5h14M7.2 11h9.6M8.8 15.5l6.6 3.5M15.2 15.5l-6.6 3.5M9.6 11l4.8 4.5M14.4 11l-4.8 4.5"),
  bolt: P("M13 2L4 14h7l-1 8 9-12h-7l1-8z"),
  plug: P("M12 22v-5M9 8V2M15 8V2M18 8v4a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5V8z"),
  link: P("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"),
  cog: (<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" />{P("M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41")}</>),
  sliders: P("M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5"),
  share: P("M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13"),
  fleet: (<><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></>),
  refresh: P("M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5"),
  download: P("M12 3v12M7 10l5 5 5-5M5 21h14"),
  upload: P("M12 15V3M7 8l5-5 5 5M5 21h14"),
  camera: (<>{P("M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z")}<circle cx="12" cy="13" r="3.2" /></>),
  image: (<><rect x="3" y="3" width="18" height="18" rx="2.5" /><circle cx="9" cy="9" r="2" />{P("M21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21")}</>),
  check: P("M20 6L9 17l-5-5"),
  x: P("M18 6L6 18M6 6l12 12"),
  alert: P("M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"),
  info: (<><circle cx="12" cy="12" r="10" />{P("M12 16v-4M12 8h.01")}</>),
  help: (<><circle cx="12" cy="12" r="10" />{P("M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01")}</>),
  clock: (<><circle cx="12" cy="12" r="10" />{P("M12 6v6l4 2")}</>),
  calendar: (<><rect x="3" y="4" width="18" height="18" rx="2.5" />{P("M16 2v4M8 2v4M3 10h18")}</>),
  chart: P("M3 3v18h18M18 17V9M13 17V5M8 17v-3"),
  activity: P("M22 12h-4l-3 9L9 3l-3 9H2"),
  bulb: P("M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"),
  trash: P("M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"),
  edit: P("M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"),
  copy: (<><rect x="9" y="9" width="13" height="13" rx="2" />{P("M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1")}</>),
  search: (<><circle cx="11" cy="11" r="7" />{P("M21 21l-4.3-4.3")}</>),
  mail: (<><rect x="2" y="4" width="20" height="16" rx="2.5" />{P("M22 7l-10 6L2 7")}</>),
  lock: (<><rect x="3" y="11" width="18" height="11" rx="2.5" />{P("M7 11V7a5 5 0 0 1 10 0v4")}</>),
  user: (<><circle cx="12" cy="8" r="4" />{P("M4 21a8 8 0 0 1 16 0")}</>),
  users: (<><circle cx="9" cy="8" r="4" />{P("M2 21a7 7 0 0 1 14 0M16 3.13a4 4 0 0 1 0 7.75M22 21a7 7 0 0 0-4-6.3")}</>),
  external: P("M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"),
  "arrow-up": P("M12 19V5M5 12l7-7 7 7"),
  "arrow-down": P("M12 5v14M19 12l-7 7-7-7"),
  play: P("M7 4l13 8-13 8z"),
  stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
  wrench: P("M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"),
  logout: P("M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"),
  thermometer: P("M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z"),
  plus: P("M12 5v14M5 12h14"),
  bell: P("M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"),
  inverter: (<><rect x="5" y="2.5" width="14" height="19" rx="2.5" /><rect x="8" y="6" width="8" height="4" rx="1" />{P("M5 14h14M9 17.5h.01M12 17.5h.01")}</>),
  gauge: P("M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0"),
  shield: P("M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"),
};

export const ICON_NAMES = Object.keys(ICONS);

export function Icon({ name, size, label, strokeWidth = 1.8, className = "", style, ...rest }) {
  const shape = ICONS[name];
  if (!shape) return null;
  const s = size || "1.15em";
  return (
    <svg
      viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" focusable="false"
      className={`icon ${className}`.trim()} style={style}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      {...rest}
    >
      {shape}
    </svg>
  );
}

// For use INSIDE another <svg> (e.g. the power-flow diagram): a nested svg centred on (cx, cy).
export function svgIcon(name, cx, cy, size = 22, color = "#fff", strokeWidth = 2) {
  const shape = ICONS[name];
  if (!shape) return null;
  return (
    <svg x={cx - size / 2} y={cy - size / 2} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {shape}
    </svg>
  );
}
