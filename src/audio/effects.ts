// The starter sound effects, made here from simple maths rather than recordings, so they carry no
// licence of their own and need nothing from the internet. Each is a 16-bit mono WAV.
const RATE = 44100;

/** A repeatable random stream, so an effect sounds the same every time it is made. */
function noise(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s / 0xffffffff) * 2 - 1; };
}

function wav(samples: Float32Array): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, RATE, true); out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  text(36, 'data'); out.setUint32(40, samples.length * 2, true);
  let peak = 0.0001;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const k = 0.89 / peak; // normalise to just under full scale
  samples.forEach((v, i) => out.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, v * k)) * 32767), true));
  return new Uint8Array(out.buffer);
}

const buffer = (seconds: number) => new Float32Array(Math.round(seconds * RATE));

/** A phone vibrating on a desk: three buzzes. */
function phoneBuzz(): Float32Array {
  const out = buffer(1.9), rnd = noise(7);
  for (let b = 0; b < 3; b++) {
    const start = b * 0.62, len = 0.4;
    for (let i = 0; i < len * RATE; i++) {
      const t = i / RATE, env = Math.min(1, t / 0.02) * Math.min(1, (len - t) / 0.03);
      const motor = Math.sign(Math.sin(2 * Math.PI * 152 * t)) * 0.5 + Math.sin(2 * Math.PI * 304 * t) * 0.3;
      const rattle = rnd() * 0.25 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 38 * t));
      out[Math.round(start * RATE) + i] += (motor + rattle) * env;
    }
  }
  return out;
}

/** Three knocks on a wooden door. */
function doorKnock(): Float32Array {
  const out = buffer(1.0), rnd = noise(11);
  for (let k = 0; k < 3; k++) {
    const start = Math.round((0.05 + k * 0.22) * RATE);
    for (let i = 0; i < 0.18 * RATE; i++) {
      const t = i / RATE, body = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 32), click = rnd() * Math.exp(-t * 400);
      out[start + i] += body * 0.9 + click * 0.5;
    }
  }
  return out;
}

/** A door swinging shut: a creak, a thump and the latch. */
function doorClose(): Float32Array {
  const out = buffer(1.2), rnd = noise(23);
  let lp = 0;
  for (let i = 0; i < 0.5 * RATE; i++) { // creak: a scraping tone that wavers
    const t = i / RATE, f = 420 + 60 * Math.sin(2 * Math.PI * 3 * t);
    lp += (rnd() - lp) * 0.08;
    out[i] = (Math.sin(2 * Math.PI * f * t) * 0.15 + lp * 0.4) * Math.sin(Math.PI * t / 0.5) * 0.6;
  }
  const hit = Math.round(0.55 * RATE);
  for (let i = 0; i < 0.6 * RATE; i++) { // thump
    const t = i / RATE;
    out[hit + i] += Math.sin(2 * Math.PI * 62 * t) * Math.exp(-t * 9) + rnd() * Math.exp(-t * 60) * 0.4;
  }
  const latch = Math.round(0.62 * RATE);
  for (let i = 0; i < 0.05 * RATE; i++) out[latch + i] += rnd() * Math.exp(-(i / RATE) * 150) * 0.6; // click
  return out;
}

/** Four steps on a hard floor. */
function footsteps(): Float32Array {
  const out = buffer(2.2), rnd = noise(31);
  for (let s = 0; s < 4; s++) {
    const start = Math.round((0.08 + s * 0.5) * RATE);
    let lp = 0;
    for (let i = 0; i < 0.22 * RATE; i++) {
      const t = i / RATE;
      lp += (rnd() - lp) * 0.25; // heel scuff, softened
      out[start + i] += lp * Math.exp(-t * 28) * 0.9 + Math.sin(2 * Math.PI * 85 * t) * Math.exp(-t * 40) * 0.6;
    }
  }
  return out;
}

export const EFFECTS = {
  phone_buzz: { label: 'Phone buzz', make: phoneBuzz },
  door_knock: { label: 'Door knock', make: doorKnock },
  door_close: { label: 'Door closing', make: doorClose },
  footsteps: { label: 'Footsteps', make: footsteps },
} as const;
export type EffectId = keyof typeof EFFECTS;

/** The WAV file for a starter effect. */
export const effectWav = (id: EffectId) => wav(EFFECTS[id].make());
