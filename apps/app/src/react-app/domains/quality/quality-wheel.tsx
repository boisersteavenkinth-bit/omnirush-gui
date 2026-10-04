/** @jsxImportSource react */
import { useEffect, useMemo, useRef } from "react";

import {
  jackpotIndex,
  sliceAtPointer,
  wheelAngleAt,
  wheelOvershoot,
  wheelSlices,
  wheelTargetRotation,
  type WheelSegment,
} from "../../../app/lib/quality";
import { compactTokenCount } from "../../../app/lib/omnirush-usage";
import { createWheelSounds, type WheelSounds } from "./wheel-sounds";
import { burstConfetti } from "./wheel-confetti";

export type QualityWheelProps = {
  segments: WheelSegment[];
  /** The server's `segment_index`; null leaves the wheel at rest. */
  targetIndex: number | null;
  /** Changes for every spin, so a second spin to the same index spins again. */
  spinId?: string | number;
  onDone?: () => void;
  celebrate?: "none" | "big" | "jackpot";
  nearMiss?: boolean;
  soundEnabled?: boolean;
  reducedMotion?: boolean;
  /** Pixel size of the wheel (square). */
  size?: number;
  durationMs?: number;
  /** The top prize (GET /me/quality `jackpot_tokens`); the biggest segment otherwise. */
  jackpotTokens?: number | null;
};

/** Low prizes in slate and teal, rising to the lime jackpot. */
const SEGMENT_COLORS = ["#1e293b", "#334155", "#115e59", "#3f6212", "#65a30d", "#a3e635"];
const SEGMENT_TEXT = ["#cbd5e1", "#e2e8f0", "#ccfbf1", "#ecfccb", "#f7fee7", "#1a2e05"];
const RADIUS = 100;
const LABEL_INSIDE_MIN_DEGREES = 14;

function point(angle: number, radius: number): [number, number] {
  const radians = (angle * Math.PI) / 180;
  return [radius * Math.sin(radians), -radius * Math.cos(radians)];
}

function slicePath(start: number, end: number): string {
  const [x1, y1] = point(start, RADIUS);
  const [x2, y2] = point(end, RADIUS);
  const large = end - start > 180 ? 1 : 0;
  return `M0 0 L${x1.toFixed(3)} ${y1.toFixed(3)} A${RADIUS} ${RADIUS} 0 ${large} 1 ${x2.toFixed(3)} ${y2.toFixed(3)} Z`;
}

function colorFor(index: number, count: number, palette: string[]): string {
  // Spread the palette over the segments so the top prize always gets the lime.
  const at = count <= 1 ? palette.length - 1 : Math.round((index * (palette.length - 1)) / (count - 1));
  return palette[at] ?? palette[0];
}

/**
 * The quality-rewards wheel: slices sized by the real odds, a pointer that
 * ticks over every boundary, a spin that accelerates, decelerates for a long
 * time, overshoots a little and settles on `targetIndex`. The server chose
 * the index; this only animates to it.
 */
