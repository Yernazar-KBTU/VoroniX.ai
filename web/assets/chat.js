/* VoroniX.ai: client chat. No third-party libraries: the security policy allows only our own scripts. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const app = $("app");
  const log = $("log");
  const form = $("composer");
  const input = $("input");
  const sendButton = $("send");
  const counter = $("count");
  const banner = $("banner");
  const numbers = new Intl.NumberFormat("en-US");

  const NOTICES = {
    refused: "The assistant cannot answer this request. Try asking another way.",
    truncated: "The answer was too long and was cut off.",
    cancelled: "Stopped. This answer was not saved in the conversation.",
    blocked: "The guard stopped this message: it looks like an attempt to change the assistant's rules, so it never reached the model.",
  };
  const TOOL_LABELS = {
    list_demo_slots: "checked free slots",
    book_demo: "booked a demo",
    list_leads: "opened leads",
  };

  const state = { busy: false, ready: false, maxChars: 4000, controller: null };

  const seconds = (ms) => (ms / 1000).toFixed(1) + " s";
  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function remember(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {
      /* хранилище недоступно: настройка живёт до перезагрузки */
    }
  }

  /* ---------- форматирование ответа: экранируем всё, потом размечаем списки, жирный и ссылки ---------- */
  function inline(text) {
    return escapeHtml(text)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/https?:\/\/(?:(?!&quot;|&#39;|&lt;|&gt;)[^\s<])+/g, (url) => {
        const tail = (url.match(/[.,;:!?)\]»]+$/) || [""])[0];
        const href = tail ? url.slice(0, -tail.length) : url;
        return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + href + "</a>" + tail;
      });
  }

  function format(text) {
    const out = [];
    let paragraph = [];
    let list = null;
    const flushParagraph = () => {
      if (paragraph.length) out.push("<p>" + paragraph.map(inline).join("<br>") + "</p>");
      paragraph = [];
    };
    const flushList = () => {
      if (list) out.push("<" + list.tag + ">" + list.items.map((item) => "<li>" + inline(item) + "</li>").join("") + "</" + list.tag + ">");
      list = null;
    };
    for (const raw of text.replace(/\r/g, "").split("\n")) {
      const line = raw.trimEnd();
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = bullet ? null : line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        flushParagraph();
        const tag = bullet ? "ul" : "ol";
        if (!list || list.tag !== tag) {
          flushList();
          list = { tag, items: [] };
        }
        list.items.push((bullet || numbered)[1]);
      } else if (line.trim() === "") {
        flushParagraph();
        flushList();
      } else {
        flushList();
        paragraph.push(line);
      }
    }
    flushParagraph();
    flushList();
    return out.join("");
  }

  /* ---------- лента ---------- */
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 140;
  const scrollDown = (force) => {
    if (force || nearBottom()) log.scrollTop = log.scrollHeight;
  };

  function userMessage(text) {
    app.classList.add("has-chat");
    const article = document.createElement("article");
    article.className = "msg user";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    article.append(bubble);
    log.append(article);
    scrollDown(true);
    return article;
  }

  function botShell() {
    const article = document.createElement("article");
    article.className = "msg bot";
    article.innerHTML = '<span class="avatar" aria-hidden="true"><span class="orb-ball"><span class="orb-swirl"></span><span class="orb-shade"></span></span></span><div class="body"></div>';
    log.append(article);
    return { article, body: article.querySelector(".body") };
  }

  function renderBubble(bubble, text, withCaret) {
    bubble.innerHTML = format(text);
    if (!withCaret) return;
    const caret = document.createElement("span");
    caret.className = "caret";
    let host = bubble.lastElementChild || bubble;
    if (host.tagName === "UL" || host.tagName === "OL") host = host.lastElementChild || host;
    host.append(caret);
  }

  function addNotice(body, text) {
    const note = document.createElement("p");
    note.className = "notice";
    note.textContent = text;
    body.append(note);
  }

  function copyText(value, button) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(value).then(
      () => {
        button.classList.add("copied");
        setTimeout(() => button.classList.remove("copied"), 1200);
      },
      () => {},
    );
  }

  function addMeta(body, meta) {
    const row = document.createElement("div");
    row.className = "meta";
    const chip = (label, title, cls) => {
      const span = document.createElement("span");
      if (cls) span.className = cls;
      span.textContent = label;
      span.title = title;
      row.append(span);
    };
    if (meta.guard && meta.guard.blocked) chip("Guard: blocked", "Stopped before the model", "t-guard");
    else if (meta.guard && meta.guard.pii) chip("Guard: " + meta.guard.pii + " masked", "Personal data replaced with labels before the model", "t-guard");
    else if (meta.guard) chip("Guard: clean", "No injection signals", "t-guard");
    if (meta.cached) chip("Cache: hit" + (meta.cacheMatch && meta.cacheMatch.kind === "semantic" ? ", same meaning " + meta.cacheMatch.similarity.toFixed(2) : ""), "Answer reused from cache, the model was not called", "t-cache");
    for (const source of meta.sources || []) chip("Source: " + source.title, "Knowledge article " + source.id, "t-search");
    if (meta.route) chip("Router: " + (meta.route.tier === "fast" ? "fast model" : "smart model"), meta.route.reason, "t-router");
    if (meta.servedBy) chip("Model: " + meta.servedBy + (meta.totalMs != null ? ", " + seconds(meta.totalMs) : ""), "Model that wrote the answer and total time", "t-model");
    if (meta.fallbackUsed) chip("Fallback model", "The main model refused, the fallback continued", "t-flag");
    for (const tool of meta.tools || []) chip("Tools: " + (TOOL_LABELS[tool.name] || tool.name) + (tool.ok ? "" : " (failed)"), "CRM action via tool " + tool.name, "t-tools");
    if (meta.inputTokens != null && meta.outputTokens != null) {
      chip(numbers.format(meta.inputTokens) + " in, " + numbers.format(meta.outputTokens) + " out", "Input and output tokens");
    }
    if (meta.outcome === "truncated") chip("Cut off", "The answer hit the length limit", "t-flag");
    if (meta.requestId) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "id " + meta.requestId.slice(0, 12) + "…";
      button.title = "Anthropic request id " + meta.requestId + ". Click to copy";
      button.addEventListener("click", () => copyText(meta.requestId, button));
      row.append(button);
    }
    body.append(row);
  }

  function botMessage() {
    const { article, body } = botShell();
    article.classList.add("pending");
    const thinking = document.createElement("div");
    thinking.className = "thinking";
    thinking.innerHTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="t-label">Thinking</span><span class="elapsed">0.0 s</span>';
    body.append(thinking);
    scrollDown(true);
    const started = performance.now();
    const elapsed = thinking.querySelector(".elapsed");
    const label = thinking.querySelector(".t-label");
    const timer = setInterval(() => {
      elapsed.textContent = seconds(performance.now() - started);
    }, 100);
    let bubble = null;
    let text = "";
    let frame = 0;
    const stopThinking = () => {
      clearInterval(timer);
      thinking.remove();
      article.classList.remove("pending");
    };
    const settle = () => {
      stopThinking();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      article.classList.remove("streaming");
      if (bubble) renderBubble(bubble, text, false);
    };
    return {
      article,
      fallback() {
        label.textContent = "Fallback model is thinking";
      },
      delta(chunk) {
        if (!bubble) {
          stopThinking();
          bubble = document.createElement("div");
          bubble.className = "bubble";
          body.prepend(bubble);
          article.classList.add("streaming");
        }
        text += chunk;
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            renderBubble(bubble, text, true);
            scrollDown(false);
          });
        }
      },
      finish(meta, notice) {
        settle();
        if (notice) addNotice(body, notice);
        if (meta) addMeta(body, meta);
        scrollDown(false);
      },
      fail(message, retry) {
        settle();
        const card = document.createElement("div");
        card.className = "msg-error";
        const span = document.createElement("span");
        span.textContent = message;
        card.append(span);
        if (retry) {
          const button = document.createElement("button");
          button.type = "button";
          
          button.textContent = "Retry";
          button.addEventListener("click", retry);
          card.append(button);
        }
        body.append(card);
        scrollDown(true);
      },
    };
  }

  /* ---------- поток событий от сервера ---------- */
  async function readEvents(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\n\n");
        let name = "message";
        let data = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (data) onEvent(name, JSON.parse(data));
      }
    }
  }

  /* ---------- отправка вопроса ---------- */
  async function send(raw) {
    const text = raw.trim();
    if (!text || state.busy || !state.ready) return;
    if (text.length > state.maxChars) {
      showBanner("The message is longer than " + numbers.format(state.maxChars) + " characters. Please shorten it.");
      return;
    }
    const userArticle = userMessage(text);
    input.value = "";
    resize();
    updateCount();
    const view = botMessage();
    const controller = new AbortController();
    state.controller = controller;
    setBusy(true);
    const retry = () => {
      userArticle.remove();
      view.article.remove();
      send(text);
    };
    let settled = false;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
        signal: controller.signal,
      });
      const type = response.headers.get("content-type") || "";
      if (!response.ok || !type.includes("text/event-stream")) {
        const payload = await response.json().catch(() => null);
        const message = (payload && payload.error && payload.error.message) || "The server did not answer. Please try again.";
        settled = true;
        if (response.status === 400 || response.status === 413) {
          view.fail(message, null);
          input.value = text;
          resize();
          updateCount();
        } else {
          view.fail(message, retry);
        }
        return;
      }
      await readEvents(response, (name, data) => {
        if (name === "delta") view.delta(data.text);
        else if (name === "fallback") view.fallback();
        else if (name === "done") {
          settled = true;
          view.finish(data, NOTICES[data.outcome]);
        } else if (name === "error") {
          settled = true;
          view.fail(data.message, retry);
        }
      });
      if (!settled) view.fail("The connection dropped before the answer finished. Please try again.", retry);
    } catch (_) {
      if (settled) return;
      if (controller.signal.aborted) view.finish(null, NOTICES.cancelled);
      else view.fail("No connection to the server. Check your network and try again.", retry);
    } finally {
      state.controller = null;
      setBusy(false);
    }
  }

  function setBusy(on) {
    state.busy = on;
    app.classList.toggle("busy", on);
    const label = on ? "Stop the answer" : "Send";
    sendButton.setAttribute("aria-label", label);
    sendButton.title = label;
    updateSendState();
  }

  function updateSendState() {
    sendButton.disabled = !state.busy && (!state.ready || input.value.trim() === "");
  }

  function resize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  }

  function updateCount() {
    const length = input.value.length;
    counter.textContent = length > state.maxChars * 0.8 ? numbers.format(length) + " / " + numbers.format(state.maxChars) : "";
    counter.classList.toggle("warn", length > state.maxChars);
    updateSendState();
  }

  function showBanner(text) {
    banner.textContent = text;
    banner.hidden = false;
  }

  /* ---------- сведения о помощнике и история ---------- */
  function setStatus(kind) {
    $("status-dot").className = "dot " + kind;
  }

  async function loadInfo() {
    try {
      const info = await (await fetch("/api/info", { cache: "no-store" })).json();
      $("f-model").textContent = info.assistant.model;
      state.maxChars = info.limits.maxInputChars;
      input.maxLength = state.maxChars;
      state.ready = info.ready;
      if (info.ready) {
        setStatus("ok");
      } else {
        setStatus("bad");
        showBanner("The server runs without an Anthropic API key, so answers are not available yet. Add ANTHROPIC_API_KEY and restart the server.");
      }
    } catch (_) {
      setStatus("bad"); $("f-model").textContent = "offline";
    }
    updateSendState();
  }

  async function loadHistory() {
    try {
      const data = await (await fetch("/api/history", { cache: "no-store" })).json();
      for (const entry of data.messages) {
        if (entry.role === "user") {
          userMessage(entry.text);
          continue;
        }
        const { body } = botShell();
        const bubble = document.createElement("div");
        bubble.className = "bubble";
        renderBubble(bubble, entry.text, false);
        body.append(bubble);
        if (entry.meta) addMeta(body, entry.meta);
      }
      for (const message of log.querySelectorAll(".msg")) message.classList.add("restored");
      scrollDown(true);
    } catch (_) {
      /* историю не загрузили: начинаем с чистого листа */
    }
  }

  async function newChat() {
    if (state.controller) {
      state.controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const reset = () =>
      fetch("/api/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    try {
      const response = await reset();
      if (response.status === 409) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        await reset();
      }
    } catch (_) {
      /* сервер недоступен: всё равно очищаем окно */
    }
    for (const node of log.querySelectorAll(".msg")) node.remove();
    app.classList.remove("has-chat");
    if (state.ready) banner.hidden = true;
    input.focus();
  }

  /* ---------- оформление ---------- */
  function applyDetails(on) {
    root.classList.toggle("details-off", !on);
    $("toggle-details").setAttribute("aria-pressed", String(on));
  }

  /* ---------- события ---------- */
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!state.busy) send(input.value);
  });
  sendButton.addEventListener("click", (event) => {
    if (state.busy) {
      event.preventDefault();
      if (state.controller) state.controller.abort();
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!state.busy) send(input.value);
    }
  });
  input.addEventListener("input", () => {
    resize();
    updateCount();
  });
  for (const button of document.querySelectorAll(".sugg")) {
    button.addEventListener("click", () => send(button.dataset.q || button.textContent));
  }
  $("new-chat").addEventListener("click", newChat);
  $("new-chat-m").addEventListener("click", newChat);
  $("toggle-details").addEventListener("click", () => {
    const on = root.classList.contains("details-off");
    applyDetails(on);
    remember("vx-details", on ? "on" : "off");
  });
  $("export-chat").addEventListener("click", () => {
    const lines = [];
    for (const node of log.querySelectorAll(".msg")) {
      const who = node.classList.contains("user") ? "You" : "VoroniX Agent";
      const bubble = node.querySelector(".bubble");
      if (bubble) lines.push(who + ":\n" + bubble.innerText.trim() + "\n");
    }
    if (!lines.length) {
      showBanner("Nothing to export yet. Ask a question first.");
      return;
    }
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "voronix-chat.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });

  try {
    if (localStorage.getItem("vx-details") === "off") root.classList.add("details-off");
  } catch (_) {
    /* storage unavailable */
  }
  applyDetails(!root.classList.contains("details-off"));
  updateCount();
  loadInfo();
  loadHistory();
})();
