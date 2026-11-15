import { describe, expect, it } from 'vitest';
import { newShot } from '../src/model/shot';
import {
  byFileName, clipStart, formatRuntime, freeShotName, linkShots, movePanel, moveShotSoundToScene, newPanel, newStoryboard, panelAt,
  panelSeconds, panelStarts, placeClip, sceneClips, sceneFrames, setPanelSeconds, shotClips, summary,
} from '../src/model/storyboard';

const ids = () => { let n = 0; return () => `p${++n}`; };

describe('storyboard', () => {
  it('formats runtime as minutes and seconds', () => {
    expect(formatRuntime(0)).toBe('0:00');
    expect(formatRuntime(7.4)).toBe('0:07');
    expect(formatRuntime(107.6)).toBe('1:48');
  });

  it('sums panel durations, with a shot overriding its panel', () => {
    const sb = newStoryboard();
    const shot = { ...newShot('A'), length: 48 };
    sb.panels.push(newPanel('1', { duration: 3.2 }), newPanel('2', { duration: 9, shot: 'A' }));
    expect(panelSeconds(sb.panels[1], [shot])).toBe(2);
    expect(summary(sb, [shot])).toBe('0:05 · 2 shots');
    expect(summary({ ...sb, panels: [sb.panels[0]] }, [])).toBe('0:03 · 1 shot');
  });

  it('setting a duration resizes the shot in whole frames', () => {
    const shot = newShot('A');
    const p = newPanel('1', { shot: 'A' });
    setPanelSeconds(p, 3.2, [shot]);
    expect(shot.length).toBe(77);
    setPanelSeconds(p, 0, [shot]);
    expect(p.duration).toBe(0.25);
    expect(shot.length).toBe(6);
  });

  it('moves panels', () => {
    const sb = newStoryboard();
    sb.panels = ['a', 'b', 'c', 'd'].map((id) => newPanel(id));
    movePanel(sb, 0, 2);
    expect(sb.panels.map((p) => p.id).join('')).toBe('bcad');
    movePanel(sb, 3, 0);
    expect(sb.panels.map((p) => p.id).join('')).toBe('dbca');
    movePanel(sb, 1, 99);
    expect(sb.panels.map((p) => p.id).join('')).toBe('dcab');
  });

  it('orders dropped files naturally', () => {
    expect(['p10.png', 'p2.png', 'P1.png'].sort(byFileName)).toEqual(['P1.png', 'p2.png', 'p10.png']);
  });

  it('gives every shot a panel and drops links to missing shots', () => {
    const sb = newStoryboard();
    sb.panels.push(newPanel('x', { shot: 'Gone' }), newPanel('y', { shot: 'Kept' }));
    linkShots(sb, [newShot('Kept'), { ...newShot('Loose'), length: 36 }], ids());
    expect(sb.panels.map((p) => p.shot)).toEqual([undefined, 'Kept', 'Loose']);
    expect(sb.panels[2].duration).toBe(1.5);
  });

  it('finds a free shot name', () => {
    expect(freeShotName('Shot 2', [newShot('Shot 1')])).toBe('Shot 2');
    expect(freeShotName('Shot 2', [newShot('Shot 2'), newShot('Shot 2 (2)')])).toBe('Shot 2 (3)');
  });
});

describe('scene sound', () => {
  const setup = () => {
    const shots = [{ ...newShot('A'), length: 48 }, { ...newShot('B'), length: 24 }];
    const sb = newStoryboard();
    sb.panels = [newPanel('p1', { shot: 'A' }), newPanel('p2', { shot: 'B' }), newPanel('p3', { duration: 2 })];
    return { sb, shots };
  };

  it('lays panels back to back', () => {
    const { sb, shots } = setup();
    expect([...panelStarts(sb, shots).values()]).toEqual([0, 48, 72]);
    expect(sceneFrames(sb, shots)).toBe(120);
    expect(panelAt(sb, shots, 50)?.panel.id).toBe('p2');
    expect(panelAt(sb, shots, 500)?.panel.id).toBe('p3');
  });

  it('a clip keeps its panel when panels move or resize', () => {
    const { sb, shots } = setup();
    const clip = { id: 'c', lane: 'voice' as const, file: 'line.wav', panel: 'p1', offset: 0, gain: 1 };
    sb.sound = [clip];
    placeClip(sb, shots, clip, 60);
    expect(clip).toMatchObject({ panel: 'p2', offset: 12 });
    shots[0].length = 24; // panel 1 gets shorter: the line still starts 12 frames into panel 2
    expect(clipStart(sb, shots, clip)).toBe(36);
    movePanel(sb, 1, 0);
    expect(clipStart(sb, shots, clip)).toBe(12);
  });

  it('a line that crosses a cut is heard in both shots', () => {
    const { sb, shots } = setup();
    sb.sound = [{ id: 'c', lane: 'music', file: 'm.wav', panel: 'p1', offset: 40, gain: 0.5 }];
    expect(shotClips(sb, shots, 'p1')[0].start).toBe(40);
    expect(shotClips(sb, shots, 'p2')[0].start).toBe(-8);
    expect(sceneClips(sb, shots)[0]).toMatchObject({ start: 40, kind: 'music' });
  });

  it('moves old per-shot sound onto the scene', () => {
    const { sb, shots } = setup();
    shots[1].actors.push({ id: 'x', character: 'Momo', role: 'actor', base: {} as never, keys: [], mouth: [] });
    shots[1].audio = [{ id: 'a1', kind: 'dialogue', file: 'hi.wav', start: -6, gain: 1, actor: 'x' }];
    moveShotSoundToScene(sb, shots, () => 'n');
    expect(shots[1].audio).toEqual([]);
    expect(sb.sound?.[0]).toMatchObject({ lane: 'voice', speaker: 'Momo', panel: 'p1', offset: 42 });
  });
});
