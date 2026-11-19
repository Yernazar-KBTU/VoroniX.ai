/* VoroniX.ai landing: a thin slit of light opens wider on scroll and the light pouring out of it grows until it covers the screen and the staff sign in appears behind it. */
(() => {
  "use strict";
  const hero = document.getElementById("hero");
  const win = document.getElementById("hx-win");
  if (!hero || !win) return;
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.addEventListener("pageshow", () => { window.scrollTo(0, 0); update(); });
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const ease = (t) => t * t * (3 - 2 * t);
  let queued = false;
  let leaving = false;
  function update() {
    queued = false;
    const box = hero.getBoundingClientRect();
    const p = clamp(-box.top / Math.max(1, box.height - window.innerHeight));
    const open = ease(clamp(p / 0.7));
    const glow = ease(clamp(p / 0.95));
    const root = document.documentElement.style;
    win.style.setProperty("--sy", (0.03 + open * 0.97).toFixed(4));
    hero.style.setProperty("--glow", glow.toFixed(3));
    root.setProperty("--open", open.toFixed(3));
    root.setProperty("--flash", ease(clamp((p - 0.72) / 0.25)).toFixed(3));
    hero.style.setProperty("--fade", (1 - clamp((p - 0.3) * 2.5)).toFixed(3));
    if (p > 0.97 && !leaving) {
      leaving = true;
      try { sessionStorage.setItem("vx-light", "1"); } catch (_) { /* storage blocked: sign in opens without the light */ }
      window.location.assign("/login");
    }
  }
  const ask = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  window.addEventListener("scroll", ask, { passive: true });
  window.addEventListener("resize", ask);
  update();
})();
