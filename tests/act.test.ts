import { describe, expect, it } from 'vitest';
import { actedFrames, compileActed, momentAt, momentFrames, type Moment } from '../src/model/act';
import { evaluate } from '../src/model/shot';

const m = (id: string, hold: number, move: number, neck?: number): Moment => ({
  id, hold, move, poses: neck === undefined ? {} : { a: { view: 'front', flip: false, rootAngle: 0, angles: { neck } } },
});
const cast = [{ id: 'a', character: 'Momo', root: { x: 100, y: 200 }, scale: 1 }];

describe('a panel acted pose to pose', () => {
  it('holds, then moves to the next pose; the last pose holds to the end', () => {
    const ms = [m('1', 0.5, 0.5, 0), m('2', 1, 0.5, 40)];
    expect(momentFrames(ms)).toEqual([{ start: 0, holdEnd: 12 }, { start: 24, holdEnd: 48 }]);
    expect(actedFrames(ms)).toBe(48);
    expect(momentAt(ms, 20)).toBe(0);
    expect(momentAt(ms, 24)).toBe(1);
  });

  it('compiles to a shot that eases between poses and keeps the character in place', () => {
    const shot = compileActed('p', { cast, moments: [m('1', 0.5, 0.5, 0), m('2', 1, 0.5, 40)] });
    const a = shot.actors[0];
    expect(a.keys.map((k) => k.frame)).toEqual([0, 12, 24, 48]);
    expect(evaluate(shot, a, 6).angles.neck).toBe(0); // holding
    const mid = evaluate(shot, a, 18).angles.neck;
    expect(mid).toBeGreaterThan(5);
    expect(mid).toBeLessThan(35); // moving
    expect(evaluate(shot, a, 30).angles.neck).toBe(40);
    expect(evaluate(shot, a, 30).root).toEqual({ x: 100, y: 200 });
  });

  it('a character missing from a moment keeps its last pose', () => {
    const shot = compileActed('p', { cast, moments: [m('1', 0.5, 0.5, 20), m('2', 0.5, 0.5)] });
    expect(evaluate(shot, shot.actors[0], 30).angles.neck).toBe(20);
  });

  it('an empty panel is one frame long', () => {
    expect(actedFrames([])).toBe(1);
  });
});
