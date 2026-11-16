import { describe, expect, it } from 'vitest';
import { flipFor, nearestView, readFacing } from '../src/capture/facing';
import type { Landmark } from '../src/capture/mapping';

/** A person in a picture: torso 200 px tall, shoulders `width` px apart, nose offset `nose` px, face seen or not. */
function person(o: { width: number; nose?: number; face?: boolean; leftOnRight?: boolean; zL?: number; zR?: number }): Landmark[] {
  const pts: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  const cx = 300, half = o.width / 2, lr = o.leftOnRight === false ? -1 : 1, seen = o.face === false ? 0.1 : 0.99;
  pts[0] = { x: cx + (o.nose ?? 0), y: 100, visibility: seen };
  pts[2] = { x: cx + 15, y: 90, visibility: seen }; pts[5] = { x: cx - 15, y: 90, visibility: seen };
  pts[11] = { x: cx + lr * half, y: 160, visibility: 0.99, z: o.zL }; pts[12] = { x: cx - lr * half, y: 160, visibility: 0.99, z: o.zR };
  pts[23] = { x: cx + lr * half * 0.7, y: 360, visibility: 0.99 }; pts[24] = { x: cx - lr * half * 0.7, y: 360, visibility: 0.99 };
  return pts;
}

describe('reading the angle from a photo', () => {
  it('front: wide shoulders, face seen', () => {
    expect(readFacing(person({ width: 170 }))).toMatchObject({ view: 'front', looks: null });
  });
  it('back: wide shoulders, no face, left shoulder on the left', () => {
    expect(readFacing(person({ width: 170, face: false, leftOnRight: false }))?.view).toBe('back');
  });
  it('3/4: narrower shoulders, face seen, looking where the nose points', () => {
    expect(readFacing(person({ width: 90, nose: -30 }))).toMatchObject({ view: 'quarter', looks: 'left' });
    expect(readFacing(person({ width: 90, nose: 30 }))).toMatchObject({ view: 'quarter', looks: 'right' });
  });
  it('side: shoulders almost on top of each other', () => {
    expect(readFacing(person({ width: 20, nose: -50 }))).toMatchObject({ view: 'side', looks: 'left' });
  });
  it('side with the nose unclear: the nearer shoulder decides', () => {
    expect(readFacing(person({ width: 20, nose: 0, zL: -0.2, zR: 0.1 }))?.looks).toBe('left');
    expect(readFacing(person({ width: 20, nose: 0, zL: 0.1, zR: -0.2 }))?.looks).toBe('right');
  });
  it('mirror swaps the way they look', () => {
    expect(readFacing(person({ width: 90, nose: -30 }), { mirror: true })?.looks).toBe('right');
  });
  it('no shoulders, no answer', () => {
    expect(readFacing(Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 })))).toBeNull();
  });
  it('flips a drawing that looks the other way', () => {
    expect(flipFor({ view: 'side', looks: 'right', width: 0.1 }, 'left')).toBe(true);
    expect(flipFor({ view: 'side', looks: 'left', width: 0.1 }, 'left')).toBe(false);
    expect(flipFor({ view: 'front', looks: null, width: 0.8 }, 'left')).toBe(false);
  });
  it('falls back to the nearest angle the character has', () => {
    expect(nearestView('quarter', ['front', 'side'])).toBe('front');
    expect(nearestView('side', ['front', 'quarter'])).toBe('quarter');
    expect(nearestView('back', ['front'])).toBe('front');
  });
});
