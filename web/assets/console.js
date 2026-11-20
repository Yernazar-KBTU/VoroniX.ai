/* VoroniX.ai: staff console. Every server event becomes one or more rows in the activity log, live over SSE. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const ROLE = { client: "client", operator: "operator", manager: "manager", owner: "owner" };
  const state = { rows: [], sev: "All", layer: "All", view: "all", query: "", turns: 0, cost: 0, cached: 0 };
  const money = (v) => (v ? "$" + v.toFixed(4) : "$0");
  const ms = (v) => (v == null ? "" : v >= 1000 ? (v / 1000).toFixed(2) + " s" : Math.round(v) + " ms");
  const clock = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  /* Turn outcomes as the server writes them (src/chat/turn-log.ts). "ok" and "error" are kept so older logs still read correctly. */
  const OUTCOME = {
    answered: ["Info", "Answer sent"],
    ok: ["Info", "Answer sent"],
    truncated: ["Warning", "Answer cut off"],
    refused: ["Warning", "Answer refused"],
    cancelled: ["Warning", "Answer stopped"],
    failed: ["Warning", "Answer failed"],
    error: ["Warning", "Answer failed"],
    blocked: ["Warning", "Answer blocked"],
  };

  function toast(text, bad) {
    const node = $("toast");
    node.textContent = text;
    node.className = "toast" + (bad ? " bad" : "");
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.hidden = true; }, 4200);
  }

  /* ---------- server events to log rows ---------- */
  function actorOf(data) {
    if (data.login) return { name: data.login + (data.role ? " · " + (ROLE[data.role] || data.role) : ""), cls: "s", initials: String(data.login).slice(0, 2).toUpperCase() };
    if (data.session) return { name: "Visitor " + String(data.session).slice(0, 4), cls: "v", initials: "VS" };
    return { name: "unknown" + (data.ip ? " · " + data.ip : ""), cls: "u", initials: "??" };
  }

  function rowsFor(event) {
    const d = event.data || {};
    const at = event.at;
    const actor = actorOf(d);
    const out = [];
    const row = (sev, name, layer, details, latency, cost) => out.push({ at, sev, name, layer, details, latency: latency == null ? null : latency, cost: cost || 0, actor, seq: event.seq });
    if (event.kind === "turn") {
      const g = d.guard || null;
      if (g && g.blocked) row("Critical", "Prompt injection blocked", "Guard", (g.signals || []).join(" + ") + " · score " + g.injection + " · 0 tokens", 0, 0);
      if (g && g.pii) row("Info", "Personal data masked", "Guard", g.pii + " item(s) replaced before the model", null, 0);
      if (d.cached) {
        const m = d.cacheMatch;
        row("Info", "Answer from cache", "Cache", m && m.kind === "semantic" ? "same meaning " + Number(m.similarity).toFixed(2) : "exact repeat", d.totalMs, 0);
      }
      for (const tool of d.tools || []) row(tool.ok ? "Info" : "Warning", tool.ok ? "Tool call: " + tool.name : "Tool failed: " + tool.name, "Tools", tool.ok ? "CRM action done" : "the tool returned an error", null, 0);
      if (d.fallbackUsed) row("Warning", "Model fallback used", "Model", "main model refused · " + (d.servedBy || "fallback") + " served", null, 0);
      if (!g || !g.blocked) {
        if (d.route && !d.cached) row("Info", d.route.tier === "fast" ? "Routed to fast model" : "Routed to smart model", "Router", d.route.model + " · " + d.route.reason, 0, 0);
        if ((d.sources || []).length) row("Info", "Knowledge retrieved", "Search", d.sources.map((s) => s.title).join(", "), null, 0);
        const [outSev, label] = !d.outcome ? OUTCOME.answered : OUTCOME[d.outcome] || ["Warning", "Answer: " + d.outcome];
        if (!d.cached) row(outSev, label, "Model", (d.servedBy || d.model || "model") + (d.inputTokens != null ? " · " + d.inputTokens + " in, " + d.outputTokens + " out" : ""), d.totalMs, d.costUsd);
      }
    } else if (event.kind === "auth") {
      const a = d.action;
      if (a === "login") row("Info", "Staff signed in", "Access", "signed pass issued" + (d.ttlSec ? " · expires in " + Math.round(d.ttlSec / 3600) + " h" : ""), null, 0);
      else if (a === "logout") row("Info", "Staff signed out", "Access", "pass revoked", null, 0);
      else if (a === "login_failed") row("Warning", "Failed sign in", "Access", "login \"" + (d.login || "") + "\"" + (d.ip ? " · " + d.ip : ""), null, 0);
      else if (a === "export") row("Warning", "Leads exported to CSV", "Access", "voronix-leads.csv" + (d.ip ? " · " + d.ip : ""), null, 0);
      else row("Info", "Access event: " + a, "Access", d.ip || "", null, 0);
    } else if (event.kind === "deny") {
      row("Critical", "Access denied: " + (d.what || "action"), "Access", "role " + (ROLE[d.role] || d.role) + " is not allowed" + (d.ip ? " · " + d.ip : ""), null, 0);
    }
    return out;
  }

  /* ---------- filters ---------- */
  const SEVS = ["All", "Critical", "Warning", "Info"];
  const LAYERS = ["All", "Guard", "Access", "Tools", "Cache", "Search", "Router", "Model"];
  const VIEWS = {
    all: () => true,
    answers: (r) => r.layer === "Model" || r.layer === "Cache",
    guard: (r) => r.layer === "Guard",
    access: (r) => r.layer === "Access",
  };

  function visible() {
    const q = state.query.toLowerCase();
    return state.rows.filter((r) =>
      VIEWS[state.view](r) &&
      (state.sev === "All" || r.sev === state.sev) &&
      (state.layer === "All" || r.layer === state.layer) &&
      (!q || (r.name + " " + r.actor.name + " " + r.details).toLowerCase().includes(q)));
  }

  function chips(target, list, current, onPick, counts) {
    target.textContent = "";
    for (const label of list) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fchip" + (label === current ? " on" : "") + (label === "Critical" ? " crit" : "");
      button.textContent = counts ? label + " · " + counts(label) : label;
      button.setAttribute("aria-pressed", String(label === current));
      button.addEventListener("click", () => onPick(label));
      target.append(button);
    }
  }

  function cell(tr, cls, text) {
    const td = document.createElement("td");
    if (cls) td.className = cls;
    if (text !== undefined) td.textContent = text;
    tr.append(td);
    return td;
  }

  let lastSeq = 0;
  function render() {
    const count = (sev) => (sev === "All" ? state.rows.length : state.rows.filter((r) => r.sev === sev).length);
    chips($("sev-chips"), SEVS, state.sev, (v) => { state.sev = v; render(); }, count);
    chips($("layer-chips"), LAYERS, state.layer, (v) => { state.layer = v; render(); });
    const list = visible();
    const body = $("rows");
    body.textContent = "";
    for (const r of list.slice(0, 400)) {
      const tr = document.createElement("tr");
      if (r.sev === "Critical") tr.className = "crit";
      if (r.seq > lastSeq) tr.classList.add("new");
      cell(tr, "t", clock(r.at));
      const sev = document.createElement("span");
      sev.className = "sev " + r.sev;
      sev.textContent = r.sev;
      cell(tr).append(sev);
      cell(tr, "ev", r.name);
      const actor = document.createElement("span");
      actor.className = "actor";
      const ava = document.createElement("span");
      ava.className = "ava " + r.actor.cls;
      ava.textContent = r.actor.initials;
      actor.append(ava, document.createTextNode(r.actor.name));
      cell(tr).append(actor);
      const layer = document.createElement("span");
      layer.className = "lyr " + r.layer;
      layer.textContent = r.layer;
      cell(tr).append(layer);
      const det = cell(tr, "det", r.details);
      det.title = r.details;
      cell(tr, "num", ms(r.latency));
      cell(tr, "num", r.cost ? money(r.cost) : "$0");
      body.append(tr);
    }
    lastSeq = state.rows.length ? state.rows[0].seq : 0;
    $("empty").hidden = list.length > 0;
    $("shown").textContent = "Showing " + list.length + " of " + state.rows.length + " events";
    $("k-events").textContent = state.rows.length;
    $("k-crit").textContent = count("Critical");
    $("k-warn").textContent = count("Warning");
    $("k-answers").textContent = state.turns;
    $("k-answers-note").textContent = state.turns ? Math.round((state.cached / state.turns) * 100) + "% from cache · " + money(state.cost) + " spent" : "no answers yet";
    $("n-answers").textContent = state.turns;
    $("n-guard").textContent = state.rows.filter((r) => r.layer === "Guard").length;
    $("n-access").textContent = state.rows.filter((r) => r.layer === "Access").length;
  }

  let pending = 0;
  function add(event) {
    if (event.kind === "turn") {
      state.turns += 1;
      state.cost += Number(event.data.costUsd) || 0;
      if (event.data.cached) state.cached += 1;
    }
    state.rows = rowsFor(event).reverse().concat(state.rows).slice(0, 2000);
    if (!pending) pending = requestAnimationFrame(() => { pending = 0; render(); });
  }

  /* ---------- live connection ---------- */
  function setLive(on, text) {
    $("live-state").classList.toggle("on", on);
    $("live-text").textContent = text;
  }

  function connect() {
    const source = new EventSource("/console/api/live");
    source.addEventListener("hello", (msg) => {
      const data = JSON.parse(msg.data);
      state.rows = [];
      state.turns = 0;
      state.cost = 0;
      state.cached = 0;
      for (const event of data.events) add(event);
      setLive(true, "live");
      render();
    });
    source.addEventListener("event", (msg) => add(JSON.parse(msg.data)));
    source.addEventListener("error", () => setLive(false, "reconnecting"));
    source.addEventListener("open", () => setLive(true, "live"));
  }

  async function start() {
    let response;
    try {
      response = await fetch("/console/api/access", { cache: "no-store" });
    } catch (_) {
      setLive(false, "offline");
      toast("No connection to the server.", true);
      return;
    }
    if (response.status === 403) {
      window.location.replace("/login");
      return;
    }
    const info = await response.json();
    $("me").textContent = info.me.login + " · " + (ROLE[info.me.role] || info.me.role);
    $("me-exp").textContent = info.me.expiresAt ? "Pass expires at " + clock(info.me.expiresAt) : "Local access";
    connect();
  }

  /* ---------- actions ---------- */
  for (const link of document.querySelectorAll("[data-view]")) {
    link.addEventListener("click", () => {
      state.view = link.dataset.view;
      for (const other of document.querySelectorAll("[data-view]")) other.classList.toggle("on", other === link);
      render();
    });
  }
  $("search").addEventListener("input", (event) => { state.query = event.target.value.trim(); render(); });
  $("export").addEventListener("click", async () => {
    const response = await fetch("/console/api/leads.csv").catch(() => null);
    if (!response) return toast("No connection to the server.", true);
    if (response.status === 403) return toast("Your role sees leads but cannot export them. Export is for managers and owners.", true);
    if (!response.ok) return toast("Export is not available on this server.", true);
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "voronix-leads.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast("Leads exported. The export is now in the log.");
  });
  $("logout").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    window.location.href = "/login";
  });

  render();
  start();
})();
