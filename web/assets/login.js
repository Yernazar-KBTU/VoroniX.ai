/* VoroniX.ai: staff sign in. The robot is real CSS 3D: rounded boxes made of faces, lit per face, head follows the cursor. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const D = Math.PI / 180;
  const sceneEl = $("rb-scene");
  const say = $("rb-say");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- tiny 3D math: CSS rotation conventions, y points down ---------- */
  const rot = (v, axis, a) => {
    const c = Math.cos(a * D), s = Math.sin(a * D), x = v[0], y = v[1], z = v[2];
    if (axis === "x") return [x, y * c - z * s, y * s + z * c];
    if (axis === "y") return [x * c + z * s, y, -x * s + z * c];
    return [x * c - y * s, x * s + y * c, z];
  };
  const world = (v, ops) => {
    let r = v;
    for (let i = ops.length - 1; i >= 0; i--) r = rot(r, ops[i][0], ops[i][1]);
    return r;
  };
  const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const LIGHT = unit([-0.5, -0.8, 0.7]);
  const RIM = unit([0.75, -0.15, -0.6]);
  const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
  function shade(n, base) {
    const d = Math.max(0, dot(n, LIGHT)), r = Math.max(0, dot(n, RIM)), f = Math.pow(1 - Math.max(0, n[2]), 2);
    const k = 0.2 + 0.86 * d;
    const c = [0, 1, 2].map((i) => base[i] * k + [120, 90, 255][i] * (0.32 * r + 0.18 * f));
    const hi = c.map((v) => clamp255(v * 1.06)).join(","), lo = c.map((v) => clamp255(v * 0.9)).join(",");
    return "linear-gradient(155deg, rgb(" + hi + "), rgb(" + lo + "))";
  }

  const SCENE = [["x", -14], ["y", -24]];
  const GREY = [206, 201, 196], DARK = [52, 50, 58], MID = [168, 163, 158];

  function el(parent, cls) {
    const node = document.createElement("div");
    node.className = cls;
    parent.append(node);
    return node;
  }

  /* A face: a flat div centred on its part, placed by its own transform. Shaded faces keep their local normal. */
  function makeFace(host, list, w, h, tf, opts) {
    const node = el(host, "rb-face");
    const st = node.style;
    st.width = w + "px";
    st.height = h + "px";
    st.marginLeft = -w / 2 + "px";
    st.marginTop = -h / 2 + "px";
    st.borderRadius = opts.br || "0";
    st.transform = tf;
    if (opts.bg) st.background = opts.bg;
    if (opts.shadow) st.boxShadow = opts.shadow;
    if (opts.cls) node.classList.add(opts.cls);
    if (opts.normal) list.push({ node, normal: opts.normal, base: opts.base, ring: opts.ring || "" });
    return node;
  }

  /* Rounded box: front, optional back, four flat sides and N strips per rounded edge. */
  function roundedBox(host, list, w, h, d, r, n, base, back) {
    makeFace(host, list, w, h, "translateZ(" + d / 2 + "px)", { normal: [0, 0, 1], base, br: r + "px" });
    if (back) makeFace(host, list, w, h, "rotateY(180deg) translateZ(" + d / 2 + "px)", { normal: [0, 0, -1], base, br: r + "px" });
    makeFace(host, list, d, h - 2 * r, "translateX(" + w / 2 + "px) rotateY(90deg)", { normal: [1, 0, 0], base });
    makeFace(host, list, d, h - 2 * r, "translateX(" + -w / 2 + "px) rotateY(-90deg)", { normal: [-1, 0, 0], base });
    makeFace(host, list, w - 2 * r, d, "translateY(" + -h / 2 + "px) rotateX(90deg)", { normal: [0, -1, 0], base });
    makeFace(host, list, w - 2 * r, d, "translateY(" + h / 2 + "px) rotateX(-90deg)", { normal: [0, 1, 0], base });
    const half = 45 / n, chord = 2 * r * Math.sin(half * D) * 1.15, rr = r * Math.cos(half * D);
    for (let q = 0; q < 4; q++) {
      for (let k = 0; k < n; k++) {
        const p = q * 90 + (k + 0.5) * 90 / n, c = Math.cos(p * D), s = Math.sin(p * D);
        const px = Math.sign(c) * (w / 2 - r) + rr * c, py = Math.sign(s) * (h / 2 - r) + rr * s;
        makeFace(host, list, d, chord, "translate3d(" + px.toFixed(1) + "px," + py.toFixed(1) + "px,0) rotateZ(" + p.toFixed(1) + "deg) rotateY(90deg)", { normal: [c, s, 0], base });
      }
    }
  }

  function decal(host, w, h, x, y, z, br, bg, shadow, extra) {
    return makeFace(host, [], w, h, "translate3d(" + x + "px," + y + "px," + z + "px)" + (extra || ""), { br, bg, shadow });
  }

  const parts = [];
  function part(tf, ops, idle) {
    const node = el(sceneEl, "rb-part");
    node.style.transform = tf;
    const inner = el(node, "rb-inner" + (idle && !reduceMotion ? " rb-idle" : ""));
    const entry = { node, inner, ops, faces: [] };
    parts.push(entry);
    return entry;
  }

  /* ---------- build the robot once ---------- */
  const ped = part("translate3d(0px,278px,0px)", SCENE);
  roundedBox(ped.inner, ped.faces, 300, 150, 250, 4, 1, [22, 22, 30], false);
  decal(ped.inner, 230, 150, 0, -75.5, 0, "50%", "radial-gradient(closest-side, rgba(0,0,0,.6), rgba(0,0,0,0))", "", " rotateX(90deg)");
  decal(ped.inner, 300, 250, 0, -76, 0, "4px", "transparent", "inset 0 0 0 1px rgba(140,110,255,.45), inset 0 0 40px rgba(110,80,255,.18)", " rotateX(90deg)");
  for (const sx of [-1, 1]) {
    const foot = part("translate3d(" + sx * 40 + "px,190px,12px)", SCENE);
    roundedBox(foot.inner, foot.faces, 62, 26, 84, 10, 2, MID, false);
    const leg = part("translate3d(" + sx * 38 + "px,148px,0px)", SCENE);
    roundedBox(leg.inner, leg.faces, 48, 58, 56, 16, 2, GREY, false);
  }
  const torso = part("translate3d(0px,40px,0px)", SCENE);
  roundedBox(torso.inner, torso.faces, 170, 160, 140, 40, 3, GREY, false);
  decal(torso.inner, 96, 54, 0, -26, 71, "14px", "radial-gradient(120% 120% at 50% 0%, #1b1b26, #06060a)", "inset 0 4px 10px rgba(0,0,0,.9), 0 0 0 2px rgba(255,255,255,.35)");
  decal(torso.inner, 58, 5, 0, -18, 72, "3px", "linear-gradient(90deg, #5ef2ff, #7d5cff)", "0 0 10px rgba(94,242,255,.9)");
  decal(torso.inner, 10, 10, -26, -38, 72, "50%", "#ff7ab6", "0 0 8px #ff7ab6");
  decal(torso.inner, 16, 48, -34, 46, 70.5, "8px", "linear-gradient(180deg, #4a4750, #26242b)", "inset 0 2px 4px rgba(0,0,0,.6)");
  decal(torso.inner, 16, 48, 34, 46, 70.5, "8px", "linear-gradient(180deg, #4a4750, #26242b)", "inset 0 2px 4px rgba(0,0,0,.6)");
  for (const sx of [-1, 1]) {
    const shoulder = part("translate3d(" + sx * 98 + "px,-14px,0px)", SCENE);
    roundedBox(shoulder.inner, shoulder.faces, 42, 42, 44, 18, 2, DARK, false);
    const ua = [...SCENE, ["z", -sx * 8]];
    const upper = part("translate3d(" + sx * 116 + "px,26px,0px) rotateZ(" + -sx * 8 + "deg)", ua);
    roundedBox(upper.inner, upper.faces, 50, 84, 56, 22, 2, GREY, false);
    const fa = [...SCENE, ["z", -sx * 5]];
    const fore = part("translate3d(" + sx * 128 + "px,108px,6px) rotateZ(" + -sx * 5 + "deg)", fa);
    roundedBox(fore.inner, fore.faces, 48, 78, 54, 20, 2, GREY, false);
    const hand = part("translate3d(" + sx * 133 + "px,162px,10px)", SCENE);
    roundedBox(hand.inner, hand.faces, 40, 34, 44, 14, 2, MID, false);
  }
  const neck = part("translate3d(0px,-50px,0px)", SCENE);
  roundedBox(neck.inner, neck.faces, 64, 30, 64, 22, 2, DARK, false);

  const head = part("", SCENE, true);
  roundedBox(head.inner, head.faces, 210, 190, 190, 46, 3, GREY, true);
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const size = 64 - k * 6;
      makeFace(head.inner, head.faces, size, size, "translate3d(" + sx * (106 + k * 4) + "px,10px,-12px) rotateY(" + sx * 90 + "deg)", {
        normal: [sx, 0, 0], base: k === 2 ? MID : DARK, br: "50%",
        ring: k === 2 ? "radial-gradient(circle, #0c0c12 0 30%, #5ef2ff 33% 39%, rgba(0,0,0,0) 42%), " : "",
        shadow: k === 2 ? "0 0 14px rgba(94,242,255,.35)" : "",
      });
    }
  }
  /* The face is one plane with 2D children, so the rim, screen and eyes never fight over depth. */
  const rim = decal(head.inner, 172, 152, 0, 4, 96, "40px", "conic-gradient(from 215deg, #5ef2ff, #4d7bff, #7d5cff, #c056f0, #ff7ab6, #ffb26b, #5ef2ff)", "0 0 26px rgba(125,92,255,.55)");
  const flat = (parent, x, y, w, h, br, bg, shadow) => {
    const node = document.createElement("div");
    const st = node.style;
    st.position = "absolute";
    st.left = x + "px";
    st.top = y + "px";
    st.width = w + "px";
    st.height = h + "px";
    st.borderRadius = br;
    st.background = bg;
    if (shadow) st.boxShadow = shadow;
    parent.append(node);
    return node;
  };
  flat(rim, 11, 11, 150, 130, "32px", "linear-gradient(155deg, #c9c4bf, #8f8a86)", "inset 0 0 6px rgba(0,0,0,.35)");
  const screen = flat(rim, 21, 21, 130, 110, "24px", "radial-gradient(120% 120% at 40% 20%, #17171f, #030305 70%)", "inset 0 6px 16px rgba(0,0,0,.95)");
  const eyes = [-22, 22].map((x) => {
    const eye = flat(screen, 65 + x - 10, 55 + 4 - 12, 20, 24, "50%", "radial-gradient(circle at 45% 40%, #ffffff, #e9f6ff 60%, #bfe4ff)", "0 0 12px rgba(220,240,255,.95)");
    if (!reduceMotion) eye.classList.add("rb-blink");
    return { node: eye };
  });
  flat(screen, 8, 6, 104, 30, "16px 16px 30px 30px", "linear-gradient(180deg, rgba(255,255,255,.16), rgba(255,255,255,0))", "");

  /* ---------- pose and light ---------- */
  const pose = { cx: 0, cy: 0, peek: false };
  let frame = 0;

  function paint(entry) {
    for (const face of entry.faces) face.node.style.background = face.ring + shade(world(face.normal, entry.ops), face.base);
  }

  function update() {
    frame = 0;
    const peek = pose.peek, cx = peek ? 0 : pose.cx, cy = peek ? 0 : pose.cy;
    const hy = peek ? -42 : 24 + cx * 40, hx = peek ? 18 : 14 - cy * 18, hz = peek ? 6 : -cx * 4;
    head.ops = [...SCENE, ["y", hy], ["x", hx], ["z", hz]];
    head.node.style.transform = "translate3d(0px,-62px,0px) rotateY(" + hy.toFixed(2) + "deg) rotateX(" + hx.toFixed(2) + "deg) rotateZ(" + hz.toFixed(2) + "deg) translate3d(0px,-100px,0px)";
    paint(head);
    const ex = (cx * 9).toFixed(1), ey = (cy * 6).toFixed(1), lid = peek ? 0.12 : 1;
    for (const eye of eyes) eye.node.style.transform = "translate(" + ex + "px," + ey + "px) scaleY(" + lid + ")";
    say.hidden = !peek;
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };

  for (const entry of parts) paint(entry);
  update();

  const robot = $("robot");
  document.addEventListener("pointermove", (event) => {
    const box = robot.getBoundingClientRect();
    const x = event.clientX - (box.left + box.width * 0.5);
    const y = event.clientY - (box.top + box.height * 0.22);
    pose.cx = Math.max(-1, Math.min(1, x / 560));
    pose.cy = Math.max(-1, Math.min(1, y / 420));
    schedule();
  });
  document.addEventListener("pointerleave", () => { pose.cx = 0; pose.cy = 0; schedule(); });

  /* ---------- sign in ---------- */
  const form = $("login-form");
  const nameInput = $("login-name");
  const password = $("password");
  const error = $("login-error");
  const submit = $("submit");

  nameInput.addEventListener("focus", () => { pose.peek = false; pose.cx = 0.95; pose.cy = 0.1; schedule(); });
  password.addEventListener("focus", () => { pose.peek = true; schedule(); });
  password.addEventListener("blur", () => { pose.peek = false; schedule(); });

  const MESSAGES = {
    401: "Wrong login or password.",
    429: "Too many sign in attempts. Please wait a few minutes and try again.",
    503: "Staff sign in is not set up on this server yet.",
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    if (!nameInput.value.trim() || !password.value) {
      error.textContent = "Enter your login and password.";
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    submit.textContent = "Signing in...";
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: nameInput.value.trim(), password: password.value }),
      });
      if (response.ok) {
        window.location.href = "/console";
        return;
      }
      error.textContent = MESSAGES[response.status] || "Sign in failed. Please try again.";
    } catch (_) {
      error.textContent = "No connection to the server. Check your network and try again.";
    }
    error.hidden = false;
    submit.disabled = false;
    submit.textContent = "Sign in";
  });
})();
