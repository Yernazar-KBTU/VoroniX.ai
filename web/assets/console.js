/* VoroniX.ai: консоль сотрудника. Обновляется каждые 3 секунды. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const numbers = new Intl.NumberFormat("ru-RU");
  const OUTCOME = { answered: "ответ", truncated: "обрезан", refused: "отказ", cancelled: "остановлен", failed: "ошибка" };
  const seconds = (ms) => (ms == null ? "нет" : (ms / 1000).toFixed(1).replace(".", ",") + " с");
  const clock = (iso) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  let promptText = "";
  let promptFingerprint = "";

  async function getJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error((data && data.error && data.error.message) || "Ошибка " + response.status);
    return data;
  }

  function uptime(total) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return hours > 0 ? hours + " ч " + minutes + " мин" : minutes + " мин";
  }

  function fact(list, label, value, mono) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const desc = document.createElement("dd");
    desc.textContent = value;
    if (mono) desc.className = "mono";
    row.append(term, desc);
    list.append(row);
  }

  function renderLayers(layers) {
    const target = $("layers");
    target.textContent = "";
    for (const layer of layers) {
      const on = layer.status === "active";
      const item = document.createElement("li");
      item.className = "layer c" + layer.step + (on ? " on" : "");
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = layer.step;
      const name = document.createElement("span");
      name.className = "lname";
      name.textContent = layer.name;
      const small = document.createElement("small");
      small.textContent = "закрывает: " + layer.fixes.toLowerCase();
      name.append(small);
      const status = document.createElement("span");
      status.className = "state";
      status.textContent = on ? "работает" : "шаг " + layer.step;
      item.append(num, name, status);
      target.append(item);
    }
    const active = layers.filter((layer) => layer.status === "active").length;
    $("layers-sub").textContent = "включено " + active + " из " + layers.length;
  }

  function renderPrompt(prompt) {
    promptText = prompt.text;
    const target = $("prompt");
    target.textContent = "";
    for (const line of prompt.text.split("\n")) {
      const span = document.createElement("span");
      span.textContent = line || " ";
      target.append(span);
    }
    $("prompt-sub").textContent = prompt.id + " " + prompt.version + " · отпечаток " + prompt.fingerprint + " · " + numbers.format(prompt.chars) + " символов";
  }

  function renderOverview(data) {
    const stats = data.stats;
    const by = stats.byOutcome;
    $("c-total").textContent = numbers.format(stats.total);
    $("c-outcomes").textContent = stats.total
      ? "ответов " + by.answered + " · отказов " + by.refused + " · остановлено " + by.cancelled + " · ошибок " + by.failed
      : "пока нет";
    $("c-first").textContent = seconds(stats.medianFirstTextMs);
    $("c-full").textContent = seconds(stats.medianTotalMs);
    $("c-tokens").textContent = numbers.format(stats.inputTokens + stats.outputTokens);
    $("c-tokens-s").textContent = "вход " + numbers.format(stats.inputTokens) + " · выход " + numbers.format(stats.outputTokens);

    const facts = $("model-facts");
    facts.textContent = "";
    fact(facts, "Модель", data.assistant.model, true);
    fact(facts, "Усилие", data.assistant.effort, true);
    fact(facts, "Лимит ответа", numbers.format(data.assistant.maxTokens) + " токенов");
    fact(facts, "Запасная модель при отказе", data.assistant.refusalFallback ? "включена" : "выключена");
    fact(facts, "Ключ API", data.server.ready ? "задан" : "не задан");
    fact(facts, "Активных сессий", numbers.format(data.server.sessions));
    fact(facts, "Ответов генерируется сейчас", numbers.format(data.server.activeTurns));
    fact(facts, "Лимит сообщений", data.server.limits.rateLimit.messages + " за " + data.server.limits.rateLimit.windowMinutes + " мин с адреса");
    fact(facts, "Сервер работает", uptime(data.server.uptimeSec));

    renderLayers(data.layers);
    if (promptFingerprint !== data.prompt.fingerprint) {
      promptFingerprint = data.prompt.fingerprint;
      renderPrompt(data.prompt);
    }
  }

  function cell(row, text, cls) {
    const td = document.createElement("td");
    if (cls) td.className = cls;
    td.textContent = text;
    row.append(td);
    return td;
  }

  function renderTurns(turns) {
    const body = $("turns");
    body.textContent = "";
    $("turns-empty").hidden = turns.length > 0;
    for (const turn of turns) {
      const row = document.createElement("tr");
      cell(row, clock(turn.at), "mono");
      cell(row, turn.session, "mono");
      const outcome = cell(row, "");
      const badge = document.createElement("span");
      badge.className = "badge " + turn.outcome;
      badge.textContent = OUTCOME[turn.outcome] || turn.outcome;
      outcome.append(badge);
      cell(row, (turn.servedBy || turn.model) + (turn.fallbackUsed ? " (запасная)" : ""), "mono");
      cell(row, seconds(turn.firstTextMs), "num");
      cell(row, seconds(turn.totalMs), "num");
      cell(row, turn.inputTokens == null ? "нет" : numbers.format(turn.inputTokens) + " → " + numbers.format(turn.outputTokens), "num");
      const last = cell(row, "", turn.error ? "err" : "");
      if (turn.error) {
        last.textContent = turn.error;
      } else if (turn.requestId) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = turn.requestId;
        button.title = "Скопировать ID запроса";
        button.addEventListener("click", () => copy(turn.requestId, button));
        last.append(button);
      } else {
        last.textContent = "нет";
      }
      body.append(row);
    }
  }

  function copy(value, button) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(value).then(
      () => {
        button.classList.add("copied");
        setTimeout(() => button.classList.remove("copied"), 1200);
      },
      () => {},
    );
  }

  async function refresh() {
    try {
      const [overview, turns] = await Promise.all([getJson("/console/api/overview"), getJson("/console/api/turns")]);
      renderOverview(overview);
      renderTurns(turns.turns);
      $("banner").hidden = true;
      $("updated").textContent = clock(new Date().toISOString());
    } catch (error) {
      $("banner").textContent = "Не удалось обновить данные: " + error.message;
      $("banner").hidden = false;
    }
  }

  $("copy-prompt").addEventListener("click", (event) => copy(promptText, event.currentTarget));
  $("toggle-theme").addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("vx-theme", next);
    } catch (_) {
      /* хранилище недоступно */
    }
  });

  refresh();
  setInterval(refresh, 3000);
})();
