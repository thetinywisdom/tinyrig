// The one renderer. Draws a whole scene with PixiJS: backgrounds, characters,
// text, and (for the editor) handles and frame guides. Export uses the same
// drawing, rendered into an off-screen image at the output size.
//
// Each outline group of a character (an arm, a leg, the torso) draws all its
// line images first and all its fill images on top, so joints never show a seam.
import { Application, CanvasSource, Container, Graphics, Matrix, RenderTexture, Sprite, Text, Texture } from 'pixi.js';
import { maskHit } from '../import/raster';
import { apply, boneMatrices, drawList, invert, mul, translate, scale as scaleMat, type DrawItem, type Mat } from '../model/pose';
import type { BoneId, JointId, ViewId } from '../model/skeleton';
import { skeletonOf } from '../model/rig';
import { cameraRect, safeArea, type Background, type Camera, type FormatDef, type Shot, type TextItem } from '../model/shot';
import type { ImportResult, PieceRaster, Pose, Pt, Rect, Rig } from '../model/types';

export type Marker =
  | { kind: 'pivot'; at: Pt; active: boolean; locked: boolean }
  | { kind: 'root'; at: Pt; active: boolean }
  | { kind: 'handle'; at: Pt; active: boolean }
  | { kind: 'tip'; at: Pt; active: boolean };

const COLORS = { accent: 0xe4572e, ink: 0x1f2430, paper: 0xffffff, muted: 0x8a93a6, frame: 0x1c64d8 };

interface PieceTextures { raster: PieceRaster; line: Texture; fill: Texture; whole?: Texture }
type CharTextures = Map<string, PieceTextures>; // key: view/piece

/** One character on the stage. Several can share the same character's images. */
export class ActorView {
  container = new Container();
  mats: Record<BoneId, Mat> = {};
  private items: { item: DrawItem; raster: PieceRaster; mat: Mat }[] = [];
  private sprites = new Map<string, Sprite>();
  private lastKey = '';

  constructor(private textures: CharTextures, private makeWhole: (t: PieceTextures) => Texture) {}

  draw(rig: Rig, pose: Pose, unlocked: Set<JointId>) {
    const key = JSON.stringify([pose, rig.level, rig.nodes, rig.views[pose.view]]);
    if (key === this.lastKey) return false;
    this.lastKey = key;
    const view = rig.views[pose.view];
    this.container.removeChildren();
    this.items = [];
    if (!view) return true;
    this.mats = boneMatrices(view, pose, unlocked, skeletonOf(rig));
    drawList(view, pose).forEach((item, i) => {
      const tex = this.textures.get(`${pose.view}/${item.piece}`);
      const info = view.pieces[item.piece];
      if (!tex || !info) return;
      const bone = item.xf ? mul(this.mats[item.bone], item.xf) : this.mats[item.bone];
      const m = mul(bone, mul(translate(info.bbox.x, info.bbox.y), scaleMat(1 / info.scale, 1 / info.scale)));
      const id = `${i}:${item.piece}:${item.pass}`;
      let sprite = this.sprites.get(id);
      if (!sprite) {
        sprite = new Sprite(item.pass === 'line' ? tex.line : item.pass === 'fill' ? tex.fill : (tex.whole ??= this.makeWhole(tex)));
        this.sprites.set(id, sprite);
      }
      sprite.setFromMatrix(new Matrix(m[0], m[1], m[2], m[3], m[4], m[5]));
      this.container.addChild(sprite);
      if (item.pass !== 'line') this.items.push({ item, raster: tex.raster, mat: bone });
    });
    return true;
  }

  /** Topmost piece under a world point. */
  hit(world: Pt): { piece: string; bone: BoneId } | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const { item, raster, mat } = this.items[i];
      if (maskHit(raster.mask, apply(invert(mat), world))) return { piece: item.piece, bone: item.bone };
    }
    return null;
  }

  /** Stage-space box around the character as posed. */
  bounds(): Rect | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { raster, mat } of this.items) {
      const b = raster.bbox;
      for (const c of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) {
        const p = apply(mat, { x: c[0], y: c[1] });
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
    }
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
}

