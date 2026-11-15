// Sound with the Web Audio API: playback in step with the timeline, a loudness
// curve per frame (for waveforms and mouth flaps), and a mixed-down track for export.
import { FPS, type AudioClip, type Shot } from '../model/shot';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private volumes = new Map<string, Float32Array>();
  private playing: AudioBufferSourceNode[] = [];

  private context(): AudioContext {
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Decode a sound file once. Throws if the browser cannot read it. */
  async load(file: string, bytes: Uint8Array): Promise<AudioBuffer> {
    const have = this.buffers.get(file);
    if (have) return have;
    const buffer = await this.context().decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    this.buffers.set(file, buffer);
    return buffer;
  }
  buffer(file: string) { return this.buffers.get(file) ?? null; }
  frames(file: string) { const b = this.buffers.get(file); return b ? Math.ceil(b.duration * FPS) : 0; }

  /** Loudness (RMS, 0..1) for each frame of a sound. */
  volume(file: string): Float32Array {
    const cached = this.volumes.get(file);
    if (cached) return cached;
    const b = this.buffers.get(file);
    if (!b) return new Float32Array(0);
    const per = b.sampleRate / FPS, out = new Float32Array(Math.ceil(b.length / per));
    const channels = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
    for (let f = 0; f < out.length; f++) {
      let sum = 0, n = 0;
      for (let i = Math.floor(f * per), end = Math.min(b.length, Math.floor((f + 1) * per)); i < end; i++) {
        for (const ch of channels) { sum += ch[i] * ch[i]; n++; }
      }
      out[f] = n ? Math.sqrt(sum / n) : 0;
    }
    this.volumes.set(file, out);
    return out;
  }

  private start(ctx: BaseAudioContext, clip: AudioClip, fromFrame: number, when: number, duration?: number): AudioBufferSourceNode | null {
    const buffer = this.buffers.get(clip.file);
    if (!buffer) return null;
    const offset = (fromFrame - clip.start) / FPS;
    if (offset >= buffer.duration) return null;
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buffer;
    gain.gain.value = clip.gain;
    src.connect(gain).connect(ctx.destination);
    src.start(when + Math.max(0, -offset), Math.max(0, offset), duration);
    return src;
  }

  /** Play every clip from a frame. */
  play(shot: Shot, frame: number) {
    this.stop();
    const ctx = this.context();
    for (const clip of shot.audio) {
      const src = this.start(ctx, clip, frame, ctx.currentTime);
      if (src) this.playing.push(src);
    }
  }
  /** A short blip of sound at a frame, heard while scrubbing. */
  scrub(shot: Shot, frame: number) {
    this.stop();
    const ctx = this.context();
    for (const clip of shot.audio) {
      if (frame < clip.start) continue;
      const src = this.start(ctx, clip, frame, ctx.currentTime, 2 / FPS);
      if (src) this.playing.push(src);
    }
  }
  stop() {
    for (const s of this.playing) { try { s.stop(); } catch { /* already ended */ } }
    this.playing = [];
  }

  /** All clips mixed into one stereo track the length of the shot, or null if the shot is silent. */
  async mixdown(shot: Shot, sampleRate = 48000): Promise<AudioBuffer | null> {
    if (!shot.audio.some((c) => this.buffers.has(c.file))) return null;
    const off = new OfflineAudioContext(2, Math.ceil((shot.length / FPS) * sampleRate), sampleRate);
    for (const clip of shot.audio) this.start(off, clip, 0, 0);
    return off.startRendering();
  }
}
