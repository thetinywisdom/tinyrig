// Scratch takes from the microphone. Runs locally; nothing is sent anywhere.
export interface Take { bytes: Uint8Array; ext: string; seconds: number }

export class Recorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private t0 = 0;

  get active() { return !!this.rec; }
  get seconds() { return this.rec ? (performance.now() - this.t0) / 1000 : 0; }

  /** Ask for the microphone and start recording. Throws with a plain message if the browser says no. */
  async start() {
    if (this.rec) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record sound here.');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } });
    } catch {
      throw new Error('The microphone is not available. Allow it for this page, or check that one is connected.');
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    this.rec = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start();
    this.t0 = performance.now();
  }

  /** Stop and hand back the take. */
  async stop(): Promise<Take | null> {
    const rec = this.rec;
    if (!rec) return null;
    const seconds = this.seconds;
    await new Promise<void>((done) => { rec.onstop = () => done(); rec.stop(); });
    this.stream?.getTracks().forEach((t) => t.stop());
    this.rec = null;
    this.stream = null;
    const blob = new Blob(this.chunks, { type: rec.mimeType });
    const ext = /ogg/.test(rec.mimeType) ? 'ogg' : /mp4/.test(rec.mimeType) ? 'm4a' : 'webm';
    return { bytes: new Uint8Array(await blob.arrayBuffer()), ext, seconds };
  }
}

/** How long a sound file plays, in seconds, or null if the browser cannot read it. */
export async function soundSeconds(bytes: Uint8Array): Promise<number | null> {
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    return (await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer)).duration;
  } catch { return null; }
}
