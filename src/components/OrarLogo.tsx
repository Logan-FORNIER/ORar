interface OrarLogoProps {
  className?: string;
}

export function OrarLogo({ className = 'h-9 w-9' }: OrarLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      fill="none"
      className={className}
      aria-label="Logo ORar"
    >
      <defs>
        <linearGradient id="ui-orar-bg" x1="48" y1="32" x2="464" y2="480" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#0f172a" />
          <stop offset="55%" stopColor="#171936" />
          <stop offset="100%" stopColor="#1e1b4b" />
        </linearGradient>
        <linearGradient id="ui-orar-border" x1="24" y1="24" x2="488" y2="488" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="50%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#d97706" />
        </linearGradient>
        <linearGradient id="ui-layer-top" x1="88" y1="100" x2="424" y2="180" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="100%" stopColor="#d97706" />
        </linearGradient>
        <linearGradient id="ui-layer-mid" x1="88" y1="200" x2="424" y2="280" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#4f46e5" />
        </linearGradient>
        <linearGradient id="ui-layer-bot" x1="88" y1="300" x2="424" y2="380" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>
        <linearGradient id="ui-strap-metal" x1="256" y1="84" x2="256" y2="428" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#e2e8f0" />
          <stop offset="35%" stopColor="#94a3b8" />
          <stop offset="70%" stopColor="#475569" />
          <stop offset="100%" stopColor="#cbd5e1" />
        </linearGradient>
        <linearGradient id="ui-o-glow" x1="200" y1="200" x2="312" y2="312" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fde68a" />
          <stop offset="50%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#f97316" />
        </linearGradient>
      </defs>

      <rect
        x="20"
        y="20"
        width="472"
        height="472"
        rx="112"
        fill="url(#ui-orar-bg)"
        stroke="url(#ui-orar-border)"
        strokeWidth="12"
      />
      <rect
        x="38"
        y="38"
        width="436"
        height="436"
        rx="96"
        stroke="#ffffff"
        strokeOpacity="0.08"
        strokeWidth="3"
      />
      <rect x="86" y="316" width="340" height="84" rx="22" fill="url(#ui-layer-bot)" />
      <rect x="86" y="316" width="340" height="16" rx="8" fill="#ffffff" fillOpacity="0.18" />
      <rect x="112" y="352" width="76" height="10" rx="5" fill="#064e3b" fillOpacity="0.45" />
      <rect x="324" y="352" width="76" height="10" rx="5" fill="#064e3b" fillOpacity="0.45" />

      <rect x="86" y="214" width="340" height="84" rx="22" fill="url(#ui-layer-mid)" />
      <rect x="86" y="214" width="340" height="16" rx="8" fill="#ffffff" fillOpacity="0.18" />
      <rect x="112" y="250" width="76" height="10" rx="5" fill="#1e1b4b" fillOpacity="0.45" />
      <rect x="324" y="250" width="76" height="10" rx="5" fill="#1e1b4b" fillOpacity="0.45" />

      <rect x="86" y="112" width="340" height="84" rx="22" fill="url(#ui-layer-top)" />
      <rect x="86" y="112" width="340" height="16" rx="8" fill="#ffffff" fillOpacity="0.24" />
      <rect x="112" y="148" width="76" height="10" rx="5" fill="#78350f" fillOpacity="0.4" />
      <rect x="324" y="148" width="76" height="10" rx="5" fill="#78350f" fillOpacity="0.4" />

      <rect
        x="218"
        y="92"
        width="76"
        height="328"
        rx="18"
        fill="url(#ui-strap-metal)"
        stroke="#0f172a"
        strokeWidth="6"
      />
      <rect x="234" y="108" width="10" height="296" rx="5" fill="#ffffff" fillOpacity="0.35" />

      <rect
        x="206"
        y="128"
        width="100"
        height="28"
        rx="10"
        fill="url(#ui-orar-border)"
        stroke="#0f172a"
        strokeWidth="5"
      />
      <rect
        x="206"
        y="356"
        width="100"
        height="28"
        rx="10"
        fill="url(#ui-orar-border)"
        stroke="#0f172a"
        strokeWidth="5"
      />

      <circle
        cx="256"
        cy="256"
        r="82"
        fill="#0f172a"
        stroke="url(#ui-orar-border)"
        strokeWidth="10"
      />
      <circle
        cx="256"
        cy="256"
        r="66"
        fill="#171936"
        stroke="#ffffff"
        strokeOpacity="0.14"
        strokeWidth="2"
      />
      <circle cx="256" cy="256" r="38" stroke="url(#ui-o-glow)" strokeWidth="16" />
      <circle cx="256" cy="256" r="14" fill="#fbbf24" fillOpacity="0.22" />
      <path
        d="M226 226 A42 42 0 0 1 286 226"
        stroke="#fef3c7"
        strokeWidth="4"
        strokeLinecap="round"
        strokeOpacity="0.85"
      />
    </svg>
  );
}
