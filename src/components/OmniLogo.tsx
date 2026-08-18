import React from "react";

interface OmniLogoProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
  className?: string;
  glow?: boolean;
}

export const OmniLogo: React.FC<OmniLogoProps> = ({
  size = 24,
  className = "",
  glow = true,
  ...props
}) => {
  const id = React.useId();
  const gradOuter = `omni-grad-outer-${id}`;
  const gradInner = `omni-grad-inner-${id}`;
  const gradRing = `omni-grad-ring-${id}`;
  const glowFilter = `omni-glow-${id}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`inline-block transition-transform duration-300 hover:scale-105 ${className}`}
      {...props}
    >
      <defs>
        {/* Glowing aura filter */}
        <filter id={glowFilter} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>

        {/* Primary gradient: Electric Cyan to Vivid Violet */}
        <linearGradient id={gradOuter} x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00F0FF" />
          <stop offset="50%" stopColor="#7000FF" />
          <stop offset="100%" stopColor="#FF007A" />
        </linearGradient>

        {/* Inner geometric core gradient */}
        <linearGradient id={gradInner} x1="12" y1="12" x2="36" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00F0FF" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#7B2CBF" stopOpacity="0.9" />
        </linearGradient>

        {/* Metallic chrome ring */}
        <linearGradient id={gradRing} x1="6" y1="24" x2="42" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#E2E8F0" />
          <stop offset="50%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#C084FC" />
        </linearGradient>
      </defs>

      {/* Ambient background glow if enabled */}
      {glow && (
        <circle
          cx="24"
          cy="24"
          r="16"
          fill="url(#"
          fillOpacity="0.15"
          filter={`url(#${glowFilter})`}
        />
      )}

      {/* Outer Hexagonal Matrix / Shield */}
      <path
        d="M24 3L42 13.5V34.5L24 45L6 34.5V13.5L24 3Z"
        stroke={`url(#${gradOuter})`}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* Inner Interconnected Dimensional Cube */}
      <path
        d="M24 13.5L34 19.5V31.5L24 37.5L14 31.5V19.5L24 13.5Z"
        stroke={`url(#${gradInner})`}
        strokeWidth="1.75"
        strokeLinejoin="round"
        fill="#050814"
        fillOpacity="0.8"
      />

      {/* Internal Axis Nodes & Coordinate Connectors */}
      <path
        d="M24 13.5V25.5M24 25.5L34 31.5M24 25.5L14 31.5"
        stroke="#00F0FF"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <path
        d="M24 3V13.5M42 13.5L34 19.5M42 34.5L34 31.5M24 45V37.5M6 34.5L14 31.5M6 13.5L14 19.5"
        stroke={`url(#${gradRing})`}
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeOpacity="0.75"
      />

      {/* Central Core Luminescence Point */}
      <circle cx="24" cy="25.5" r="2.25" fill="#FFFFFF" filter={`url(#${glowFilter})`} />
      <circle cx="24" cy="25.5" r="1.25" fill="#00F0FF" />
    </svg>
  );
};
