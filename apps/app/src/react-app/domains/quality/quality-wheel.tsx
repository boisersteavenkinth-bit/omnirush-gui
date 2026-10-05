/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";

import {
  sliceAtPointer,
  wheelEaseOut,
  wheelSlices,
  wheelTargetRotation,
  type WheelSegment,
} from "../../../app/lib/quality";
import { createWheelSounds, type WheelSounds } from "./wheel-sounds";

export type QualityWheelProps = {
  segments: WheelSegment[];
  /** The server's `segment_index`; null leaves the wheel at rest. */
  targetIndex: number | null;
  /** Changes for every spin, so a second spin to the same index spins again. */
  spinId?: string | number;
  onDone?: () => void;
  celebrate?: "none" | "big" | "jackpot";
  soundEnabled?: boolean;
  reducedMotion?: boolean;
  /** Pixel size of the wheel (square). */
  size?: number;
  durationMs?: number;
};

const RADIUS = 100;
/** Full turns before the stop: with the ease-out this reads as one calm spin. */
const TURNS = 4;

/**
 * Neutral tints from the theme (Radix slate, so light and dark both follow the
 * app), rising with the prize. The legend uses the same tints as swatches.
 */
export function wheelSliceFill(index: number, count: number): string {
  const steps = [4, 5, 6, 7, 8, 9];
  const at = count <= 1 ? 0 : Math.round((index * (steps.length - 1)) / (count - 1));
  return `var(--slate-${steps[at] ?? 4})`;
}

/** The landed slice and its legend swatch: the brand accent. */
export const WHEEL_LANDED_FILL = "var(--lime-9)";

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

/**
 * The quality-rewards wheel: flat slices sized by the real odds, a small
 * pointer at the top, one ease-out spin that stops on `targetIndex`, and the
 * landed slice in the accent. The server chose the index; this only animates to it.
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
    size = 200,
    durationMs = 3_600,
  } = props;
  const slices = useMemo(() => wheelSlices(segments), [segments]);
  const wheelRef = useRef<SVGGElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rotation = useRef(0);
  const sounds = useRef<WheelSounds | null>(null);
  const soundOn = useRef(soundEnabled);
  soundOn.current = soundEnabled;
  const done = useRef(onDone);
  done.current = onDone;
  const [landed, setLanded] = useState<number | null>(null);

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
      setLanded(targetIndex);
      if (soundOn.current) {
        sounds.current ??= createWheelSounds();
        sounds.current?.win(celebrate);
      }
      done.current?.();
    };
    // A small random offset inside the slice: the pointer never rests on a line.
    const offset = (Math.random() - 0.5) * 0.9;
    const from = rotation.current;
    const to = wheelTargetRotation(segments, targetIndex, from, TURNS, offset);
    setLanded(null);
    root?.setAttribute("data-spinning", "true");
    root?.removeAttribute("data-landed-index");
    if (reducedMotion) {
      apply(to);
      const timer = window.setTimeout(finish, 0);
      return () => window.clearTimeout(timer);
    }
    let lastSlice = sliceAtPointer(slices, from);
    let frame = 0;
    const started = performance.now();
    const step = (now: number) => {
      const progress = (now - started) / durationMs;
      const angle = wheelEaseOut(progress, from, to);
      apply(angle);
      const slice = sliceAtPointer(slices, angle);
      if (slice !== lastSlice) {
        lastSlice = slice;
        if (soundOn.current) {
          sounds.current ??= createWheelSounds();
          sounds.current?.tick();
        }
      }
      if (progress < 1) {
        frame = requestAnimationFrame(step);
      } else {
        apply(to);
        finish();
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // A new spin is a new `spinId` or target; the rest is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIndex, spinId]);

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      style={{ width: size, height: size }}
      data-testid="quality-wheel"
      data-spinning="false"
      data-rotation="0"
    >
      <svg viewBox="-108 -108 216 216" width={size} height={size} role="img" aria-label="Prize wheel">
        <g ref={wheelRef}>
          {slices.map((slice) => (
            <path
              key={slice.index}
              data-segment-index={slice.index}
              d={slicePath(slice.start, slice.end)}
              style={{
                fill: slice.index === landed ? WHEEL_LANDED_FILL : wheelSliceFill(slice.index, slices.length),
                transition: reducedMotion ? undefined : "fill 300ms ease-out",
              }}
              stroke="var(--popover)"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          ))}
        </g>
        <circle r={RADIUS} fill="none" stroke="var(--border)" strokeWidth={1} />
        <circle r={13} fill="var(--popover)" stroke="var(--border)" strokeWidth={1} />
        <path d="M0 -92 L-6 -105 L6 -105 Z" fill="var(--foreground)" stroke="var(--popover)" strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
    </div>
  );
}
