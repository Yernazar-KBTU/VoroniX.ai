/* VoroniX.ai landing: hero motion driven by scroll. Phase 1 the slit rests, phase 2 it opens into a glowing screen, phase 3 the camera pushes into the product. */
(() => {
  "use strict";
  const stage = document.getElementById("motion");
  if (!stage) return;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const ease = (t) => t * t * (3 - 2 * t);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    stage.style.setProperty("--open", "1");
    return;
  }
  let queued = false;
  function update() {
    queued = false;
    const box = stage.getBoundingClientRect();
    const p = clamp(-box.top / Math.max(1, box.height - window.innerHeight));
    stage.style.setProperty("--open", ease(clamp((p - 0.12) / 0.38)).toFixed(4));
    stage.style.setProperty("--zoom", ease(clamp((p - 0.58) / 0.42)).toFixed(4));
  }
  const ask = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  window.addEventListener("scroll", ask, { passive: true });
  window.addEventListener("resize", ask);
  update();
})();