export interface DrawActor { id: string; rig: Rig; pose: Pose; unlocked: Set<JointId>; extra: boolean }
export interface SceneFrame {
  shot: Shot;
  actors: DrawActor[];
  texts: TextItem[];
  /** Image layers showing at this frame. */
  layers: Background[];
  /** Back-to-front order of image layers and characters, by id (see stackOrder). Without it: images, characters, front images. */
  order?: string[];
  /** Translucent copies of one character in other poses. */
  ghosts?: { actor: DrawActor; poses: Pose[] };
}

export class StageView {
  app = new Application();
  /** Everything that is part of the picture. */
  private picture = new Container();
  private world = new Container();
  private paper = new Graphics();
  /** Images and characters in one back-to-front stack, so a layer can sit between two characters. */
  private stackLayer = new Container();
  private ghostLayer = new Container();
  private textLayer = new Container();
  /** Subtitles, laid out in output pixels of the current format. */
  private frameLayer = new Container();
  private overlay = new Graphics();

  private chars = new Map<string, CharTextures>();
  private actors = new Map<string, ActorView>();
  private ghosts: ActorView[] = [];
  private ghostChar = '';
  private bgSprites = new Map<string, Sprite>();
  private bgTextures = new Map<string, Texture>();
  private textObjects = new Map<string, Text>();
  private made: Texture[] = [];

  async init(host: HTMLElement) {
    await this.app.init({
      resizeTo: host, backgroundAlpha: 0, antialias: true, // the page shows through around the paper
      resolution: window.devicePixelRatio || 1, autoDensity: true,
    });
    host.appendChild(this.app.canvas);
    this.world.addChild(this.paper, this.stackLayer, this.textLayer);
    this.picture.addChild(this.world, this.frameLayer);
    this.app.stage.addChild(this.picture, this.overlay);
  }

  get canvas(): HTMLCanvasElement { return this.app.canvas; }
  get zoom(): number { return this.world.scale.x; }

  // --- resources -------------------------------------------------------------
  private tex(canvas: HTMLCanvasElement | ImageBitmap): Texture {
    const t = new Texture({ source: new CanvasSource({ resource: canvas as HTMLCanvasElement, autoGenerateMipmaps: true, scaleMode: 'linear' }) });
    this.made.push(t);
    return t;
  }

  /** Give the renderer a character's images. Call again when its art is re-imported. */
  setCharacter(name: string, imp: ImportResult) {
    const map: CharTextures = new Map();
    for (const [view, pieces] of Object.entries(imp.views) as [ViewId, PieceRaster[]][]) {
      for (const raster of pieces) map.set(`${view}/${raster.name}`, { raster, line: this.tex(raster.line), fill: this.tex(raster.fill) });
    }
    this.chars.set(name, map);
    for (const [id] of this.actors) if (id.startsWith(`${name}\n`)) this.actors.delete(id);
  }
  hasCharacter(name: string) { return this.chars.has(name); }

  /** Mouths, eyes and hair layers are drawn whole: fill with its own lines on top. */
  private whole = (t: PieceTextures): Texture => {
    const c = document.createElement('canvas');
    c.width = t.raster.fillRaw.width; c.height = t.raster.fillRaw.height;
    const g = c.getContext('2d')!;
    g.drawImage(t.raster.fillRaw, 0, 0);
    g.drawImage(t.raster.line, 0, 0);
    return this.tex(c);
  };

