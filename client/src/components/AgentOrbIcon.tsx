import { useId } from "react";

/** Bespoke YoYo Agent avatar: iridescent obsidian-violet & warm-amber sphere
 * with a recessed dark glass visor, expressive luminous eyes, and a crisp
 * creative spark on the rim. Scales cleanly from 18px to 44px+. */
export function AgentOrbIcon({
  size = 24,
  thinking = false,
  className = "",
}: {
  size?: number;
  thinking?: boolean;
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const gradBody = `agent-body-${uid}`;
  const gradWarm = `agent-warm-${uid}`;
  const gradRim = `agent-rim-${uid}`;
  const gradVisor = `agent-visor-${uid}`;
  const gradEye = `agent-eye-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      className={`${thinking ? "animate-pulse" : ""} ${className}`}
      style={{
        filter: "drop-shadow(0 2px 6px rgba(99, 102, 241, 0.32))",
      }}
    >
      <defs>
        {/* Main studio-lit sphere: cool cyan-indigo top-left to deep slate-violet */}
        <radialGradient id={gradBody} cx="32%" cy="24%" r="76%">
          <stop offset="0%" stopColor="#a5f3fc" />
          <stop offset="28%" stopColor="#6366f1" />
          <stop offset="68%" stopColor="#312e81" />
          <stop offset="100%" stopColor="#17153b" />
        </radialGradient>

        {/* Warm amber/coral bounce light from bottom-right (matches YoYo accent) */}
        <radialGradient id={gradWarm} cx="80%" cy="84%" r="58%">
          <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.88" />
          <stop offset="45%" stopColor="#f472b6" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#312e81" stopOpacity="0" />
        </radialGradient>

        {/* Crisp glass rim */}
        <linearGradient id={gradRim} x1="5" y1="5" x2="35" y2="35" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="45%" stopColor="#a5b4fc" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#fcd34d" stopOpacity="0.6" />
        </linearGradient>

        {/* Recessed dark glass visor */}
        <linearGradient id={gradVisor} x1="20" y1="12" x2="20" y2="27" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#090a14" />
          <stop offset="100%" stopColor="#16182c" />
        </linearGradient>

        {/* Luminous cyan-white eyes */}
        <linearGradient id={gradEye} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#bae6fd" />
        </linearGradient>
      </defs>

      {/* Outer orb */}
      <circle cx="20" cy="20" r="17.5" fill={`url(#${gradBody})`} />
      <circle cx="20" cy="20" r="17.5" fill={`url(#${gradWarm})`} />

      {/* Top-left studio specular crescent */}
      <ellipse
        cx="13.5"
        cy="9.2"
        rx="6.2"
        ry="2.6"
        transform="rotate(-24 13.5 9.2)"
        fill="#ffffff"
        fillOpacity="0.42"
      />

      {/* Rim stroke */}
      <circle cx="20" cy="20" r="17" stroke={`url(#${gradRim})`} strokeWidth="1.1" />

      {/* Recessed dark visor */}
      <rect
        x="8.2"
        y="12.6"
        width="23.6"
        height="14.2"
        rx="7.1"
        fill={`url(#${gradVisor})`}
        stroke="#ffffff"
        strokeOpacity="0.16"
        strokeWidth="0.9"
      />

      {/* Expressive glowing eyes with tiny catchlights */}
      <rect x="13.2" y="16.2" width="4.2" height="7" rx="2.1" fill={`url(#${gradEye})`} />
      <rect x="22.6" y="16.2" width="4.2" height="7" rx="2.1" fill={`url(#${gradEye})`} />
      <circle cx="14.6" cy="17.8" r="0.85" fill="#ffffff" />
      <circle cx="24.0" cy="17.8" r="0.85" fill="#ffffff" />

      {/* 4-point creative spark on upper-right rim */}
      <path
        d="M32.2 6.2L33.0 8.4L35.2 9.2L33.0 10.0L32.2 12.2L31.4 10.0L29.2 9.2L31.4 8.4Z"
        fill="#fef08a"
      />
    </svg>
  );
}
