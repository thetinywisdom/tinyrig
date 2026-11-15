// Video export, rendered locally: WebCodecs encodes the frames and sound, an
// open-source muxer wraps them into an MP4. Also PNG sequences.
import { zipSync } from 'fflate';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { FPS } from '../model/shot';

type VCodec = { muxer: 'avc' | 'vp9' | 'av1'; codec: string; label: string };
type ACodec = { muxer: 'aac' | 'opus'; codec: string; label: string };
// H.264 + AAC plays everywhere. The others are fallbacks for browsers built without those encoders.
const VIDEO: VCodec[] = [
  { muxer: 'avc', codec: 'avc1.640028', label: 'H.264' },
  { muxer: 'avc', codec: 'avc1.42E028', label: 'H.264' },
  { muxer: 'vp9', codec: 'vp09.00.40.08', label: 'VP9' },
  { muxer: 'av1', codec: 'av01.0.08M.08', label: 'AV1' },
];
const AUDIO: ACodec[] = [
  { muxer: 'aac', codec: 'mp4a.40.2', label: 'AAC' },
  { muxer: 'opus', codec: 'opus', label: 'Opus' },
];

export const canExportVideo = () => 'VideoEncoder' in window;

async function pickVideo(width: number, height: number, bitrate: number) {
  for (const v of VIDEO) {
    const config: VideoEncoderConfig = { codec: v.codec, width, height, bitrate, framerate: FPS };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { v, config }; } catch { /* try the next */ }
  }
  return null;
}
async function pickAudio(sampleRate: number) {
  if (!('AudioEncoder' in window)) return null;
  for (const a of AUDIO) {
    const config: AudioEncoderConfig = { codec: a.codec, sampleRate, numberOfChannels: 2, bitrate: 160_000 };
    try { if ((await AudioEncoder.isConfigSupported(config)).supported) return { a, config }; } catch { /* try the next */ }
  }
  return null;
}

export interface VideoResult { bytes: Uint8Array; video: string; audio: string | null; note: string | null }

/**
 * Encode `frames` pictures (drawn by `render`, which must return a canvas of exactly width x height)
 * plus an optional sound track into an MP4.
 */
export async function exportMp4(opts: {
  width: number; height: number; frames: number;
  render: (frame: number) => HTMLCanvasElement | Promise<HTMLCanvasElement>;
  sound: AudioBuffer | null;
  onProgress?: (done: number, total: number) => void;
  cancelled?: () => boolean;
}): Promise<VideoResult> {
  const { width, height, frames } = opts;
  if (!canExportVideo()) throw new Error('This browser cannot encode video. Use Chrome or Edge, or export a PNG sequence.');
  const video = await pickVideo(width, height, 8_000_000);
  if (!video) throw new Error('This browser has no video encoder for this frame size. Export a PNG sequence instead.');
  const audio = opts.sound ? await pickAudio(opts.sound.sampleRate) : null;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(), fastStart: 'in-memory',
    video: { codec: video.v.muxer, width, height, frameRate: FPS },
    ...(audio ? { audio: { codec: audio.a.muxer, sampleRate: opts.sound!.sampleRate, numberOfChannels: 2 } } : {}),
  });

  let failure: Error | null = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  venc.configure(video.config);
  const micro = 1_000_000 / FPS;
  for (let f = 0; f < frames; f++) {
    if (failure) throw failure;
    if (opts.cancelled?.()) { venc.close(); throw new Error('Export cancelled.'); }
    const canvas = await opts.render(f);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(f * micro), duration: Math.round(micro) });
    venc.encode(frame, { keyFrame: f % (FPS * 2) === 0 });
    frame.close();
    opts.onProgress?.(f + 1, frames);
    // Let the encoder catch up and the page repaint its progress.
    while (venc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 4));
    if (f % 8 === 0) await new Promise((r) => setTimeout(r));
  }
  await venc.flush();
  venc.close();

  if (audio && opts.sound) {
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { failure = e; } });
    aenc.configure(audio.config);
    const s = opts.sound, block = 4096;
    const left = s.getChannelData(0), right = s.numberOfChannels > 1 ? s.getChannelData(1) : left;
    for (let at = 0; at < s.length; at += block) {
      const n = Math.min(block, s.length - at);
      const data = new Float32Array(n * 2);
      data.set(left.subarray(at, at + n), 0);
      data.set(right.subarray(at, at + n), n);
      const chunk = new AudioData({ format: 'f32-planar', sampleRate: s.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((at / s.sampleRate) * 1e6), data });
      aenc.encode(chunk);
      chunk.close();
    }
    await aenc.flush();
    aenc.close();
  }
  if (failure) throw failure;
  muxer.finalize();

  const notes: string[] = [];
  if (video.v.muxer !== 'avc') notes.push(`this browser has no H.264 encoder, so the video is ${video.v.label}`);
  if (opts.sound && !audio) notes.push('this browser cannot encode sound, so the video is silent');
  else if (audio && audio.a.muxer !== 'aac') notes.push(`the sound is ${audio.a.label}, not AAC`);
  return {
    bytes: new Uint8Array(muxer.target.buffer), video: video.v.label, audio: audio?.a.label ?? null,
    note: notes.length ? `Note: ${notes.join(' and ')}. Some players and sites may refuse it; exporting from Chrome or Edge gives H.264 with AAC.` : null,
  };
}

const pngBytes = (canvas: HTMLCanvasElement) => new Promise<Uint8Array>((resolve, reject) =>
  canvas.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error('Could not make a PNG.'))), 'image/png'));

export async function exportPng(canvas: HTMLCanvasElement): Promise<Uint8Array> { return pngBytes(canvas); }

/** Every frame as a numbered PNG, zipped. */
export async function exportPngSequence(frames: number, render: (frame: number) => HTMLCanvasElement | Promise<HTMLCanvasElement>, onProgress?: (done: number, total: number) => void, cancelled?: () => boolean): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (let f = 0; f < frames; f++) {
    if (cancelled?.()) throw new Error('Export cancelled.');
    files[`frame_${String(f + 1).padStart(4, '0')}.png`] = await pngBytes(await render(f));
    onProgress?.(f + 1, frames);
  }
  return zipSync(files, { level: 0 }); // PNG is already compressed
}
