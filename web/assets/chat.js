/* VoroniX.ai: чат клиента. Без сторонних библиотек: политика безопасности разрешает только свои скрипты. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const app = $("app");
  const log = $("log");
  const hero = $("hero");
  const form = $("composer");
  const input = $("input");
  const sendButton = $("send");
  const counter = $("count");
  const banner = $("banner");
  const numbers = new Intl.NumberFormat("ru-RU");

  const NOTICES = {
    refused: "Ассистент не может ответить на этот запрос. Попробуйте спросить иначе.",
    truncated: "Ответ получился слишком длинным и обрезан.",
    cancelled: "Остановлено. Этот ответ не сохранён в диалоге.",
  };

  const state = { busy: false, ready: false, maxChars: 4000, controller: null };

  const seconds = (ms) => (ms / 1000).toFixed(1).replace(".", ",") + " с";
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
    hero.hidden = true;
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
    article.innerHTML = '<span class="avatar"><img src="/assets/logo.svg" width="34" height="34" alt=""></span><div class="body"></div>';
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
    if (meta.servedBy) chip(meta.servedBy, "Модель, которая написала ответ", "m-model");
    if (meta.fallbackUsed) chip("запасная модель", "Основная модель отказалась, ответ продолжила запасная", "flag");
    if (meta.firstTextMs != null) chip("первое слово " + seconds(meta.firstTextMs), "От отправки вопроса до первого слова ответа");
    if (meta.totalMs != null) chip("ответ " + seconds(meta.totalMs), "Полное время ответа");
    if (meta.inputTokens != null && meta.outputTokens != null) {
      chip("токены " + numbers.format(meta.inputTokens) + " → " + numbers.format(meta.outputTokens), "Токены на входе и на выходе, включая размышления модели");
    }
    if (meta.outcome === "truncated") chip("обрезан", "Ответ упёрся в лимит длины", "flag");
    if (meta.requestId) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "id " + meta.requestId.slice(0, 12) + "…";
      button.title = "ID запроса у Anthropic: " + meta.requestId + ". Нажмите, чтобы скопировать";
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
    thinking.innerHTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="t-label">Думает</span><span class="elapsed">0,0 с</span>';
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
        label.textContent = "Думает запасная модель";
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
          button.className = "chip-btn";
          button.textContent = "Повторить";
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
      showBanner("Сообщение длиннее " + numbers.format(state.maxChars) + " символов. Сократите его, пожалуйста.");
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
        const message = (payload && payload.error && payload.error.message) || "Сервер не ответил. Попробуйте ещё раз.";
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
      if (!settled) view.fail("Соединение прервалось до конца ответа. Попробуйте ещё раз.", retry);
    } catch (_) {
      if (settled) return;
      if (controller.signal.aborted) view.finish(null, NOTICES.cancelled);
      else view.fail("Нет связи с сервером. Проверьте подключение и повторите.", retry);
    } finally {
      state.controller = null;
      setBusy(false);
    }
  }

  function setBusy(on) {
    state.busy = on;
    app.classList.toggle("busy", on);
    const label = on ? "Остановить ответ" : "Отправить";
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
  function renderLayers(target, layers) {
    target.textContent = "";
    for (const layer of layers) {
      const on = layer.status === "active";
      const item = document.createElement("li");
      item.className = "layer c" + layer.step + (on ? " on" : "");
      item.title = on ? "Слой работает в каждом ответе" : "Появится на шаге " + layer.step;
      item.innerHTML =
        '<span class="num">' + layer.step + '</span><span class="lname">' + escapeHtml(layer.name) +
        "<small>закрывает: " + escapeHtml(layer.fixes.toLowerCase()) + '</small></span><span class="state">' +
        (on ? "работает" : "шаг " + layer.step) + "</span>";
      target.append(item);
    }
  }

  function setStatus(kind, text) {
    $("status-dot").className = "status-dot " + kind;
    $("status-text").textContent = text;
    $("status-langs").hidden = kind !== "ok";
  }

  async function loadInfo() {
    try {
      const info = await (await fetch("/api/info", { cache: "no-store" })).json();
      renderLayers($("layers"), info.layers);
      $("f-model").textContent = info.assistant.model;
      $("f-effort").textContent = info.assistant.effort;
      $("f-prompt").textContent = info.prompt.version + " · " + info.prompt.fingerprint;
      state.maxChars = info.limits.maxInputChars;
      input.maxLength = state.maxChars;
      state.ready = info.ready;
      if (info.ready) {
        setStatus("ok", "на связи");
      } else {
        setStatus("bad", "не подключён к модели");
        showBanner("Сервер запущен без ключа API Anthropic, поэтому ответы пока недоступны. Добавьте ANTHROPIC_API_KEY в файл .env и перезапустите сервер.");
      }
    } catch (_) {
      setStatus("bad", "нет связи с сервером");
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
    hero.hidden = false;
    if (state.ready) banner.hidden = true;
    input.focus();
  }

  /* ---------- оформление ---------- */
  function applyDetails(on) {
    root.classList.toggle("details-off", !on);
    $("toggle-details").setAttribute("aria-pressed", String(on));
  }

  function openSide(open) {
    app.classList.toggle("side-open", open);
    $("scrim").hidden = !open;
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
    button.addEventListener("click", () => send(button.textContent));
  }
  $("new-chat").addEventListener("click", newChat);
  $("toggle-theme").addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    root.setAttribute("data-theme", next);
    remember("vx-theme", next);
  });
  $("toggle-details").addEventListener("click", () => {
    const on = root.classList.contains("details-off");
    applyDetails(on);
    remember("vx-details", on ? "on" : "off");
  });
  $("open-side").addEventListener("click", () => openSide(true));
  $("close-side").addEventListener("click", () => openSide(false));
  $("scrim").addEventListener("click", () => openSide(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") openSide(false);
  });

  applyDetails(!root.classList.contains("details-off"));
  updateCount();
  loadInfo();
  loadHistory();
})();
