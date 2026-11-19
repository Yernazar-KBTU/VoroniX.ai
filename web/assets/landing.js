/* VoroniX.ai landing: a softly glowing window in the middle. Scrolling pushes the camera into it, the light floods the screen and the staff sign in appears behind it. */
(() => {
  "use strict";
  const hero = document.getElementById("hero");
  const win = document.getElementById("hx-win");
  if (!hero || !win) return;
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.addEventListener("pageshow", () => { window.scrollTo(0, 0); update(); });
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const ease = (t) => t * t * (3 - 2 * t);
  let base = null;
  let queued = false;
  let leaving = false;
  function measure() {
    win.style.setProperty("--s", "1");
    win.style.setProperty("--dy", "0px");
    const box = win.getBoundingClientRect();
    base = { w: box.width, h: box.height, cy: box.top + box.height / 2 + window.scrollY - Math.max(0, window.scrollY) };
  }
  function update() {
    queued = false;
    if (!base) measure();
    const box = hero.getBoundingClientRect();
    const p = clamp(-box.top / Math.max(1, box.height - window.innerHeight));
    const t = ease(p);
    const cover = Math.max(window.innerWidth / base.w, window.innerHeight / base.h) * 1.04;
    win.style.setProperty("--s", (1 + t * (cover - 1)).toFixed(4));
    win.style.setProperty("--dy", (t * (window.innerHeight / 2 - base.cy)).toFixed(1) + "px");
    document.documentElement.style.setProperty("--flash", ease(clamp((p - 0.5) / 0.42)).toFixed(3));
    hero.style.setProperty("--fade", (1 - clamp(p * 4)).toFixed(3));
    if (p > 0.97 && !leaving) {
      leaving = true;
      try { sessionStorage.setItem("vx-light", "1"); } catch (_) { /* storage blocked: sign in opens without the light */ }
      window.location.assign("/login");
    }
  }
  const ask = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  window.addEventListener("scroll", ask, { passive: true });
  window.addEventListener("resize", () => { base = null; ask(); });
  update();
})();
