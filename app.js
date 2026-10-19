(() => {
  const DATA = window.SILVERASH_DATA;
  const STORAGE_KEY = "silverash-tower-board-v1";
  // The public page is static, so rooms use a tiny public key-value store.
  // The app key is not a secret; the room id is the access link users share.
  const SHARED_API_BASE = "https://keyvalue.immanuel.co/api/KeyVal";
  const SHARED_APP_KEY = "z1dychd6";
  const CLIENT_ID_KEY = "silverash-tower-client-id";
  const clientId = localStorage.getItem(CLIENT_ID_KEY) || (() => {
    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
    return id;
  })();
  const professions = ["先锋", "近卫", "重装", "狙击", "术师", "医疗", "辅助", "特种"];
  const colors = {
    先锋: "#50c9b5", 近卫: "#ef7b67", 重装: "#d8a546", 狙击: "#7ab8ee",
    术师: "#a98be8", 医疗: "#61d78d", 辅助: "#e1c85d", 特种: "#d889c9",
  };
  const abbreviations = { 先锋: "先", 近卫: "近", 重装: "重", 狙击: "狙", 术师: "术", 医疗: "医", 辅助: "辅", 特种: "特" };

  const operatorById = new Map(DATA.operators.map((operator) => [operator.id, operator]));
  const silverash = DATA.operators.find((operator) => operator.name === "银灰");
  const chapterById = new Map(DATA.chapters.map((chapter) => [chapter.id, chapter]));
  const stageById = new Map(DATA.chapters.flatMap((chapter) => chapter.stages.map((stage) => [stage.id, { ...stage, chapterId: chapter.id }])));

  const defaultState = () => ({
    assignments: {},
    cleared: {},
    notes: {},
    updatedAt: null,
    revision: 0,
  });

  let state = loadState();
  let history = [];
  let selectedChapter = "17";
  let selectedProfession = "全部";
  let availabilityFilter = "available";
  let stageFilter = "all";
  let selectedOperatorId = null;
  let dragged = null;
  let toastTimer = null;
  let roomId = new URLSearchParams(window.location.search).get("room");
  let syncTimer = null;
  let pollTimer = null;
  let syncInFlight = false;
  let lastPushedAt = null;

  const elements = {
    operatorList: document.querySelector("#operatorList"),
    operatorSearch: document.querySelector("#operatorSearch"),
    professionTabs: document.querySelector("#professionTabs"),
    availabilityFilter: document.querySelector("#availabilityFilter"),
    chapterStrip: document.querySelector("#chapterStrip"),
    chapterContent: document.querySelector("#chapterContent"),
    stageSearch: document.querySelector("#stageSearch"),
    stageFilter: document.querySelector("#stageFilter"),
    selectedBanner: document.querySelector("#selectedBanner"),
    selectedOperatorName: document.querySelector("#selectedOperatorName"),
    clearSelection: document.querySelector("#clearSelection"),
    poolCount: document.querySelector("#poolCount"),
    stageCount: document.querySelector("#stageCount"),
    availableStat: document.querySelector("#availableStat"),
    spentStat: document.querySelector("#spentStat"),
    plannedStat: document.querySelector("#plannedStat"),
    silverashStat: document.querySelector("#silverashStat"),
    professionLegend: document.querySelector("#professionLegend"),
    saveState: document.querySelector("#saveState"),
    undoButton: document.querySelector("#undoButton"),
    exportButton: document.querySelector("#exportButton"),
    importInput: document.querySelector("#importInput"),
    resetButton: document.querySelector("#resetButton"),
    toast: document.querySelector("#toast"),
    collabStatus: document.querySelector("#collabStatus"),
    createRoomButton: document.querySelector("#createRoomButton"),
    copyRoomButton: document.querySelector("#copyRoomButton"),
    roomInput: document.querySelector("#roomInput"),
    joinRoomButton: document.querySelector("#joinRoomButton"),
  };

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return saved && typeof saved === "object" ? { ...defaultState(), ...saved } : defaultState();
    } catch {
      return defaultState();
    }
  }

  function setCollabStatus(message, tone = "") {
    if (!elements.collabStatus) return;
    elements.collabStatus.textContent = message;
    elements.collabStatus.dataset.tone = tone;
  }

  function saveState({ sync = true } = {}) {
    state.updatedAt = new Date().toISOString();
    if (roomId && sync) state.revision = Number(state.revision || 0) + 1;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    elements.saveState.innerHTML = "<i></i> 已自动保存";
    if (roomId && sync) queueSharedSync();
  }

  function normalizeRoomId(value) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input);
      return url.searchParams.get("room") || url.pathname.split("/").filter(Boolean).pop() || "";
    } catch {
      return input.replace(/^.*room=/, "").split(/[?#&]/)[0];
    }
  }

  function roomUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomId);
    return url.toString();
  }

  function partitionObject(value) {
    const entries = Object.entries(value || {});
    const chunks = [];
    let current = {};
    for (const [key, item] of entries) {
      const candidate = { ...current, [key]: item };
      if (Object.keys(current).length && JSON.stringify(candidate).length > 860) {
        chunks.push(current);
        current = { [key]: item };
      } else {
        current = candidate;
      }
    }
    chunks.push(current);
    return chunks;
  }

  function roomKey(suffix) {
    return `${roomId}:${suffix}`;
  }

  function roomParts(nextState = state) {
    const parts = [];
    for (const [section, value] of Object.entries({
      assignments: nextState.assignments,
      cleared: nextState.cleared,
      notes: nextState.notes,
    })) {
      partitionObject(value).forEach((chunk, index) => {
        parts.push({ key: roomKey(`${section[0]}${index}`), section, chunk });
      });
    }
    return parts;
  }

  function extractXmlValue(text) {
    if (!text.trim().startsWith("<")) return text;
    try {
      return new DOMParser().parseFromString(text, "application/xml").documentElement.textContent || "";
    } catch {
      return text.replace(/^<string[^>]*>/i, "").replace(/<\/string>\s*$/i, "");
    }
  }

  async function writeRoomValue(key, value) {
    const response = await fetch(`${SHARED_API_BASE}/UpdateValue/${SHARED_APP_KEY}/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, {
      method: "POST",
      headers: { Accept: "text/plain" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  }

  async function readRoomValue(key) {
    const response = await fetch(`${SHARED_API_BASE}/GetValue/${SHARED_APP_KEY}/${encodeURIComponent(key)}`, { headers: { Accept: "text/plain" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = extractXmlValue(await response.text());
    if (!value || value === "null") throw new Error("missing room");
    return value;
  }

  function queueSharedSync() {
    clearTimeout(syncTimer);
    setCollabStatus("协作房间 · 等待同步", "pending");
    syncTimer = setTimeout(pushSharedState, 500);
  }

  async function pushSharedState() {
    if (!roomId || syncInFlight) return;
    syncInFlight = true;
    const pushedAt = state.updatedAt;
    lastPushedAt = pushedAt;
    try {
      const parts = roomParts(state);
      await Promise.all(parts.map((part) => writeRoomValue(part.key, JSON.stringify(part.chunk))));
      await writeRoomValue(roomKey("meta"), JSON.stringify({
        app: "silverash-tower-board",
        version: 1,
        revision: Number(state.revision || 0),
        updatedAt: state.updatedAt || new Date().toISOString(),
        parts: parts.map(({ key, section }) => ({ key, section })),
      }));
      setCollabStatus("协作房间 · 已同步", "ready");
    } catch {
      setCollabStatus("协作房间 · 同步失败，请检查网络", "error");
      showToast("协作同步失败，记录仍保存在本机");
    } finally {
      syncInFlight = false;
      if (state.updatedAt !== lastPushedAt) queueSharedSync();
    }
  }

  async function fetchSharedState(showLoading = false) {
    if (!roomId) return;
    if (showLoading) setCollabStatus("协作房间 · 正在读取", "pending");
    try {
      const meta = JSON.parse(await readRoomValue(roomKey("meta")));
      if (meta.app !== "silverash-tower-board" || !Array.isArray(meta.parts)) throw new Error("invalid room");
      const remoteState = defaultState();
      const values = await Promise.all(meta.parts.map(async ({ key, section }) => ({ section, chunk: JSON.parse(await readRoomValue(key)) })));
      for (const { section, chunk } of values) Object.assign(remoteState[section], chunk);
      remoteState.updatedAt = meta.updatedAt || null;
      remoteState.revision = meta.revision || 0;
      const remoteUpdatedAt = meta.updatedAt || remoteState.updatedAt || null;
      const localTime = state.updatedAt ? Date.parse(state.updatedAt) : 0;
      const remoteTime = remoteUpdatedAt ? Date.parse(remoteUpdatedAt) : 0;
      if (remoteTime > localTime || (meta.revision || 0) > (state.revision || 0)) {
        state = remoteState;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        history = [];
        renderAll();
        showToast("已同步协作者的最新记录");
      }
      setCollabStatus("协作房间 · 已连接", "ready");
    } catch {
      setCollabStatus("协作房间 · 房间不存在或暂时不可用", "error");
    }
  }

  function startRoom() {
    clearInterval(pollTimer);
    if (!roomId) {
      elements.copyRoomButton.disabled = true;
      setCollabStatus("本机记录 · 还没有共享");
      return;
    }
    elements.copyRoomButton.disabled = false;
    elements.roomInput.value = roomId;
    fetchSharedState(true);
    pollTimer = setInterval(() => fetchSharedState(false), 3000);
  }

  async function createRoom() {
    if (!state.updatedAt) saveState({ sync: false });
    setCollabStatus("正在创建协作房间…", "pending");
    try {
      roomId = `at-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      state.revision = Math.max(1, Number(state.revision || 0));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      window.history.replaceState({}, "", roomUrl());
      await pushSharedState();
      startRoom();
      showToast("协作房间已创建，复制链接发给队友即可");
    } catch {
      setCollabStatus("创建失败，请稍后重试", "error");
      showToast("暂时无法创建协作房间，请检查网络");
    }
  }

  function joinRoom() {
    const nextRoomId = normalizeRoomId(elements.roomInput.value);
    if (!nextRoomId) return showToast("请粘贴有效的房间链接或房间号");
    roomId = nextRoomId;
    window.history.replaceState({}, "", roomUrl());
    startRoom();
  }

  function snapshot() {
    history.push(JSON.stringify(state));
    if (history.length > 30) history.shift();
    elements.undoButton.disabled = false;
  }

  function commit(message) {
    saveState();
    renderAll();
    if (message) showToast(message);
  }

  function undo() {
    const previous = history.pop();
    if (!previous) return;
    state = JSON.parse(previous);
    saveState();
    renderAll();
    elements.undoButton.disabled = history.length === 0;
    showToast("已撤销上一步操作");
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2200);
  }

  function assignmentList(stageId) {
    return (state.assignments[stageId] || []).filter((item) => item.operatorId !== silverash?.id);
  }

  function operatorPlacement(operatorId) {
    for (const [stageId, assignments] of Object.entries(state.assignments)) {
      const placement = assignments.find((item) => item.operatorId === operatorId);
      if (placement) return { stageId, placementId: placement.placementId };
    }
    return null;
  }

  function isAvailable(operator) {
    return operator.repeatable || !operatorPlacement(operator.id);
  }

  function addOperatorToStage(operatorId, stageId, sourceStageId = null, placementId = null) {
    const operator = operatorById.get(operatorId);
    if (!operator || !stageById.has(stageId)) return;
    if (operator.name === "银灰") {
      showToast("银灰已经默认编入全部关卡");
      return;
    }
    if (assignmentList(stageId).some((item) => item.operatorId === operatorId)) {
      showToast(`${operator.name} 已在 ${stageId} 中`);
      return;
    }
    const existing = operatorPlacement(operatorId);
    if (!operator.repeatable && existing && existing.stageId !== sourceStageId) {
      showToast(`${operator.name} 已用于 ${existing.stageId}`);
      return;
    }

    snapshot();
    if (sourceStageId && state.assignments[sourceStageId]) {
      state.assignments[sourceStageId] = state.assignments[sourceStageId].filter((item) => item.placementId !== placementId);
      if (!state.assignments[sourceStageId].length) delete state.assignments[sourceStageId];
    }
    state.assignments[stageId] ||= [];
    state.assignments[stageId].push({
      operatorId,
      placementId: operator.repeatable && !placementId ? `${operatorId}-${Date.now()}-${Math.random().toString(16).slice(2)}` : (placementId || operatorId),
    });
    selectedOperatorId = null;
    commit(sourceStageId ? `${operator.name} 已移动到 ${stageId}` : `${operator.name} 已编入 ${stageId}`);
  }

  function removeOperator(stageId, placementId) {
    const item = assignmentList(stageId).find((assignment) => assignment.placementId === placementId);
    if (!item) return;
    snapshot();
    state.assignments[stageId] = assignmentList(stageId).filter((assignment) => assignment.placementId !== placementId);
    if (!state.assignments[stageId].length) delete state.assignments[stageId];
    commit(`${operatorById.get(item.operatorId)?.name || "干员"} 已从 ${stageId} 撤回`);
  }

  function roleStyle(profession) {
    return `--role:${colors[profession] || "#77869a"}`;
  }

  function prtsUrl(operatorName) {
    return `https://prts.wiki/w/${encodeURIComponent(operatorName)}#技能`;
  }

  function renderProfessionControls() {
    elements.professionTabs.innerHTML = ["全部", ...professions].map((profession) =>
      `<button type="button" data-profession="${profession}" class="${selectedProfession === profession ? "active" : ""}">${profession}</button>`
    ).join("");
    elements.professionLegend.innerHTML = professions.map((profession) =>
      `<div class="profession-item" style="${roleStyle(profession)}"><span class="profession-dot"></span>${profession}</div>`
    ).join("");
  }

  function renderOperators() {
    const query = elements.operatorSearch.value.trim().toLowerCase();
    const filtered = DATA.operators.filter((operator) => {
      const available = isAvailable(operator);
      const matchesAvailability = availabilityFilter === "all" || (availabilityFilter === "available" ? available : !available);
      const matchesProfession = selectedProfession === "全部" || operator.profession === selectedProfession;
      const matchesQuery = !query || operator.name.toLowerCase().includes(query);
      return matchesAvailability && matchesProfession && matchesQuery;
    });

    if (!filtered.length) {
      elements.operatorList.innerHTML = `<div class="empty-result">没有符合条件的干员</div>`;
      return;
    }

    const groups = selectedProfession === "全部" ? professions : [selectedProfession];
    elements.operatorList.innerHTML = groups.map((profession) => {
      const members = filtered.filter((operator) => operator.profession === profession);
      if (!members.length) return "";
      return `
        <div class="operator-group-title">${profession}<span>${members.length}</span></div>
        ${members.map((operator) => {
          const placement = operatorPlacement(operator.id);
          const available = isAvailable(operator);
          const isDefaultCore = operator.name === "银灰";
          const selectable = available && !isDefaultCore;
          return `<div
            class="operator-card ${available ? "" : "spent"} ${isDefaultCore ? "fixed-core" : ""} ${selectedOperatorId === operator.id ? "selected" : ""}"
            style="${roleStyle(operator.profession)}"
            data-operator-id="${operator.id}"
            draggable="${selectable}"
          >
            <button
              class="operator-select"
              type="button"
              ${selectable ? "" : "disabled"}
              aria-label="${operator.name}，${isDefaultCore ? "已默认编入全部关卡" : (available ? "选择编队" : `已用于 ${placement?.stageId}`)}"
            >
              <span class="operator-abbr">${abbreviations[operator.profession]}</span>
              <span class="operator-info"><strong>${operator.name}</strong><small><b>${operator.rarity}★</b> · ${isDefaultCore ? "默认编入全部关卡" : (placement ? `已用于 ${placement.stageId}` : "单次使用")}</small></span>
              ${operator.repeatable ? '<span class="repeat-badge" title="可重复">∞</span>' : ""}
            </button>
            <a
              class="operator-prts"
              href="${prtsUrl(operator.name)}"
              target="_blank"
              rel="noopener noreferrer"
              draggable="false"
              aria-label="在 PRTS 查看 ${operator.name} 的技能"
              title="在 PRTS 查看技能"
            >技能 ↗</a>
          </div>`;
        }).join("")}
      `;
    }).join("");
  }

  function renderChapterStrip() {
    const buttons = [
      { id: "all", text: "全部" },
      ...DATA.chapters.map((chapter) => ({ id: chapter.id, text: chapter.id === "0" ? "序" : chapter.id })),
    ];
    elements.chapterStrip.innerHTML = buttons.map((button) =>
      `<button type="button" data-chapter="${button.id}" class="${selectedChapter === button.id ? "active" : ""}">${button.text}</button>`
    ).join("");
  }

  function renderStages() {
    const query = elements.stageSearch.value.trim().toLowerCase();
    const chapters = selectedChapter === "all" ? DATA.chapters : [chapterById.get(selectedChapter)].filter(Boolean);
    let visibleCount = 0;

    const content = chapters.map((chapter) => {
      const stages = chapter.stages.filter((stage) => {
        const planned = assignmentList(stage.id).length > 0;
        const cleared = Boolean(state.cleared[stage.id]);
        const matchesQuery = !query || stage.code.toLowerCase().includes(query) || chapter.title.toLowerCase().includes(query);
        const matchesFilter = stageFilter === "all"
          || (stageFilter === "planned" && planned)
          || (stageFilter === "cleared" && cleared)
          || (stageFilter === "empty" && !planned);
        return matchesQuery && matchesFilter;
      });
      visibleCount += stages.length;
      if (!stages.length) return "";
      return `
        <section class="chapter-section">
          <div class="chapter-title">
            <h3>${chapter.label}<span>${chapter.title}</span></h3>
            <small>${stages.length} 关</small>
          </div>
          <div class="stage-grid">${stages.map(renderStageCard).join("")}</div>
        </section>`;
    }).join("");

    elements.chapterContent.innerHTML = content || `<div class="no-stage-result">没有符合条件的关卡</div>`;
    elements.stageCount.textContent = `${visibleCount} 个作战关卡`;
  }

  function renderStageCard(stage) {
    const assignments = [
      { operatorId: silverash.id, placementId: `default-${stage.id}`, fixed: true },
      ...assignmentList(stage.id),
    ];
    const cleared = Boolean(state.cleared[stage.id]);
    const hasNote = Object.prototype.hasOwnProperty.call(state.notes, stage.id);
    return `
      <article class="stage-card ${cleared ? "cleared" : ""}" data-stage-id="${stage.id}" tabindex="0">
        <div class="stage-card-header">
          <span class="stage-code">${stage.code}</span>
          <span class="stage-type ${stage.type === "绝境" ? "hard" : ""}">${stage.type}</span>
          <div class="stage-controls">
            <button type="button" class="note-toggle ${hasNote ? "active" : ""}" title="备注" aria-label="编辑 ${stage.id} 备注">✎</button>
            <button type="button" class="clear-toggle ${cleared ? "active" : ""}" title="${cleared ? "取消通关" : "标记通关"}" aria-label="${cleared ? "取消通关" : "标记通关"}">✓</button>
          </div>
        </div>
        <div class="stage-body">
          ${assignments.length ? `<div class="operator-chips">${assignments.map((item) => {
            const operator = operatorById.get(item.operatorId);
            if (!operator) return "";
            return `<div class="operator-chip ${item.fixed ? "fixed" : ""}" style="${roleStyle(operator.profession)}" draggable="${!item.fixed}" data-placement-id="${item.placementId}" data-operator-id="${operator.id}" title="${item.fixed ? "银灰默认编入此关" : "拖动可移动到其他关卡"}">
              <a class="operator-chip-prts" href="${prtsUrl(operator.name)}" target="_blank" rel="noopener noreferrer" draggable="false" title="在 PRTS 查看技能">${operator.name}${operator.repeatable ? " ∞" : ""}</a>
              ${item.fixed ? '<span class="fixed-badge">默认</span>' : `<button type="button" class="remove-operator" aria-label="撤回 ${operator.name}">×</button>`}
            </div>`;
          }).join("")}</div>` : `<div class="drop-copy">拖放干员到这里</div>`}
        </div>
        ${hasNote ? `<textarea class="stage-note" placeholder="记录技能、站位或打法…">${escapeHtml(state.notes[stage.id] || "")}</textarea>` : ""}
      </article>`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" }[char]));
  }

  function renderStats() {
    const spent = DATA.operators.filter((operator) => !operator.repeatable && !isAvailable(operator)).length;
    const available = DATA.operators.length - spent;
    const planned = DATA.chapters.flatMap((chapter) => chapter.stages).filter((stage) => assignmentList(stage.id).length).length;
    const silverashCount = DATA.meta.stageCount;
    elements.poolCount.textContent = availabilityFilter === "available" ? available : DATA.operators.length;
    elements.availableStat.textContent = available;
    elements.spentStat.textContent = spent;
    elements.plannedStat.textContent = planned;
    elements.silverashStat.textContent = silverashCount;
    elements.selectedBanner.hidden = !selectedOperatorId;
    elements.selectedOperatorName.textContent = selectedOperatorId ? operatorById.get(selectedOperatorId)?.name || "" : "";
  }

  function renderAll() {
    renderProfessionControls();
    renderOperators();
    renderChapterStrip();
    renderStages();
    renderStats();
  }

  elements.operatorSearch.addEventListener("input", renderOperators);
  elements.stageSearch.addEventListener("input", renderStages);
  elements.createRoomButton.addEventListener("click", createRoom);
  elements.joinRoomButton.addEventListener("click", joinRoom);
  elements.roomInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") joinRoom();
  });
  elements.copyRoomButton.addEventListener("click", async () => {
    if (!roomId) return;
    const link = roomUrl();
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const helper = document.createElement("textarea");
      helper.value = link;
      document.body.appendChild(helper);
      helper.select();
      document.execCommand("copy");
      helper.remove();
    }
    showToast("房间链接已复制");
  });

  elements.professionTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-profession]");
    if (!button) return;
    selectedProfession = button.dataset.profession;
    renderProfessionControls();
    renderOperators();
  });

  elements.availabilityFilter.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter]");
    if (!button) return;
    availabilityFilter = button.dataset.filter;
    elements.availabilityFilter.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
    renderOperators();
    renderStats();
  });

  elements.chapterStrip.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-chapter]");
    if (!button) return;
    selectedChapter = button.dataset.chapter;
    renderChapterStrip();
    renderStages();
  });

  elements.stageFilter.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter]");
    if (!button) return;
    stageFilter = button.dataset.filter;
    elements.stageFilter.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
    renderStages();
  });

  elements.operatorList.addEventListener("click", (event) => {
    if (event.target.closest(".operator-prts")) return;
    const selectButton = event.target.closest(".operator-select");
    if (!selectButton) return;
    const card = event.target.closest(".operator-card");
    if (!card || card.classList.contains("spent")) return;
    selectedOperatorId = selectedOperatorId === card.dataset.operatorId ? null : card.dataset.operatorId;
    renderOperators();
    renderStats();
    if (selectedOperatorId) showToast(`已选择 ${operatorById.get(selectedOperatorId).name}，现在点击一个关卡`);
  });

  elements.operatorList.addEventListener("dragstart", (event) => {
    const card = event.target.closest(".operator-card");
    if (!card || card.classList.contains("spent") || card.classList.contains("fixed-core")) return;
    dragged = { operatorId: card.dataset.operatorId, sourceStageId: null, placementId: null };
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("text/plain", card.dataset.operatorId);
  });

  elements.chapterContent.addEventListener("dragstart", (event) => {
    const chip = event.target.closest(".operator-chip");
    if (!chip || chip.classList.contains("fixed")) return;
    const stage = chip.closest(".stage-card");
    dragged = { operatorId: chip.dataset.operatorId, sourceStageId: stage.dataset.stageId, placementId: chip.dataset.placementId };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", chip.dataset.operatorId);
  });

  elements.chapterContent.addEventListener("dragover", (event) => {
    const stage = event.target.closest(".stage-card");
    if (!stage || !dragged) return;
    event.preventDefault();
    stage.classList.add("drag-over");
    event.dataTransfer.dropEffect = dragged.sourceStageId ? "move" : "copy";
  });

  elements.chapterContent.addEventListener("dragleave", (event) => {
    const stage = event.target.closest(".stage-card");
    if (stage && !stage.contains(event.relatedTarget)) stage.classList.remove("drag-over");
  });

  elements.chapterContent.addEventListener("drop", (event) => {
    const stage = event.target.closest(".stage-card");
    if (!stage || !dragged) return;
    event.preventDefault();
    stage.classList.remove("drag-over");
    addOperatorToStage(dragged.operatorId, stage.dataset.stageId, dragged.sourceStageId, dragged.placementId);
    dragged = null;
  });

  document.addEventListener("dragend", () => {
    dragged = null;
    document.querySelectorAll(".drag-over").forEach((element) => element.classList.remove("drag-over"));
  });

  elements.chapterContent.addEventListener("click", (event) => {
    const stageCard = event.target.closest(".stage-card");
    if (!stageCard) return;
    const stageId = stageCard.dataset.stageId;
    const removeButton = event.target.closest(".remove-operator");
    if (removeButton) {
      const chip = removeButton.closest(".operator-chip");
      removeOperator(stageId, chip.dataset.placementId);
      return;
    }
    if (event.target.closest(".clear-toggle")) {
      snapshot();
      state.cleared[stageId] = !state.cleared[stageId];
      if (!state.cleared[stageId]) delete state.cleared[stageId];
      commit(state.cleared[stageId] ? `${stageId} 已标记通关` : `${stageId} 已取消通关`);
      return;
    }
    if (event.target.closest(".note-toggle")) {
      snapshot();
      if (Object.prototype.hasOwnProperty.call(state.notes, stageId)) delete state.notes[stageId];
      else state.notes[stageId] = "";
      commit();
      requestAnimationFrame(() => document.querySelector(`[data-stage-id="${stageId}"] .stage-note`)?.focus());
      return;
    }
    if (selectedOperatorId && !event.target.closest("button, textarea, .operator-chip")) {
      addOperatorToStage(selectedOperatorId, stageId);
    }
  });

  elements.chapterContent.addEventListener("input", (event) => {
    const textarea = event.target.closest(".stage-note");
    if (!textarea) return;
    const stageId = textarea.closest(".stage-card").dataset.stageId;
    state.notes[stageId] = textarea.value;
    saveState();
  });

  elements.clearSelection.addEventListener("click", () => {
    selectedOperatorId = null;
    renderOperators();
    renderStats();
  });

  elements.undoButton.addEventListener("click", undo);

  elements.exportButton.addEventListener("click", () => {
    const payload = { version: 1, exportedAt: new Date().toISOString(), state };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `银灰塔记录-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast("记录已导出");
  });

  elements.importInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const imported = payload.state || payload;
      if (!imported.assignments || typeof imported.assignments !== "object") throw new Error("格式无效");
      snapshot();
      state = { ...defaultState(), ...imported };
      commit("记录已导入");
    } catch {
      showToast("导入失败：请选择本站导出的 JSON 文件");
    } finally {
      event.target.value = "";
    }
  });

  elements.resetButton.addEventListener("click", () => {
    const hasProgress = Object.keys(state.assignments).length || Object.keys(state.cleared).length || Object.keys(state.notes).length;
    if (!hasProgress) return showToast("当前没有需要重置的记录");
    if (!window.confirm("确定清空所有编队、通关状态和备注吗？此操作可以立即撤销一次。")) return;
    snapshot();
    state = defaultState();
    commit("银灰塔记录已重置");
  });

  renderAll();
  startRoom();
})();
