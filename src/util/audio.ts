// Tiny WebAudio cue generator + ambient drone — no external samples needed.

let ctx: AudioContext | null = null;
let droneNodes: { osc: OscillatorNode[]; gain: GainNode } | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  return ctx;
}

interface Cue {
  freq: number;
  toFreq?: number;
  duration: number;
  type?: OscillatorType;
  gain?: number;
}

const CUES: Record<string, Cue> = {
  click: { freq: 880, toFreq: 1320, duration: 0.08, type: "sine", gain: 0.06 },
  hover: { freq: 660, duration: 0.04, type: "sine", gain: 0.03 },
  launch: { freq: 110, toFreq: 880, duration: 1.6, type: "sawtooth", gain: 0.12 },
  warp: { freq: 220, toFreq: 70, duration: 0.9, type: "triangle", gain: 0.1 },
  arrive: { freq: 440, toFreq: 220, duration: 0.6, type: "sine", gain: 0.08 },
  land: { freq: 90, duration: 0.5, type: "sawtooth", gain: 0.1 },
  alert: { freq: 1200, duration: 0.18, type: "square", gain: 0.05 },
};

export function playCue(name: keyof typeof CUES): void {
  const audioCtx = getCtx();
  if (!audioCtx) return;
  const cue = CUES[name];
  if (!cue) return;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = cue.type ?? "sine";
  osc.frequency.setValueAtTime(cue.freq, audioCtx.currentTime);
  if (cue.toFreq !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(
      cue.toFreq,
      audioCtx.currentTime + cue.duration,
    );
  }
  gain.gain.setValueAtTime(cue.gain ?? 0.05, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    audioCtx.currentTime + cue.duration,
  );

  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + cue.duration + 0.05);
}

export function unlockAudio(): void {
  // Call from a user gesture to satisfy autoplay policies.
  void getCtx();
}

/** Start an ambient detuned-saw drone — used during in-flight transit. */
export function startDrone(targetGain = 0.04): void {
  const audioCtx = getCtx();
  if (!audioCtx || droneNodes) return;
  const gain = audioCtx.createGain();
  gain.gain.value = 0;
  gain.gain.linearRampToValueAtTime(targetGain, audioCtx.currentTime + 1.5);
  const osc1 = audioCtx.createOscillator();
  const osc2 = audioCtx.createOscillator();
  const osc3 = audioCtx.createOscillator();
  osc1.type = "sawtooth";
  osc2.type = "sawtooth";
  osc3.type = "sine";
  osc1.frequency.value = 55;
  osc2.frequency.value = 55 * 1.005;
  osc3.frequency.value = 110;
  osc1.connect(gain);
  osc2.connect(gain);
  osc3.connect(gain);
  gain.connect(audioCtx.destination);
  osc1.start();
  osc2.start();
  osc3.start();
  droneNodes = { osc: [osc1, osc2, osc3], gain };
}

export function stopDrone(): void {
  const audioCtx = getCtx();
  if (!audioCtx || !droneNodes) return;
  const { osc, gain } = droneNodes;
  gain.gain.cancelScheduledValues(audioCtx.currentTime);
  gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.5);
  setTimeout(() => {
    osc.forEach((o) => {
      try {
        o.stop();
      } catch {}
    });
    droneNodes = null;
  }, 700);
}
