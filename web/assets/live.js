"use strict";
/* Шаг 7: вкладки «Слежка» (поток событий в реальном времени) и «Доступ» (шаг 4). Текст сообщений сюда не приходит. */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const time = (iso) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const money = (v) => "$" + (v || 0).toFixed(4);
  const COLORS = {
    guard: "#ff4fd8", attack: "#ff3b5c", cache: "#22d3ee", rag: "#facc15", router: "#a78bfa",
    llm: "#4ade80", tool: "#fb923c", auth: "#60a5fa", deny: "#ff3b5c", turn: "#e2e8f0", pii: "#ff4fd8",
  };
  const ROLE = { client: "клиент", operator: "оператор", manager: "менеджер", owner: "владелец" };

  /* ---------- вкладки ---------- */
  const tabs = document.querySelectorAll(".tab");
  let liveStarted = false;
  function show(name) {
    tabs.forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.classList.toggle("is-on", on);
      tab.setAttribute("aria-selected", String(on));
    });
    $("tab-overview").hidden = name !== "overview";
    $("tab-live").hidden = name !== "live";
    $("tab-access").hidden = name !== "access";
    document.body.classList.toggle("spy-mode", name === "live");
    if (name === "live" && !liveStarted) {
      liveStarted = true;
      connect();
      rain();
    }
    if (name === "live") requestAnimationFrame(drawAll);
    if (name === "access") loadAccess();
    try { history.replaceState(null, "", name === "overview" ? "/console" : "/console#" + name); } catch (_) { /* нет истории */ }
  }
  tabs.forEach((tab) => tab.addEventListener("click", () => show(tab.dataset.tab)));

  /* ---------- состояние ---------- */
  const turns = [];
  const attackTimes = [];
  const radarDots = [];
  let denied = 0;
  let spent = 0;
  let cachedCount = 0;
  let paidCount = 0;

  /* ---------- поток событий: строки печатаются по очереди ---------- */
  const queue = [];
  let typing = false;
  function line(tag, kind, text, at, onClick) {
    queue.push({ tag, kind, text, at, onClick });
    if (!typing) pump();
  }
  function pump() {
    const next = queue.shift();
    if (!next) { typing = false; return; }
    typing = true;
    const li = el("li", "t-" + next.kind + (next.kind === "attack" || next.kind === "deny" ? " alarm" : ""));
    li.append(el("span", "ts", time(next.at)), el("span", "tag", next.tag), el("span", "msg", ""));
    if (next.onClick) { li.classList.add("clickable"); li.addEventListener("click", next.onClick); }
    const term = $("term");
    term.append(li);
    while (term.children.length > 220) term.firstChild.remove();
    term.scrollTop = term.scrollHeight;
    const msg = li.lastChild;
    let i = 0;
    const step = Math.max(2, Math.ceil(next.text.length / 14));
    const tick = () => {
      i += step;
      msg.textContent = next.text.slice(0, i);
      if (i < next.text.length) setTimeout(tick, 12);
      else setTimeout(pump, queue.length > 12 ? 0 : 55);
    };
    tick();
  }

  function onTurn(ev) {
    const t = ev.data;
    turns.push(t);
    if (turns.length > 60) turns.shift();
    const select = () => waterfall(t);
    for (const span of t.trace || []) {
      const a = span.attrs || {};
      if (span.name === "guard") {
        if (a.blocked) line("ATTACK", "attack", "инъекция остановлена до модели · сигналы " + (a.signals || "?") + " · балл " + a.injection, ev.at, select);
        else line("GUARD", "guard", "проверка пройдена · инъекция " + a.injection + " · скрыто личных данных " + a.pii, ev.at, select);
      } else if (span.name === "cache") {
        line("CACHE", "cache", a.hit ? "ПОПАДАНИЕ · " + (a.match === "semantic" ? "похожий по смыслу вопрос " + Math.round((a.similarity || 0) * 100) + "%" : "тот же вопрос") + " · 0 токенов" : "промах · идём в модель", ev.at, select);
      } else if (span.name === "rag") {
        line("RAG", "rag", "найдено документов " + a.hits + " · лучший балл " + a.top + (a.ids ? " · " + a.ids : ""), ev.at, select);
      } else if (span.name === "router") {
        line("ROUTER", "router", "→ " + a.model + " (" + a.reason + ")", ev.at, select);
      } else if (span.name === "llm") {
        line("LLM", "llm", a.model + " · " + span.ms + " мс · вход " + (a.in ?? "?") + " · выход " + (a.out ?? "?") + (a.cacheRead ? " · из кэша промпта " + a.cacheRead : ""), ev.at, select);
      } else if (span.name.startsWith("tool:")) {
        line("TOOL", a.ok ? "tool" : "deny", span.name.slice(5) + (a.ok ? " · выполнено" : " · ОТКАЗ " + (a.error || "")), ev.at, select);
      }
    }
    if (t.guard && t.guard.blocked) {
      attackTimes.push(Date.parse(ev.at));
      radarDots.push({ a: Math.random() * Math.PI * 2, r: 0.35 + Math.random() * 0.55, born: performance.now() });
    }
    if (t.cached) cachedCount += 1;
    else if (typeof t.costUsd === "number" && t.costUsd > 0) { paidCount += 1; spent += t.costUsd; }
    line("TURN", "turn", t.outcome.toUpperCase() + " · " + (ROLE[t.role] || "клиент") + " · " + t.totalMs + " мс · " + (t.cached ? "$0 (кэш)" : money(t.costUsd)), ev.at, select);
    waterfall(t);
    kpis();
    drawAll();
  }

  function onAuth(ev) {
    const d = ev.data;
    const who = (d.login || "?") + (d.role ? " (" + (ROLE[d.role] || d.role) + ")" : "");
    if (d.action === "login") line("AUTH", "auth", "вход " + who + " · токен на " + Math.round(d.ttlSec / 60) + " мин · " + d.ip, ev.at);
    else if (d.action === "login_failed") line("AUTH", "deny", "НЕВЕРНЫЙ ПАРОЛЬ для «" + d.login + "» · " + d.ip, ev.at);
    else if (d.action === "logout") line("AUTH", "auth", "выход " + who + " · токен отозван", ev.at);
    else if (d.action === "export") line("AUTH", "auth", "выгрузка заявок CSV · " + who, ev.at);
  }

  function onDeny(ev) {
    denied += 1;
    const d = ev.data;
    line("DENY", "deny", "роль «" + (ROLE[d.role] || d.role) + "»" + (d.login ? " (" + d.login + ")" : "") + " → " + d.what + " · ДОСТУП ЗАПРЕЩЁН", ev.at);
    kpis();
  }

  function handle(ev) {
    if (ev.kind === "turn") onTurn(ev);
    else if (ev.kind === "auth") onAuth(ev);
    else if (ev.kind === "deny") onDeny(ev);
  }

  function kpis() {
    $("k-turns").textContent = String(turns.length);
    $("k-cost").textContent = money(spent);
    $("k-saved").textContent = money(paidCount === 0 ? 0 : (spent / paidCount) * cachedCount);
    $("k-attacks").textContent = String(attackTimes.length);
    $("k-denied").textContent = String(denied);
  }

  /* ---------- лента времени ответа ---------- */
  function waterfall(t) {
    const wf = $("wf");
    wf.textContent = "";
    const spans = t.trace || [];
    const total = Math.max(1, t.totalMs, ...spans.map((s) => s.startMs + s.ms));
    $("wf-sub").textContent = time(t.at) + " · " + t.totalMs + " мс · " + (t.cached ? "$0 (кэш)" : money(t.costUsd)) + " · вход " + (t.inputTokens ?? 0) + " / выход " + (t.outputTokens ?? 0) + " токенов";
    spans.forEach((span, index) => {
      const kind = span.name.startsWith("tool:") ? "tool" : span.name === "pii-check" ? "pii" : span.name === "guard" && span.attrs && span.attrs.blocked ? "attack" : span.name;
      const li = el("li", "wf-row t-" + kind);
      li.append(el("span", "wf-name", span.name));
      const track = el("span", "wf-track");
      const bar = el("span", "wf-bar");
      bar.style.left = (span.startMs / total) * 100 + "%";
      bar.style.backgroundColor = COLORS[kind] || "#94a3b8";
      bar.style.boxShadow = "0 0 12px " + (COLORS[kind] || "#94a3b8");
      track.append(bar);
      li.append(track, el("span", "wf-ms", span.ms + " мс"));
      wf.append(li);
      setTimeout(() => { bar.style.width = Math.max(0.6, (span.ms / total) * 100) + "%"; }, 60 + index * 140);
    });
  }

  /* ---------- графики ---------- */
  function canvas(id) {
    const c = $(id);
    const ratio = window.devicePixelRatio || 1;
    const w = c.clientWidth || 300;
    const h = Number(c.getAttribute("height"));
    if (c.width !== Math.round(w * ratio)) { c.width = Math.round(w * ratio); c.height = Math.round(h * ratio); }
    const ctx = c.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }
  function grid(ctx, w, h) {
    ctx.strokeStyle = "rgba(74,222,128,.08)";
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 20) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 20) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }
  function drawLatency() {
    const { ctx, w, h } = canvas("ch-latency");
    grid(ctx, w, h);
    const pts = turns.slice(-30);
    if (pts.length === 0) return;
    const max = Math.max(500, ...pts.map((t) => t.totalMs));
    const x = (i) => (pts.length === 1 ? w / 2 : 8 + (i / (pts.length - 1)) * (w - 16));
    const y = (v) => h - 10 - (v / max) * (h - 24);
    ctx.beginPath();
    pts.forEach((t, i) => (i ? ctx.lineTo(x(i), y(t.totalMs)) : ctx.moveTo(x(i), y(t.totalMs))));
    ctx.strokeStyle = "#4ade80";
    ctx.lineWidth = 2;
    ctx.shadowColor = "#4ade80";
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
    pts.forEach((t, i) => {
      ctx.fillStyle = t.cached ? COLORS.cache : t.guard && t.guard.blocked ? COLORS.attack : COLORS.llm;
      ctx.beginPath(); ctx.arc(x(i), y(t.totalMs), 3.5, 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = "#86efac";
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText("макс " + max + " мс", 6, 12);
    ctx.fillText("последний " + pts[pts.length - 1].totalMs + " мс", w - 120, 12);
  }
  function drawCache() {
    const { ctx, w, h } = canvas("ch-cache");
    const answered = turns.filter((t) => !(t.guard && t.guard.blocked));
    const share = answered.length === 0 ? 0 : answered.filter((t) => t.cached).length / answered.length;
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 10;
    ctx.lineWidth = 10;
    ctx.strokeStyle = "rgba(34,211,238,.15)";
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = COLORS.cache;
    ctx.shadowColor = COLORS.cache; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + share * Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#cffafe";
    ctx.font = "bold 22px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(Math.round(share * 100) + "%", cx, cy + 8);
    ctx.textAlign = "start";
  }
  function drawAttacks() {
    const { ctx, w, h } = canvas("ch-attacks");
    grid(ctx, w, h);
    const now = Date.now();
    const buckets = new Array(10).fill(0);
    for (const at of attackTimes) {
      const ago = Math.floor((now - at) / 60000);
      if (ago >= 0 && ago < 10) buckets[9 - ago] += 1;
    }
    const max = Math.max(3, ...buckets);
    const bw = w / 10;
    buckets.forEach((v, i) => {
      const bh = (v / max) * (h - 14);
      ctx.fillStyle = v ? COLORS.attack : "rgba(255,59,92,.15)";
      ctx.shadowColor = COLORS.attack; ctx.shadowBlur = v ? 12 : 0;
      ctx.fillRect(i * bw + 4, h - bh - 2, bw - 8, Math.max(2, bh));
    });
    ctx.shadowBlur = 0;
  }
  function drawRadar() {
    const { ctx, w, h } = canvas("ch-radar");
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 6;
    ctx.strokeStyle = "rgba(255,59,92,.35)";
    ctx.lineWidth = 1;
    for (const k of [1, 0.66, 0.33]) { ctx.beginPath(); ctx.arc(cx, cy, r * k, 0, Math.PI * 2); ctx.stroke(); }
    const sweep = (performance.now() / 1200) % (Math.PI * 2);
    const grad = ctx.createConicGradient ? ctx.createConicGradient(sweep - 0.8, cx, cy) : null;
    if (grad) {
      grad.addColorStop(0, "rgba(255,59,92,0)");
      grad.addColorStop(0.12, "rgba(255,59,92,.45)");
      grad.addColorStop(0.13, "rgba(255,59,92,0)");
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }
    const now = performance.now();
    for (const dot of radarDots) {
      const age = (now - dot.born) / 1000;
      const alpha = Math.max(0.25, 1 - age / 20);
      ctx.fillStyle = "rgba(255,59,92," + alpha + ")";
      ctx.shadowColor = COLORS.attack; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(cx + Math.cos(dot.a) * dot.r * r, cy + Math.sin(dot.a) * dot.r * r, 3 + Math.max(0, 3 - age), 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
  }
  function drawAll() {
    if ($("tab-live").hidden) return;
    drawLatency(); drawCache(); drawAttacks();
  }
  function radarLoop() {
    if (!$("tab-live").hidden) drawRadar();
    requestAnimationFrame(radarLoop);
  }
  window.addEventListener("resize", drawAll);

  /* ---------- «матрица» в шапке ---------- */
  function rain() {
    const c = $("spy-rain");
    const glyphs = "01アイウエオカキクケコサシスセソVORONIX<>/{}#$";
    let drops = [];
    function frame() {
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; drops = new Array(Math.ceil(w / 14)).fill(0).map(() => Math.random() * -40); }
      const ctx = c.getContext("2d");
      ctx.fillStyle = "rgba(2,6,4,.18)";
      ctx.fillRect(0, 0, w, h);
      ctx.font = "13px ui-monospace, monospace";
      drops.forEach((y, i) => {
        ctx.fillStyle = Math.random() > 0.97 ? "#d1fae5" : "rgba(74,222,128,.55)";
        ctx.fillText(glyphs[Math.floor(Math.random() * glyphs.length)], i * 14, y * 14);
        drops[i] = y * 14 > h && Math.random() > 0.96 ? 0 : y + 1;
      });
      if (!$("tab-live").hidden) setTimeout(() => requestAnimationFrame(frame), 55);
      else setTimeout(frame, 500);
    }
    frame();
  }

  /* ---------- подключение ---------- */
  function connect() {
    const source = new EventSource("/console/api/live");
    source.addEventListener("hello", (msg) => {
      const data = JSON.parse(msg.data);
      $("spy-link").textContent = "ONLINE";
      $("spy-link").className = "on";
      $("spy-watchers").textContent = String(data.watchers);
      line("SYS", "auth", "канал слежки открыт · событий в памяти " + data.events.length, new Date().toISOString());
      data.events.forEach(handle);
    });
    source.addEventListener("event", (msg) => handle(JSON.parse(msg.data)));
    source.onerror = () => { $("spy-link").textContent = "RECONNECTING"; $("spy-link").className = "off"; };
    setInterval(() => { $("spy-clock").textContent = new Date().toLocaleTimeString("ru-RU") + " UTC+5"; drawAttacks(); }, 1000);
    radarLoop();
  }

  /* ---------- вкладка «Доступ» ---------- */
  let ttlTimer = null;
  async function loadAccess() {
    const response = await fetch("/console/api/access", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    $("acc-me").textContent = data.me.login + " · " + (ROLE[data.me.role] || data.me.role);
    const table = $("acc-matrix");
    table.textContent = "";
    const head = el("tr");
    head.append(el("th", "", "Инструмент"));
    const roles = Object.keys(data.roles);
    roles.forEach((role) => head.append(el("th", role === data.me.role ? "me" : "", data.roles[role])));
    table.append(head);
    for (const row of data.matrix) {
      const tr = el("tr");
      tr.append(el("td", "mono", row.tool));
      roles.forEach((role) => tr.append(el("td", row.roles.includes(role) ? "yes" : "no", row.roles.includes(role) ? "✓" : "✕")));
      table.append(tr);
    }
    const csvRow = el("tr");
    csvRow.append(el("td", "mono", "leads.csv (консоль)"));
    roles.forEach((role) => { const ok = role === "manager" || role === "owner"; csvRow.append(el("td", ok ? "yes" : "no", ok ? "✓" : "✕")); });
    table.append(csvRow);
    const staff = $("acc-staff");
    staff.textContent = "";
    const sh = el("tr");
    sh.append(el("th", "", "Логин"), el("th", "", "Роль"));
    staff.append(sh);
    data.accounts.forEach((a) => { const tr = el("tr"); tr.append(el("td", "mono", a.login), el("td", "", ROLE[a.role] || a.role)); staff.append(tr); });
    clearInterval(ttlTimer);
    const exp = data.me.expiresAt ? Date.parse(data.me.expiresAt) : null;
    const tick = () => {
      if (exp === null) { $("acc-ttl-text").textContent = "Открыто с компьютера сервера, токен не нужен."; $("acc-ttl").style.width = "100%"; return; }
      const left = Math.max(0, exp - Date.now());
      $("acc-ttl").style.width = (left / (data.tokenTtlSec * 1000)) * 100 + "%";
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      $("acc-ttl-text").textContent = left > 0 ? "Токен истечёт через " + m + " мин " + s + " с. Подпись HMAC-SHA256, роль внутри токена." : "Токен истёк. Войдите снова.";
    };
    tick();
    ttlTimer = setInterval(tick, 1000);
  }
  $("acc-export").addEventListener("click", async (event) => {
    event.preventDefault();
    const response = await fetch("/console/api/leads.csv", { cache: "no-store" });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      $("acc-export-error").textContent = (data && data.error && data.error.message) || "Выгрузка запрещена.";
      $("acc-export-error").hidden = false;
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const a = el("a");
    a.href = url; a.download = "voronix-leads.csv"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("acc-logout").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    location.reload();
  });

  const start = location.hash.replace("#", "");
  if (start === "live" || start === "access") show(start);
})();
