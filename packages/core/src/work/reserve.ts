/**
 * Budget reservations under concurrency (v20). A lane reserves its buy (SOL, one buy, maybe one new position, the coin)
 * synchronously, before it awaits anything, and releases it when the buy is done or refused. The guardrails count the
 * reservations made before it that are still in flight (GuardContext.inFlight), so two lanes can't both pass a cap that
 * only one fits under, and a coin an earlier lane is buying is refused. JavaScript runs one thing at a time, so the
 * reservation order is exact.
 */
export interface Reservation { id: number; mint: string; sol: number; newPosition: boolean }

export class Reservations {
  private next = 1;
  private live = new Map<number, Reservation>();

  /**
   * What the lanes that reserved BEFORE `self` still have in flight (all of them without `self`). Earlier buys that
   * finished are in today's spend already, later ones count this one: first come, first served, nothing counted twice.
   * Read it right before the check.
   */
  others(self?: number): { sol: number; buys: number; positions: number; mints: string[] } {
    let sol = 0, buys = 0, positions = 0;
    const mints: string[] = [];
    for (const r of this.live.values()) {
      if (self !== undefined && r.id >= self) continue;
      sol += r.sol; buys++; if (r.newPosition) positions++; mints.push(r.mint);
    }
    return { sol: Math.round(sol * 1e9) / 1e9, buys, positions, mints };
  }

  reserve(x: Omit<Reservation, "id">): number {
    const id = this.next++;
    this.live.set(id, { ...x, id });
    return id;
  }

  release(id: number | undefined): void { if (id !== undefined) this.live.delete(id); }
  get size() { return this.live.size; }
}
