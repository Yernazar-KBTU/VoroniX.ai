/* Тема и настройки до отрисовки страницы, чтобы не было вспышки светлого фона. */
(() => {
  "use strict";
  const root = document.documentElement;
  const read = (key) => {
    try {
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  };
  const saved = () => {
    const value = read("vx-theme");
    return value === "light" || value === "dark" ? value : null;
  };
  const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  const system = () => (media && media.matches ? "light" : "dark");
  root.setAttribute("data-theme", saved() || system());
  if (read("vx-details") === "off") root.classList.add("details-off");
  if (media) {
    media.addEventListener("change", () => {
      if (!saved()) root.setAttribute("data-theme", system());
    });
  }
})();
