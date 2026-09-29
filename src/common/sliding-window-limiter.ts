// Limiteur à fenêtre glissante EN MÉMOIRE : compteurs par instance, remis à zéro
// au redémarrage. Suffisant tant que le backend tourne sur une seule instance
// (Render). Au-delà : stockage partagé (Redis/Postgres).
const SWEEP_THRESHOLD = 10_000;

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  // true = autorisé (et comptabilisé) ; false = limite atteinte (rien n'est compté).
  tryHit(key: string): boolean {
    const t = this.now();
    if (this.hits.size > SWEEP_THRESHOLD) this.sweep(t);
    const recent = (this.hits.get(key) ?? []).filter(
      (h) => t - h < this.windowMs,
    );
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  // Borne la mémoire : retire les clés dont tous les passages sont périmés.
  private sweep(t: number): void {
    for (const [key, list] of this.hits) {
      if (list.every((h) => t - h >= this.windowMs)) this.hits.delete(key);
    }
  }
}
