// Wheel sounds, made with WebAudio (no files to ship). Off unless the user
// turns them on in the spin dialog.

export type WheelSounds = {
  tick: () => void;
  win: (celebrate: "none" | "big" | "jackpot") => void;
  dispose: () => void;
};

type AudioContextConstructor = typeof AudioContext;

export function createWheelSounds(): WheelSounds | null {
  if (typeof window === "undefined") return null;
  const Context = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext) as
    | AudioContextConstructor
    | undefined;
  if (!Context) return null;
  let context: AudioContext;
  try {
    context = new Context();
  } catch {
    return null;
  }

  const tone = (frequency: number, at: number, length: number, volume: number, type: OscillatorType) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + length + 0.02);
  };

  return {
    tick() {
      if (context.state === "suspended") void context.resume();
      tone(1_700, context.currentTime, 0.03, 0.08, "square");
    },
    win(celebrate) {
      if (context.state === "suspended") void context.resume();
      const now = context.currentTime;
      const notes = celebrate === "jackpot"
        ? [523, 659, 784, 1047, 784, 1047, 1319, 1568]
        : celebrate === "big"
          ? [523, 659, 784, 1047]
          : [659, 880];
      notes.forEach((note, index) => tone(note, now + index * 0.09, 0.22, 0.12, "triangle"));
    },
    dispose() {
      void context.close().catch(() => undefined);
    },
  };
}