export function QualityWheel(props: QualityWheelProps) {
  const {
    segments,
    targetIndex,
    spinId,
    onDone,
    celebrate = "none",
    soundEnabled = false,
    reducedMotion = false,
    size = 320,
    durationMs = 5600,
  } = props;
  const slices = useMemo(() => wheelSlices(segments), [segments]);
  const wheelRef = useRef<SVGGElement | null>(null);
  const pointerRef = useRef<SVGGElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const confettiRef = useRef<HTMLCanvasElement | null>(null);
  const rotation = useRef(0);
  const sounds = useRef<WheelSounds | null>(null);
  const soundOn = useRef(soundEnabled);
  soundOn.current = soundEnabled;
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => () => sounds.current?.dispose(), []);

  useEffect(() => {
    if (targetIndex === null || targetIndex < 0 || targetIndex >= segments.length) return;
    const root = rootRef.current;
    const apply = (angle: number) => {
      rotation.current = angle;
      wheelRef.current?.setAttribute("transform", `rotate(${angle.toFixed(3)})`);
      root?.setAttribute("data-rotation", angle.toFixed(2));
    };
    const finish = () => {
      root?.setAttribute("data-spinning", "false");
      root?.setAttribute("data-landed-index", String(targetIndex));
      if (celebrate !== "none" && !reducedMotion && confettiRef.current) {
        burstConfetti(confettiRef.current, celebrate);
      }
      if (soundOn.current) {
        sounds.current ??= createWheelSounds();
        sounds.current?.win(celebrate);
      }
      done.current?.();
    };
    // A small random offset inside the slice: the pointer never rests on a line.
    const offset = (Math.random() - 0.5) * 0.9;
    const from = rotation.current;
    const to = wheelTargetRotation(segments, targetIndex, from, 6, offset);
    root?.setAttribute("data-spinning", "true");
    root?.removeAttribute("data-landed-index");
    if (reducedMotion) {
      apply(to);
      const timer = window.setTimeout(finish, 0);
      return () => window.clearTimeout(timer);
    }
    const overshoot = wheelOvershoot(segments, targetIndex, offset);
    let lastSlice = sliceAtPointer(slices, from);
    let frame = 0;
    let kick = 0;
    const started = performance.now();
    const step = (now: number) => {
      const progress = (now - started) / durationMs;
      const angle = wheelAngleAt(progress, from, to, overshoot);
      apply(angle);
      const slice = sliceAtPointer(slices, angle);
      if (slice !== lastSlice) {
        lastSlice = slice;
        kick = 1;
        if (soundOn.current) {
          sounds.current ??= createWheelSounds();
          sounds.current?.tick();
        }
      }
      // The pointer flicks back on every boundary and springs home.
      kick *= 0.82;
      pointerRef.current?.setAttribute("transform", `rotate(${(-22 * kick).toFixed(2)} 0 -112)`);
      if (progress < 1) {
        frame = requestAnimationFrame(step);
      } else {
        apply(to);
        pointerRef.current?.setAttribute("transform", "rotate(0 0 -112)");
        finish();
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // A new spin is a new `spinId` or target; the rest is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIndex, spinId]);

  const jackpot = jackpotIndex(segments, props.jackpotTokens);
  return (
    <div
      ref={rootRef}
      className="relative mx-auto"
      style={{ width: size, height: size }}
      data-testid="quality-wheel"
      data-spinning="false"
      data-rotation="0"
    >
      <svg viewBox="-130 -130 260 260" width={size} height={size} role="img" aria-label="Prize wheel">
        <defs>
          <radialGradient id="quality-wheel-hub" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#1f2937" />
            <stop offset="100%" stopColor="#030712" />
          </radialGradient>
          <filter id="quality-wheel-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle r={RADIUS + 9} fill="#0b1120" stroke="#a3e635" strokeOpacity={0.55} strokeWidth={2} filter="url(#quality-wheel-glow)" />
        <g ref={wheelRef} transform="rotate(0)">
          {slices.map((slice) => {
            const fill = colorFor(slice.index, slices.length, SEGMENT_COLORS);
            const ink = colorFor(slice.index, slices.length, SEGMENT_TEXT);
            const wide = slice.end - slice.start >= LABEL_INSIDE_MIN_DEGREES;
            const label = compactTokenCount(slice.segment.tokens);
            const [lx, ly] = point(slice.mid, wide ? 68 : 90);
            return (
              <g key={slice.index} data-segment-index={slice.index}>
                <path d={slicePath(slice.start, slice.end)} fill={fill} stroke="#020617" strokeWidth={1.2} />
                {slice.index === jackpot ? (
                  <path d={slicePath(slice.start, slice.end)} fill="#ecfccb" opacity={0.35} filter="url(#quality-wheel-glow)" />
                ) : null}
                <text
                  x={lx}
                  y={ly}
                  fill={ink}
                  fontSize={wide ? 13 : 7.5}
                  fontWeight={700}
                  textAnchor="middle"
                  dominantBaseline="central"
                  transform={`rotate(${wide ? slice.mid : slice.mid - 90} ${lx} ${ly})`}
                  style={{ fontFamily: "ui-sans-serif, system-ui", letterSpacing: "0.02em" }}
                >
                  {label}
                </text>
              </g>
            );
          })}
          {slices.map((slice) => {
            const [x, y] = point(slice.start, RADIUS + 4.5);
            return <circle key={`bulb-${slice.index}`} cx={x} cy={y} r={2.6} fill="#f7fee7" className="quality-wheel-bulb" />;
          })}
        </g>
        <circle r={24} fill="url(#quality-wheel-hub)" stroke="#a3e635" strokeWidth={2} />
        <text y={1} fill="#a3e635" fontSize={10} fontWeight={800} textAnchor="middle" dominantBaseline="central" style={{ letterSpacing: "0.12em" }}>
          SPIN
        </text>
        <g ref={pointerRef} transform="rotate(0 0 -112)">
          <path d="M0 -94 L-11 -122 L11 -122 Z" fill="#a3e635" stroke="#0b1120" strokeWidth={2} strokeLinejoin="round" />
          <circle cx={0} cy={-118} r={3} fill="#0b1120" />
        </g>
      </svg>
      <canvas
        ref={confettiRef}
        className="pointer-events-none absolute"
        style={{ inset: -size * 0.35, width: size * 1.7, height: size * 1.7 }}
        aria-hidden="true"
      />
    </div>
  );
}
