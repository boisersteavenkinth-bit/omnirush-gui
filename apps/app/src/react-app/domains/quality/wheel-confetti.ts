// A confetti burst on a canvas over the wheel: "big" wins get one burst,
// the jackpot three bigger ones with gold. Never runs with reduced motion.

const COLORS = ["#a3e635", "#d9f99d", "#f7fee7", "#facc15", "#22d3ee", "#ffffff"];
const JACKPOT_COLORS = ["#facc15", "#fde047", "#a3e635", "#fef9c3", "#ffffff", "#f59e0b"];

type Particle = { x: number; y: number; vx: number; vy: number; spin: number; angle: number; size: number; color: string; life: number };

export function burstConfetti(canvas: HTMLCanvasElement, celebrate: "big" | "jackpot"): () => void {
  const scale = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  if (!context) return () => undefined;
  context.scale(scale, scale);
  const particles: Particle[] = [];
  const palette = celebrate === "jackpot" ? JACKPOT_COLORS : COLORS;
  const burst = (count: number, power: number) => {
    for (let index = 0; index < count; index += 1) {
      const direction = Math.random() * Math.PI * 2;
      const speed = power * (0.35 + Math.random() * 0.65);
      particles.push({
        x: width / 2,
        y: height / 2,
        vx: Math.cos(direction) * speed,
        vy: Math.sin(direction) * speed - power * 0.35,
        spin: (Math.random() - 0.5) * 0.4,
        angle: Math.random() * Math.PI,
        size: 4 + Math.random() * 5,
        color: palette[index % palette.length],
        life: 1,
      });
    }
  };
  const timers: number[] = [];
  if (celebrate === "jackpot") {
    burst(200, 11);
    timers.push(window.setTimeout(() => burst(160, 9), 350));
    timers.push(window.setTimeout(() => burst(160, 12), 800));
  } else {
    burst(130, 9);
  }
  let frame = 0;
  const started = performance.now();
  const lifetime = celebrate === "jackpot" ? 3_600 : 2_400;
  const step = (now: number) => {
    context.clearRect(0, 0, width, height);
    for (const particle of particles) {
      particle.vy += 0.22;
      particle.vx *= 0.985;
      particle.vy *= 0.985;
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.angle += particle.spin;
      particle.life = Math.max(0, particle.life - 0.008);
      context.save();
      context.globalAlpha = particle.life;
      context.translate(particle.x, particle.y);
      context.rotate(particle.angle);
      context.fillStyle = particle.color;
      context.fillRect(-particle.size / 2, -particle.size / 4, particle.size, particle.size / 2);
      context.restore();
    }
    if (now - started < lifetime) frame = requestAnimationFrame(step);
    else context.clearRect(0, 0, width, height);
  };
  frame = requestAnimationFrame(step);
  return () => {
    cancelAnimationFrame(frame);
    timers.forEach((timer) => window.clearTimeout(timer));
    context.clearRect(0, 0, width, height);
  };
}
