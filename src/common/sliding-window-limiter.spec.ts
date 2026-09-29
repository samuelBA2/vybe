import { SlidingWindowLimiter } from './sliding-window-limiter';

describe('SlidingWindowLimiter', () => {
  it('autorise `limit` passages puis refuse dans la fenêtre', () => {
    let t = 0;
    const limiter = new SlidingWindowLimiter(3, 1000, () => t);
    expect([1, 2, 3].map(() => limiter.tryHit('k'))).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.tryHit('k')).toBe(false);
    t = 999;
    expect(limiter.tryHit('k')).toBe(false);
  });

  it('ré-autorise quand les passages sortent de la fenêtre', () => {
    let t = 0;
    const limiter = new SlidingWindowLimiter(1, 1000, () => t);
    expect(limiter.tryHit('k')).toBe(true);
    t = 1000;
    expect(limiter.tryHit('k')).toBe(true);
  });

  it('un refus ne consomme pas de passage ; les clés sont indépendantes', () => {
    const t = 0;
    const limiter = new SlidingWindowLimiter(1, 1000, () => t);
    expect(limiter.tryHit('a')).toBe(true);
    expect(limiter.tryHit('a')).toBe(false);
    expect(limiter.tryHit('b')).toBe(true);
  });

  it("un refus n'enregistre aucun passage (le créneau ne se décale pas)", () => {
    let t = 0;
    const limiter = new SlidingWindowLimiter(1, 1000, () => t);
    expect(limiter.tryHit('k')).toBe(true); // passage enregistré à t=0
    t = 500;
    expect(limiter.tryHit('k')).toBe(false); // refusé : ne doit RIEN enregistrer
    t = 1000;
    // Le seul passage (t=0) est sorti de la fenêtre. Si le refus avait été
    // enregistré (t=500), il serait encore dans la fenêtre et bloquerait (→ false).
    expect(limiter.tryHit('k')).toBe(true);
  });
});
