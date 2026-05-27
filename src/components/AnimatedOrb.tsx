import type { CSSProperties } from "react";
import "./AnimatedOrb.css";

interface AnimatedOrbProps {
  size?: number | string;
  intensity?: number;
  speed?: number;
  className?: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatSize(size: number | string) {
  return typeof size === "number" ? `${size}px` : size;
}

function formatDuration(seconds: number, speed: number) {
  return `${seconds / speed}s`;
}

export default function AnimatedOrb({
  size = 256,
  intensity = 1,
  speed = 1,
  className = "",
}: AnimatedOrbProps) {
  const visualIntensity = clamp(intensity, 0.45, 1.8);
  const visualSpeed = clamp(speed, 0.35, 2.4);
  const style = {
    "--animated-orb-size": formatSize(size),
    "--animated-orb-intensity": visualIntensity,
    "--animated-orb-speed": visualSpeed,
    "--animated-orb-duration": formatDuration(9, visualSpeed),
    "--animated-orb-drift-duration": formatDuration(16, visualSpeed),
    "--animated-orb-drift-soft-duration": formatDuration(19, visualSpeed),
    "--animated-orb-drift-slow-duration": formatDuration(22, visualSpeed),
    "--animated-orb-shimmer-duration": formatDuration(6.5, visualSpeed),
    "--animated-orb-sheen-one-duration": formatDuration(8.5, visualSpeed),
    "--animated-orb-sheen-two-duration": formatDuration(10, visualSpeed),
  } as CSSProperties;

  return (
    <div
      aria-hidden
      className={`animated-orb ${className}`.trim()}
      style={style}
    >
      <span className="animated-orb__ambient animated-orb__ambient--cyan" />
      <span className="animated-orb__ambient animated-orb__ambient--coral" />
      <span className="animated-orb__trail animated-orb__trail--one" />
      <span className="animated-orb__trail animated-orb__trail--two" />
      <span className="animated-orb__trail animated-orb__trail--three" />
      <span className="animated-orb__rim" />
      <span className="animated-orb__glass" />
      <span className="animated-orb__core" />
      <span className="animated-orb__sheen animated-orb__sheen--one" />
      <span className="animated-orb__sheen animated-orb__sheen--two" />
      <span className="animated-orb__grain" />
    </div>
  );
}
