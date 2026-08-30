// Attention: which gallery tiles deserve the GPU right now.
//
// A wall of a hundred-plus live shaders bogged visitors' machines — the July
// painter throttled the work, but it still animated everything on screen.
// Now tiles are posters by default, and only a small ATTENTION SET runs
// live: the few nearest the viewport centre, plus whatever the pointer is
// over. Scroll on and a tile falls back to a held still, then to its poster.
// The cap is deterministic, not reactive — a 2015 laptop and an M4 get the
// same ceiling.

export type Attention = "cold" | "warm" | "live";

const FINE_POINTER = typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
const liveBudget = () => (FINE_POINTER && window.innerWidth >= 720 ? 3 : 1);
const RECOMPUTE_MIN_MS = 100;

class AttentionManager {
  private subs = new Map<Element, (a: Attention) => void>();
  private last = new Map<Element, Attention>();
  private near = new Set<Element>(); // within the viewport + margin (IO-tracked)
  private hovered: Element | null = null;
  private io: IntersectionObserver | null = null;
  private raf = 0;
  private lastRun = 0;
  private listening = false;

  register(el: Element, cb: (a: Attention) => void): () => void {
    this.subs.set(el, cb);
    this.observer().observe(el);
    this.listen();
    this.schedule();
    return () => {
      this.subs.delete(el);
      this.last.delete(el);
      this.near.delete(el);
      this.io?.unobserve(el);
      if (this.hovered === el) this.hovered = null;
    };
  }

  setHover(el: Element | null) {
    if (!FINE_POINTER) return;
    this.hovered = el;
    this.schedule();
  }

  private observer(): IntersectionObserver {
    if (!this.io) {
      this.io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) this.near.add(e.target);
          else this.near.delete(e.target);
        }
        this.schedule();
      }, { rootMargin: "25% 0px" });
    }
    return this.io;
  }

  private listen() {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("scroll", () => this.schedule(), { passive: true });
    window.addEventListener("resize", () => this.schedule(), { passive: true });
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const now = performance.now();
      if (now - this.lastRun < RECOMPUTE_MIN_MS) { this.schedule(); return; }
      this.lastRun = now;
      this.compute();
    });
  }

  private compute() {
    const vh = window.innerHeight;
    const mid = vh / 2;
    const onScreen: { el: Element; d: number }[] = [];
    for (const el of this.near) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.bottom <= 0 || r.top >= vh) continue;
      onScreen.push({ el, d: Math.abs((r.top + r.bottom) / 2 - mid) });
    }
    onScreen.sort((a, b) => a.d - b.d);
    const live = new Set<Element>(onScreen.slice(0, liveBudget()).map((x) => x.el));
    if (this.hovered && this.subs.has(this.hovered)) live.add(this.hovered);

    for (const [el, cb] of this.subs) {
      const next: Attention = live.has(el) ? "live" : this.near.has(el) ? "warm" : "cold";
      if (this.last.get(el) !== next) {
        this.last.set(el, next);
        cb(next);
      }
    }
  }
}

export const attention = new AttentionManager();