  async setBackground(file: string, bytes: Uint8Array) {
    if (this.bgTextures.has(file)) return;
    const type = /\.svg$/i.test(file) ? 'image/svg+xml' : /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg';
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type }));
    try {
      const img = new Image();
      await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error(`${file} is not an image the browser can show.`)); img.src = url; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || 1920; c.height = img.naturalHeight || 1080;
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      this.bgTextures.set(file, this.tex(c));
    } finally { URL.revokeObjectURL(url); }
  }
  backgroundSize(file: string): { w: number; h: number } | null {
    const t = this.bgTextures.get(file);
    return t ? { w: t.width, h: t.height } : null;
  }

  // --- drawing ---------------------------------------------------------------
  private actorView(a: DrawActor): ActorView | null {
    const textures = this.chars.get(a.rig.name);
    if (!textures) return null;
    const key = `${a.rig.name}\n${a.id}`;
    let view = this.actors.get(key);
    if (!view) { view = new ActorView(textures, this.whole); this.actors.set(key, view); }
    return view;
  }
  actor(a: { id: string; rig: Rig }): ActorView | null { return this.actors.get(`${a.rig.name}\n${a.id}`) ?? null; }

  draw(frame: SceneFrame, subtitleFormat: { format: FormatDef; camera: Camera } | null) {
    const { shot } = frame;
    // A scene has no edges (its stage is 0 × 0): no paper, the canvas shows through.
    this.paper.clear();
    if (shot.stage.w > 0) this.paper.rect(0, 0, shot.stage.w, shot.stage.h).fill({ color: shot.stage.color });

    // Images and characters, in stack order.
    this.stackLayer.removeChildren();
    const items = new Map<string, Container>();
    for (const bg of frame.layers) {
      const t = this.bgTextures.get(bg.file);
      if (!t) continue;
      let s = this.bgSprites.get(bg.id);
      if (!s) { s = new Sprite(t); this.bgSprites.set(bg.id, s); }
      s.texture = t;
      s.position.set(bg.x, bg.y);
      s.scale.set(bg.scale);
      s.alpha = bg.opacity ?? 1;
      items.set(bg.id, s);
    }

    // Characters. Extras hold one pose, so they are flattened to a cached image and only redrawn when it changes.
    for (const a of frame.actors) {
      const view = this.actorView(a);
      if (!view) continue;
      const changed = view.draw(a.rig, a.pose, a.unlocked);
      if (a.extra) { if (!view.container.isCachedAsTexture) view.container.cacheAsTexture(true); else if (changed) view.container.updateCacheTexture(); }
      else if (view.container.isCachedAsTexture) view.container.cacheAsTexture(false);
      items.set(a.id, view.container);
    }
    const order = frame.order ?? [
      ...frame.layers.filter((l) => !l.front).map((l) => l.id), ...frame.actors.map((a) => a.id), ...frame.layers.filter((l) => l.front).map((l) => l.id),
    ];
    for (const id of order) {
      const item = items.get(id);
      if (!item) continue;
      if (frame.ghosts && id === frame.ghosts.actor.id) this.stackLayer.addChild(this.ghostLayer); // onion skin just behind its character
      this.stackLayer.addChild(item);
    }

    this.ghostLayer.removeChildren();
    if (frame.ghosts) {
      const textures = this.chars.get(frame.ghosts.actor.rig.name);
      frame.ghosts.poses.forEach((pose, i) => {
        if (!textures) return;
        if (this.ghostChar !== frame.ghosts!.actor.rig.name) { this.ghosts = []; this.ghostChar = frame.ghosts!.actor.rig.name; }
        const g = (this.ghosts[i] ??= new ActorView(textures, this.whole));
        g.draw(frame.ghosts!.actor.rig, pose, frame.ghosts!.actor.unlocked);
        g.container.alpha = 0.28;
        this.ghostLayer.addChild(g.container);
      });
    }

    // Text placed on the stage, and subtitles placed in the frame.
    this.textLayer.removeChildren();
    this.frameLayer.removeChildren();
    for (const item of frame.texts) {
      if (!item.text.trim()) continue;
      let t = this.textObjects.get(item.id);
      if (!t) { t = new Text({ text: '' }); this.textObjects.set(item.id, t); }
      if (item.kind === 'text') {
        t.text = item.text;
        t.style = { fontFamily: shot.font, fontSize: item.size, fill: item.color, fontWeight: '700', align: 'center', stroke: { color: 0xffffff, width: item.size * 0.12, join: 'round' } };
        t.anchor.set(0.5);
        t.position.set(item.x, item.y);
        this.textLayer.addChild(t);
      } else if (subtitleFormat) {
        const { format } = subtitleFormat, safe = safeArea(format);
        const size = Math.round(Math.min(format.w, format.h) * 0.05);
        t.text = item.text;
        t.style = {
          fontFamily: shot.font, fontSize: size, fill: 0xffffff, fontWeight: '700', align: 'center', lineHeight: size * 1.3,
          stroke: { color: 0x101014, width: size * 0.22, join: 'round' },
          wordWrap: true, wordWrapWidth: format.w * (1 - safe.left - safe.right) * 0.94, breakWords: true,
        };
        t.anchor.set(0.5, 1);
        t.position.set(format.w * (safe.left + (1 - safe.left - safe.right) / 2), format.h * (1 - safe.bottom) - size * 0.3);
        this.frameLayer.addChild(t);
      }
    }
    for (const [id, t] of this.textObjects) if (!frame.texts.some((x) => x.id === id)) { t.destroy(); this.textObjects.delete(id); }

    if (subtitleFormat) this.placeFrameLayer(subtitleFormat.format, subtitleFormat.camera);
  }

  /** In the editor, the subtitle layer sits over the camera frame, scaled to match it. */
  private placeFrameLayer(format: FormatDef, camera: Camera) {
    const r = cameraRect(camera, format), k = (this.zoom * r.w) / format.w;
    this.frameLayer.scale.set(k);
    this.frameLayer.position.set(r.x * this.zoom + this.world.x, r.y * this.zoom + this.world.y);
  }

  /** Editor-only drawing: joint handles, the camera frame and its safe area, the stage edge. */
  /** No editor drawing at all: for playing back a finished picture. */
  clearOverlay() { this.overlay.clear(); }
  drawOverlay(markers: Marker[], guide: { format: FormatDef; camera: Camera; active: boolean } | null, stage: { w: number; h: number }, selection: Rect | null) {
    const g = this.overlay.clear();
    const a = this.worldToScreen({ x: 0, y: 0 }), b = this.worldToScreen({ x: stage.w, y: stage.h });
    g.rect(a.x, a.y, b.x - a.x, b.y - a.y).stroke({ width: 1, color: COLORS.muted });

    if (guide) {
      const r = cameraRect(guide.camera, guide.format);
      const p = this.worldToScreen({ x: r.x, y: r.y }), w = r.w * this.zoom, h = r.h * this.zoom;
      // Dim what the frame leaves out.
      const sw = this.app.screen.width, sh = this.app.screen.height;
      g.rect(0, 0, sw, Math.max(0, p.y)).rect(0, p.y + h, sw, Math.max(0, sh - p.y - h))
        .rect(0, p.y, Math.max(0, p.x), h).rect(p.x + w, p.y, Math.max(0, sw - p.x - w), h).fill({ color: 0x1f2430, alpha: 0.28 });
      g.rect(p.x, p.y, w, h).stroke({ width: guide.active ? 3 : 2, color: COLORS.frame });
      const s = safeArea(guide.format);
      g.rect(p.x + w * s.left, p.y + h * s.top, w * (1 - s.left - s.right), h * (1 - s.top - s.bottom)).stroke({ width: 1, color: COLORS.frame, alpha: 0.6 });
      if (guide.active) for (const c of [[p.x, p.y], [p.x + w, p.y], [p.x, p.y + h], [p.x + w, p.y + h]]) g.rect(c[0] - 6, c[1] - 6, 12, 12).fill({ color: COLORS.paper }).stroke({ width: 2, color: COLORS.frame });
    }
    if (selection) {
      const p = this.worldToScreen({ x: selection.x, y: selection.y });
      g.rect(p.x - 4, p.y - 4, selection.w * this.zoom + 8, selection.h * this.zoom + 8).stroke({ width: 1.5, color: COLORS.accent, alpha: 0.8 });
    }
    for (const m of markers) {
      const p = this.worldToScreen(m.at);
      const color = m.active ? COLORS.accent : COLORS.ink;
      if (m.kind === 'pivot') {
        g.circle(p.x, p.y, m.active ? 7 : 5).fill({ color: m.locked ? COLORS.muted : COLORS.paper }).stroke({ width: 2, color });
        g.moveTo(p.x - 3, p.y).lineTo(p.x + 3, p.y).moveTo(p.x, p.y - 3).lineTo(p.x, p.y + 3).stroke({ width: 1.5, color });
      } else if (m.kind === 'root') {
        g.rect(p.x - 6, p.y - 6, 12, 12).fill({ color: COLORS.paper }).stroke({ width: 2, color });
      } else if (m.kind === 'tip') {
        g.poly([p.x, p.y - 6, p.x + 6, p.y, p.x, p.y + 6, p.x - 6, p.y]).fill({ color: COLORS.paper }).stroke({ width: 2, color });
      } else {
        g.circle(p.x, p.y, 9).fill({ color: COLORS.paper, alpha: 0.35 }).stroke({ width: 2.5, color: COLORS.accent });
        if (m.active) g.circle(p.x, p.y, 4).fill({ color: COLORS.accent });
      }
    }
  }

  // --- hit tests ---------------------------------------------------------------
  /** Topmost character piece under a world point. Later actors are in front. */
  hitActor(order: { id: string; rig: Rig }[], world: Pt): { id: string; piece: string; bone: BoneId } | null {
    for (let i = order.length - 1; i >= 0; i--) {
      const hit = this.actor(order[i])?.hit(world);
      if (hit) return { id: order[i].id, ...hit };
    }
    return null;
  }
  hitBackground(layers: Background[], world: Pt): string | null {
    for (let i = layers.length - 1; i >= 0; i--) {
      const bg = layers[i], t = this.bgTextures.get(bg.file);
      if (t && world.x >= bg.x && world.y >= bg.y && world.x <= bg.x + t.width * bg.scale && world.y <= bg.y + t.height * bg.scale) return bg.id;
    }
    return null;
  }

  // --- view ------------------------------------------------------------------
  screenToWorld(p: Pt): Pt { return { x: (p.x - this.world.x) / this.zoom, y: (p.y - this.world.y) / this.zoom }; }
  worldToScreen(p: Pt): Pt { return { x: p.x * this.zoom + this.world.x, y: p.y * this.zoom + this.world.y }; }
  panBy(dx: number, dy: number) { this.world.x += dx; this.world.y += dy; }
  zoomAt(screen: Pt, factor: number) {
    const before = this.screenToWorld(screen);
    const z = Math.min(8, Math.max(0.03, this.zoom * factor));
    this.world.scale.set(z);
    this.world.x = screen.x - before.x * z;
    this.world.y = screen.y - before.y * z;
  }
  fit(r: Rect, margin = 0.86) {
    const sw = this.app.screen.width, sh = this.app.screen.height;
    const z = Math.min(sw / r.w, sh / r.h) * margin;
    this.world.scale.set(z);
    this.world.x = sw / 2 - (r.x + r.w / 2) * z;
    this.world.y = sh / 2 - (r.y + r.h / 2) * z;
  }

  // --- output ----------------------------------------------------------------
  /**
   * The current drawing as an image of exactly the format's size, framed by its camera.
   * Call draw() for the wanted frame first. `scale` below 1 gives a smaller preview.
   */
  renderFrame(format: FormatDef, camera: Camera, scale = 1): HTMLCanvasElement {
    const w = Math.round(format.w * scale), h = Math.round(format.h * scale);
    const keep = { x: this.world.x, y: this.world.y, z: this.zoom, fx: this.frameLayer.x, fy: this.frameLayer.y, fs: this.frameLayer.scale.x };
    const r = cameraRect(camera, format), k = w / r.w;
    this.world.scale.set(k);
    this.world.position.set(-r.x * k, -r.y * k);
    this.frameLayer.scale.set(scale);
    this.frameLayer.position.set(0, 0);
    const target = RenderTexture.create({ width: w, height: h, resolution: 1, antialias: true });
    this.app.renderer.render({ container: this.picture, target, clear: true, clearColor: 0xffffff });
    const out = this.app.renderer.extract.canvas({ target, frame: target.frame }) as HTMLCanvasElement;
    target.destroy(true);
    this.world.scale.set(keep.z);
    this.world.position.set(keep.x, keep.y);
    this.frameLayer.scale.set(keep.fs);
    this.frameLayer.position.set(keep.fx, keep.fy);
    return out;
  }

  /** A small PNG of one character as currently posed, for the pose library. */
  thumbnail(a: { id: string; rig: Rig }, size = 96): string {
    const out = document.createElement('canvas');
    out.width = out.height = size * 2;
    const view = this.actor(a);
    if (!view) return out.toDataURL('image/png');
    const cached = view.container.isCachedAsTexture;
    if (cached) view.container.cacheAsTexture(false);
    const source = this.app.renderer.extract.canvas({ target: view.container, resolution: 1, antialias: true }) as HTMLCanvasElement;
    if (cached) view.container.cacheAsTexture(true);
    const k = Math.min(out.width / source.width, out.height / source.height);
    out.getContext('2d')!.drawImage(source, (out.width - source.width * k) / 2, (out.height - source.height * k) / 2, source.width * k, source.height * k);
    return out.toDataURL('image/png');
  }

  destroy() {
    for (const t of this.made) t.destroy(true);
    this.app.destroy(true, { children: true });
  }
}
