import { describe, expect, it } from 'vitest';
import { newShot } from '../src/model/shot';
import {
  byFileName, formatRuntime, freeShotName, linkShots, movePanel, newPanel, newStoryboard, panelSeconds, setPanelSeconds, summary,
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
