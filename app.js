(() => {
  const DATA = window.SILVERASH_DATA;
  const STORAGE_KEY = "silverash-tower-board-v1";
  const DURABLE_ROOM_API = String(window.SILVERASH_ROOM_API || "").replace(/\/+$/, "");
  const clientId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

  const initialParams = new URLSearchParams(window.location.search);
  const initialLegacyRoom = initialParams.get("room");
  let state = loadState(initialLegacyRoom ? `${STORAGE_KEY}:room:${initialLegacyRoom}` : STORAGE_KEY, Boolean(initialLegacyRoom));
  let history = [];
  let selectedChapter = "17";
  let selectedProfession = "全部";
  let selectedRarity = "all";
  let availabilityFilter = "available";
  let stageFilter = "all";
  let selectedOperatorId = null;
  let dragged = null;
  let toastTimer = null;
  let roomId = initialLegacyRoom;
  let roomName = initialLegacyRoom || "";
  let roomMode = initialLegacyRoom ? "legacy" : "";
  let roomKey = null;
  let roomNameKey = "";
  let roomIntent = initialLegacyRoom ? "join" : "";
  let roomReady = false;
  let roomGeneration = 0;
  let syncSequence = 0;
  let syncTimer = null;
  let pollTimer = null;
  let overviewTimer = null;
  let noteSaveTimer = null;
  let syncInFlight = false;
  let pollInFlight = false;
  let lastRoomErrorAt = 0;
  let roomProof = null;
  let roomToken = null;
  let roomVersion = 0;
  let roomBaseState = null;
  let localEditsPending = false;
  let durableRetryDelay = 3000;
  let sharedDoc = null;
  let sharedMap = null;
  let sharedProvider = null;
  let sharedReady = null;
  let remoteApplying = false;

  const elements = {
    operatorList: document.querySelector("#operatorList"),
    operatorSearch: document.querySelector("#operatorSearch"),
    professionTabs: document.querySelector("#professionTabs"),
    rarityTabs: document.querySelector("#rarityTabs"),
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
    clearedStat: document.querySelector("#clearedStat"),
    silverashStat: document.querySelector("#silverashStat"),
    professionLegend: document.querySelector("#professionLegend"),
    saveState: document.querySelector("#saveState"),
    undoButton: document.querySelector("#undoButton"),
    exportButton: document.querySelector("#exportButton"),
    importInput: document.querySelector("#importInput"),
    resetButton: document.querySelector("#resetButton"),
    toast: document.querySelector("#toast"),
    collabStatus: document.querySelector("#collabStatus"),
    roomHint: document.querySelector("#roomHint"),
    createRoomButton: document.querySelector("#createRoomButton"),
    copyRoomButton: document.querySelector("#copyRoomButton"),
    leaveRoomButton: document.querySelector("#leaveRoomButton"),
    syncRoomButton: document.querySelector("#syncRoomButton"),
    restoreLegacyButton: document.querySelector("#restoreLegacyButton"),
    roomInput: document.querySelector("#roomInput"),
    roomPasswordInput: document.querySelector("#roomPasswordInput"),
    memberNameInput: document.querySelector("#memberNameInput"),
    roomDashboard: document.querySelector("#roomDashboard"),
    onlineCount: document.querySelector("#onlineCount"),
    onlineMembers: document.querySelector("#onlineMembers"),
    roomEvents: document.querySelector("#roomEvents"),
    joinRoomButton: document.querySelector("#joinRoomButton"),
  };

  function activeStorageKey() {
    return roomId ? `${STORAGE_KEY}:room:${roomId}` : STORAGE_KEY;
  }

  function activeSyncMetaKey() {
    return `${STORAGE_KEY}:sync:${roomId}`;
  }

  function readSyncMeta() {
    try {
      return JSON.parse(localStorage.getItem(activeSyncMetaKey())) || null;
    } catch {
      return null;
    }
  }

  function writeSyncMeta(dirty = localEditsPending) {
    if (!isDurableRoom()) return;
    localStorage.setItem(activeSyncMetaKey(), JSON.stringify({
      version: roomVersion,
      baseState: roomBaseState,
      dirty,
    }));
  }

  function loadState(key = STORAGE_KEY, legacyFallback = false) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || (legacyFallback ? localStorage.getItem(STORAGE_KEY) : null));
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
    localStorage.setItem(activeStorageKey(), JSON.stringify(state));
    elements.saveState.innerHTML = isDurableRoom()
      ? "<i></i> 本机已保存 · 云端同步中"
      : "<i></i> 已自动保存";
    if (roomId && sync) {
      if (isDurableRoom()) {
        localEditsPending = true;
        writeSyncMeta(true);
      }
      queueSharedSync();
    }
  }

  function flushNoteSave() {
    if (!noteSaveTimer) return;
    clearTimeout(noteSaveTimer);
    noteSaveTimer = null;
    saveState();
  }

  function isDurableRoom() {
    return roomMode === "secure" && Boolean(DURABLE_ROOM_API);
  }

  function isEncryptedRoom() {
    return roomMode === "secure" || roomMode === "secure-legacy";
  }

  function parseRoomInput(value) {
    const input = String(value || "").trim();
    if (!input) return null;
    try {
      const url = new URL(input);
      if (url.searchParams.get("name")) return { mode: "secure", name: url.searchParams.get("name").trim() };
      if (url.searchParams.get("room")) return { mode: "legacy", name: url.searchParams.get("room").trim() };
    } catch { /* A plain room name is valid too. */ }
    if (/^at-[a-z0-9-]+$/i.test(input)) return { mode: "legacy", name: input };
    return { mode: "secure", name: input };
  }

  function roomUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    url.searchParams.delete("name");
    if (isEncryptedRoom()) url.searchParams.set("name", roomName);
    else if (roomId) url.searchParams.set("room", roomId);
    return url.toString();
  }

  function lockBoard(locked) {
    document.querySelector(".workspace").inert = locked;
    document.querySelector(".top-actions").inert = locked;
    document.body.classList.toggle("room-connecting", locked);
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 32768) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  }

  function bytesToHex(bytes) {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function deriveRoom(name, password) {
    const normalized = name.normalize("NFKC").trim().toLowerCase();
    const encoder = new TextEncoder();
    const source = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({
      name: "PBKDF2",
      salt: encoder.encode(`silverash-tower-room-v2:${normalized}`),
      iterations: 250000,
      hash: "SHA-256",
    }, source, 768);
    const bytes = new Uint8Array(bits);
    const id = `secure-${bytesToHex(bytes.subarray(0, 32))}`;
    const key = await crypto.subtle.importKey("raw", bytes.subarray(32, 64), "AES-GCM", false, ["encrypt", "decrypt"]);
    const proof = bytesToHex(bytes.subarray(64, 96));
    return { id, key, proof, normalized };
  }

  async function encryptRoomState(nextState) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify({ format: "silverash-room-v2", name: roomNameKey, state: nextState }));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, roomKey, plaintext);
    return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) };
  }

  async function decryptRoomState(payload) {
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(payload.iv) }, roomKey, base64ToBytes(payload.data));
    const contents = JSON.parse(new TextDecoder().decode(decrypted));
    if (contents.format !== "silverash-room-v2" || contents.name !== roomNameKey) throw new Error("房间密码不匹配");
    return contents.state;
  }

  function copyState(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function hasProgress(value) {
    return Boolean(Object.keys(value?.assignments || {}).length
      || Object.keys(value?.cleared || {}).length
      || Object.keys(value?.notes || {}).length);
  }

  function memberName() {
    return elements.memberNameInput.value.normalize("NFKC").trim().slice(0, 20) || "访客";
  }

  function summarizeChanges(before, after) {
    const lines = [];
    for (const stageId of new Set([...Object.keys(before.cleared || {}), ...Object.keys(after.cleared || {}), ...Object.keys(before.notes || {}), ...Object.keys(after.notes || {})])) {
      const changes = [];
      if (Boolean(before.cleared?.[stageId]) !== Boolean(after.cleared?.[stageId])) changes.push(after.cleared?.[stageId] ? "已通关" : "未通关");
      if ((before.notes?.[stageId] || "") !== (after.notes?.[stageId] || "")
          || Object.hasOwn(before.notes || {}, stageId) !== Object.hasOwn(after.notes || {}, stageId)) changes.push("备注有改动");
      if (changes.length) lines.push(`${stageId}：${changes.join("，")}`);
    }
    return lines.join("；").slice(0, 400);
  }

  function renderOverview(data) {
    const members = Array.isArray(data.members) ? data.members : [];
    elements.onlineCount.textContent = String(members.length);
    elements.onlineMembers.replaceChildren();
    for (const member of members) {
      const chip = document.createElement("span");
      chip.className = `member-chip${member.self ? " self" : ""}`;
      chip.textContent = `${member.nickname || "访客"}${member.self ? "（我）" : ""}`;
      elements.onlineMembers.append(chip);
    }
    if (!members.length) elements.onlineMembers.textContent = "暂无在线成员";
    const events = Array.isArray(data.events) ? data.events : [];
    const grouped = new Map();
    for (const event of events) {
      const when = new Date(event.created_at);
      if (Number.isNaN(when.getTime())) continue;
      const day = when.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
      for (const part of String(event.summary || "").split("；")) {
        const match = part.match(/^([^：]+)：(.+)$/);
        if (!match) continue;
        const stage = match[1].trim();
        const detail = match[2];
        const status = /未通关|取消通关/.test(detail) ? "未通关" : /已通关|标记通关/.test(detail) ? "已通关" : null;
        const note = /备注/.test(detail);
        if (!status && !note) continue;
        const key = `${day}|${stage}`;
        if (!grouped.has(key)) grouped.set(key, { day, stage, status: null, note: false });
        const item = grouped.get(key);
        item.status ||= status;
        item.note ||= note;
      }
    }
    elements.roomEvents.replaceChildren();
    let previousDay = "";
    for (const item of grouped.values()) {
      const { day } = item;
      if (day !== previousDay) {
        const heading = document.createElement("div");
        heading.className = "event-day";
        heading.textContent = day;
        elements.roomEvents.append(heading);
        previousDay = day;
      }
      const row = document.createElement("div");
      row.className = "event-row";
      row.textContent = `${item.stage} · ${[item.status, item.note ? "备注有改动" : null].filter(Boolean).join(" · ")}`;
      elements.roomEvents.append(row);
    }
    if (!grouped.size) elements.roomEvents.textContent = "还没有通关或备注调整。";
  }

  async function refreshOverview(generation) {
    if (generation !== roomGeneration || !roomReady || !isDurableRoom()) return;
    try {
      const { response, data } = await roomRequest("/rooms/overview", { method: "POST", body: { id: roomId, nickname: memberName() } });
      if (generation === roomGeneration && response.ok && data) renderOverview(data);
    } catch { /* State sync reports connection failures separately. */ }
    if (generation === roomGeneration && roomReady) {
      clearTimeout(overviewTimer);
      overviewTimer = setTimeout(() => refreshOverview(generation), document.hidden ? 60000 : 30000);
    }
  }

  async function roomRequest(path, { method = "GET", body, token = roomToken } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${DURABLE_ROOM_API}${path}`, {
        method,
        mode: "cors",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { "X-Room-Token": token } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = response.status === 304 ? null : await response.json().catch(() => null);
      return { response, data };
    } finally {
      clearTimeout(timeout);
    }
  }

  function mergeStageChanges(base, local, remote) {
    const merged = { ...defaultState(), ...copyState(remote) };
    const preferredStages = [];
    for (const field of ["assignments", "cleared", "notes"]) {
      const baseMap = base?.[field] || {};
      const localMap = local[field] || {};
      const output = merged[field] ||= {};
      for (const stageId of new Set([...Object.keys(baseMap), ...Object.keys(localMap)])) {
        if (JSON.stringify(baseMap[stageId]) === JSON.stringify(localMap[stageId])) continue;
        if (field === "assignments") preferredStages.push(stageId);
        if (Object.prototype.hasOwnProperty.call(localMap, stageId)) output[stageId] = copyState(localMap[stageId]);
        else delete output[stageId];
      }
    }
    const seen = new Set();
    for (const stageId of [...new Set([...preferredStages, ...Object.keys(merged.assignments)])]) {
      merged.assignments[stageId] = (merged.assignments[stageId] || []).filter((item) => {
        const operator = operatorById.get(item.operatorId);
        if (!operator || operator.repeatable || operator.id === silverash?.id) return true;
        if (seen.has(item.operatorId)) return false;
        seen.add(item.operatorId);
        return true;
      });
      if (!merged.assignments[stageId].length) delete merged.assignments[stageId];
    }
    merged.updatedAt = new Date().toISOString();
    merged.revision = Math.max(Number(local.revision || 0), Number(remote.revision || 0)) + 1;
    return merged;
  }

  function expireDurableSession() {
    roomReady = false;
    roomToken = null;
    clearTimeout(pollTimer);
    clearTimeout(overviewTimer);
    elements.roomDashboard.hidden = true;
    elements.copyRoomButton.disabled = true;
    elements.syncRoomButton.disabled = true;
    elements.saveState.innerHTML = "<i></i> 仅保存在本机";
    lockBoard(false);
    setCollabStatus(`房间「${roomName}」 · 请重新输入密码加入`, "error");
  }

  async function publishDurableState() {
    if (!roomReady || !isDurableRoom() || !roomToken || syncInFlight || !localEditsPending) return;
    syncInFlight = true;
    const generation = roomGeneration;
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (generation !== roomGeneration) return;
        const snapshot = copyState(state);
        const base = copyState(roomBaseState || defaultState());
        const payload = await encryptRoomState(snapshot);
        const { response, data } = await roomRequest("/rooms/state", {
          method: "PUT",
          body: { id: roomId, payload, expectedVersion: roomVersion, summary: summarizeChanges(base, snapshot) },
        });
        if (generation !== roomGeneration) return;
        if (response.ok && Number.isInteger(data?.version)) {
          durableRetryDelay = 3000;
          roomVersion = data.version;
          roomBaseState = snapshot;
          localEditsPending = JSON.stringify(state) !== JSON.stringify(snapshot);
          writeSyncMeta(localEditsPending);
          setCollabStatus(`房间「${roomName}」 · 已保存到云端`, "ready");
          elements.saveState.innerHTML = localEditsPending
            ? "<i></i> 本机已保存 · 云端同步中"
            : "<i></i> 已保存云端";
          void refreshOverview(generation);
          return;
        }
        if (response.status === 409 && data?.payload && Number.isInteger(data.version)) {
          const remote = await decryptRoomState(data.payload);
          if (generation !== roomGeneration) return;
          state = mergeStageChanges(base, state, remote);
          localStorage.setItem(activeStorageKey(), JSON.stringify(state));
          roomBaseState = copyState(remote);
          roomVersion = data.version;
          writeSyncMeta(true);
          renderAll();
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          expireDurableSession();
          throw new Error("房间验证已过期，请重新输入密码加入");
        }
        throw new Error(data?.error || "云端保存失败");
      }
      throw new Error("多人同时修改较频繁，稍后自动重试");
    } catch (error) {
      if (generation !== roomGeneration) return;
      durableRetryDelay = Math.min(durableRetryDelay * 2, 60000);
      if (roomReady) setCollabStatus(`房间「${roomName}」 · 尚未保存到云端`, "error");
      elements.saveState.innerHTML = "<i></i> 仅保存在本机";
      if (Date.now() - lastRoomErrorAt > 15000) {
        showToast(error.message || "云端保存失败，记录暂存在本机");
        lastRoomErrorAt = Date.now();
      }
    } finally {
      if (generation === roomGeneration) syncInFlight = false;
      if (generation === roomGeneration && roomReady && localEditsPending) {
        clearTimeout(syncTimer);
        syncTimer = setTimeout(publishDurableState, durableRetryDelay);
      }
    }
  }

  async function pollDurableRoom(generation) {
    if (generation !== roomGeneration || !roomReady || !isDurableRoom() || syncInFlight || pollInFlight) return;
    if (localEditsPending) return void publishDurableState();
    pollInFlight = true;
    try {
      const { response, data } = await roomRequest(`/rooms/state?id=${encodeURIComponent(roomId)}&since=${roomVersion}`);
      if (generation !== roomGeneration || localEditsPending) return;
      if (response.status === 304) return;
      if (response.status === 401 || response.status === 403) {
        expireDurableSession();
        throw new Error("房间验证已过期，请重新输入密码加入");
      }
      if (!response.ok || !data?.payload || !Number.isInteger(data.version)) throw new Error("读取云端记录失败");
      const remote = await decryptRoomState(data.payload);
      if (generation !== roomGeneration || localEditsPending) return;
      roomVersion = data.version;
      roomBaseState = copyState(remote);
      applyRemoteState(remote);
      writeSyncMeta(false);
      setCollabStatus(`房间「${roomName}」 · 已连接云端`, "ready");
      elements.saveState.innerHTML = "<i></i> 已保存云端";
    } catch (error) {
      if (generation !== roomGeneration) return;
      if (roomReady) setCollabStatus(`房间「${roomName}」 · 云端暂时不可用`, "error");
    } finally {
      if (generation === roomGeneration) pollInFlight = false;
    }
  }

  function scheduleDurablePoll(generation) {
    clearTimeout(pollTimer);
    if (generation !== roomGeneration || !roomReady || !isDurableRoom()) return;
    pollTimer = setTimeout(async () => {
      await pollDurableRoom(generation);
      scheduleDurablePoll(generation);
    }, document.hidden ? 120000 : 30000);
  }

  async function initDurableRoom(generation) {
    setCollabStatus(`房间「${roomName}」 · 正在连接云端`, "pending");
    try {
      const name = roomName;
      const id = roomId;
      const proof = roomProof;
      let createdOnJoin = false;
      let result = await roomRequest(roomIntent === "create" ? "/rooms/create" : "/rooms/join", {
        method: "POST",
        token: null,
        body: roomIntent === "create"
          ? { id, name, proof, nickname: memberName(), payload: await encryptRoomState(copyState(state)) }
          : { id, name, proof, nickname: memberName() },
      });
      if (generation !== roomGeneration) return;
      if (roomIntent === "join" && result.response.status === 404) {
        result = await roomRequest("/rooms/create", {
          method: "POST", token: null,
          body: { id, name, proof, nickname: memberName(), payload: await encryptRoomState(copyState(state)) },
        });
        createdOnJoin = result.response.status === 201;
      }
      if (result.response.status === 409) {
        result = await roomRequest("/rooms/join", { method: "POST", token: null, body: { id, name, proof, nickname: memberName() } });
      }
      if (generation !== roomGeneration) return;
      if (!result.response.ok || !result.data?.token || !Number.isInteger(result.data.version)) {
        if (result.response.status === 404) throw new Error("没有找到房间，请先创建");
        if (result.response.status === 401 || result.response.status === 403) throw new Error("房间已存在，请核对房间名和密码");
        throw new Error(result.data?.error || "无法连接房间数据库");
      }
      roomToken = result.data.token;
      roomVersion = result.data.version;
      roomProof = null;
      const cachedState = copyState(state);
      const syncMeta = readSyncMeta();
      const migrationKey = `${STORAGE_KEY}:cloud-joined:${id}`;
      if (result.data.payload) {
        const remote = await decryptRoomState(result.data.payload);
        if (generation !== roomGeneration) return;
        roomBaseState = copyState(remote);
        if (syncMeta?.dirty && syncMeta.baseState) {
          state = mergeStageChanges(syncMeta.baseState, cachedState, remote);
          localStorage.setItem(activeStorageKey(), JSON.stringify(state));
          localEditsPending = true;
          renderAll();
        } else if (!createdOnJoin && !syncMeta && !localStorage.getItem(migrationKey)
            && hasProgress(cachedState) && !hasProgress(remote)) {
          state = cachedState;
          localEditsPending = true;
          renderAll();
        } else {
          if (!syncMeta && !localStorage.getItem(migrationKey) && hasProgress(cachedState)
              && JSON.stringify(cachedState) !== JSON.stringify(remote)) {
            localStorage.setItem(`${STORAGE_KEY}:legacy-backup:${id}`, JSON.stringify(cachedState));
          }
          applyRemoteState(remote, { force: true });
        }
      }
      localStorage.setItem(migrationKey, "1");
      elements.restoreLegacyButton.hidden = !localStorage.getItem(`${STORAGE_KEY}:legacy-backup:${id}`);
      roomBaseState ||= copyState(state);
      writeSyncMeta(localEditsPending);
      markRoomReady();
      elements.roomDashboard.hidden = false;
      void refreshOverview(generation);
      setCollabStatus(`房间「${roomName}」 · 已保存到云端`, "ready");
      elements.saveState.innerHTML = localEditsPending
        ? "<i></i> 本机已保存 · 云端同步中"
        : "<i></i> 已保存云端";
      scheduleDurablePoll(generation);
      if (localEditsPending) queueSharedSync();
      showToast(createdOnJoin ? "云端房间已自动建立，可随时加入" : roomIntent === "create" ? "云端房间已创建" : "已载入云端房间记录");
    } catch (error) {
      if (generation !== roomGeneration) return;
      roomProof = null;
      setCollabStatus(`房间「${roomName}」 · ${error.message || "连接失败"}`, "error");
      elements.saveState.innerHTML = "<i></i> 仅保存在本机";
      showToast(error.message || "无法连接房间数据库");
    }
  }

  async function publishCurrentState() {
    if (!roomReady || !sharedMap) return;
    const generation = roomGeneration;
    const sequence = ++syncSequence;
    const copy = JSON.parse(JSON.stringify(state));
    try {
      const payload = isEncryptedRoom() ? await encryptRoomState(copy) : copy;
      if (generation !== roomGeneration || sequence !== syncSequence || !sharedMap) return;
      sharedDoc.transact(() => {
        sharedMap.set("writer", clientId);
        sharedMap.set(isEncryptedRoom() ? "payload" : "state", payload);
      });
      setCollabStatus(`房间「${roomName}」 · 已同步`, "ready");
    } catch {
      setCollabStatus(`房间「${roomName}」 · 同步失败`, "error");
      showToast("同步失败，请先导出记录备份");
    }
  }

  function queueSharedSync() {
    if (!roomReady || remoteApplying) return;
    if (isDurableRoom()) {
      clearTimeout(syncTimer);
      setCollabStatus(`房间「${roomName}」 · 正在保存云端`, "pending");
      syncTimer = setTimeout(publishDurableState, 250);
      return;
    }
    if (!sharedMap) return;
    clearTimeout(syncTimer);
    setCollabStatus(`房间「${roomName}」 · 正在同步`, "pending");
    syncTimer = setTimeout(publishCurrentState, 120);
  }

  function applyRemoteState(nextState, { force = false } = {}) {
    if (!nextState || typeof nextState !== "object" || !nextState.assignments) return;
    if (!force && JSON.stringify(nextState) === JSON.stringify(state)) return;
    remoteApplying = true;
    state = { ...defaultState(), ...nextState };
    localStorage.setItem(activeStorageKey(), JSON.stringify(state));
    history = [];
    renderAll();
    remoteApplying = false;
    if (!force) showToast("已同步协作者的最新记录");
  }

  function markRoomReady() {
    roomReady = true;
    lockBoard(false);
    elements.copyRoomButton.disabled = false;
    elements.syncRoomButton.disabled = !isDurableRoom();
    setCollabStatus(`房间「${roomName}」 · 已连接`, "ready");
  }

  async function receiveRoomState(generation, initial = false) {
    if (generation !== roomGeneration || !sharedMap) return;
    const payload = sharedMap.get(isEncryptedRoom() ? "payload" : "state");
    if (!payload || (sharedMap.get("writer") === clientId && roomReady && !initial)) return;
    try {
      const nextState = isEncryptedRoom() ? await decryptRoomState(payload) : payload;
      if (generation !== roomGeneration) return;
      applyRemoteState(nextState, { force: !roomReady });
      if (!roomReady) markRoomReady();
    } catch {
      if (generation !== roomGeneration) return;
      setCollabStatus(`房间「${roomName}」 · 密码或记录无效`, "error");
      showToast("无法读取房间记录，请检查密码");
    }
  }

  async function initSharedRoom(generation) {
    setCollabStatus(`房间「${roomName}」 · 正在连接`, "pending");
    try {
      const [{ Doc }, { WebsocketProvider }] = await Promise.all([
        import("https://esm.sh/yjs@13.6.27"),
        import("https://esm.sh/y-websocket@2.0.4"),
      ]);
      if (generation !== roomGeneration) return;
      sharedDoc = new Doc();
      sharedMap = sharedDoc.getMap("silverash-tower-board");
      sharedMap.observe(() => { void receiveRoomState(generation); });
      sharedProvider = new WebsocketProvider("wss://demos.yjs.dev/ws", `silverash-tower-${roomId}`, sharedDoc);
      sharedProvider.on("status", ({ status }) => {
        if (generation !== roomGeneration) return;
        setCollabStatus(status === "connected"
          ? `房间「${roomName}」 · ${roomReady ? "已连接" : "正在验证"}`
          : `房间「${roomName}」 · 正在重连`, status === "connected" && roomReady ? "ready" : "pending");
      });
      sharedProvider.on("sync", (synced) => {
        if (!synced || generation !== roomGeneration) return;
        const existing = sharedMap.get(isEncryptedRoom() ? "payload" : "state");
        if (existing) {
          void receiveRoomState(generation, true);
        } else if (roomIntent === "create" || roomMode === "legacy") {
          if (!state.updatedAt) saveState({ sync: false });
          markRoomReady();
          void publishCurrentState();
          showToast("房间已创建，分享链接并单独告知密码");
        } else {
          setCollabStatus(`房间「${roomName}」 · 未找到房间或密码错误`, "error");
          showToast("未找到房间，请核对名称和密码；房主可能需要先在线");
        }
      });
    } catch {
      if (generation !== roomGeneration) return;
      setCollabStatus(`房间「${roomName}」 · 连接失败`, "error");
      showToast("协作服务暂时不可用，请稍后重试");
    }
  }

  function startRoom() {
    roomGeneration += 1;
    syncSequence += 1;
    clearTimeout(syncTimer);
    clearTimeout(pollTimer);
    clearTimeout(overviewTimer);
    elements.roomDashboard.hidden = true;
    if (sharedProvider) sharedProvider.destroy();
    if (sharedDoc) sharedDoc.destroy();
    sharedDoc = null;
    sharedMap = null;
    sharedProvider = null;
    roomToken = null;
    roomVersion = 0;
    roomBaseState = null;
    localEditsPending = false;
    durableRetryDelay = 3000;
    syncInFlight = false;
    pollInFlight = false;
    roomReady = false;
    elements.copyRoomButton.disabled = true;
    elements.leaveRoomButton.hidden = !roomId;
    elements.syncRoomButton.hidden = !roomId || !isDurableRoom();
    elements.restoreLegacyButton.hidden = true;
    elements.syncRoomButton.disabled = true;
    if (elements.roomHint) {
      elements.roomHint.textContent = roomMode === "secure-legacy"
        ? "这是旧版密码房间，仍使用临时协作服务。可点击“创建房间”将当前记录保存到云端。"
        : roomMode === "legacy"
        ? "这是旧版临时房间：没有密码，也没有云端长期保存。请导出记录备份。"
        : DURABLE_ROOM_API
          ? "同名同密码随时可加入，房主无需在线；房间不存在时自动建立。队友更新约 30 秒内显示，也可点“立即同步”。"
          : "队友输入相同房间名和密码即可加入；邀请链接不含密码，请单独告知。协作记录建议定期导出备份。";
    }
    lockBoard(Boolean(roomId));
    if (!roomId) {
      elements.saveState.innerHTML = "<i></i> 已自动保存";
      setCollabStatus(elements.roomInput.value ? "输入密码即可加入该房间" : "本机记录 · 还没有共享");
      return;
    }
    elements.saveState.innerHTML = isDurableRoom()
      ? "<i></i> 正在连接云端"
      : "<i></i> 已自动保存";
    elements.roomInput.value = roomName;
    if (isDurableRoom()) void initDurableRoom(roomGeneration);
    else void initSharedRoom(roomGeneration);
  }

  async function createRoom() {
    flushNoteSave();
    const name = elements.roomInput.value.normalize("NFKC").trim();
    const password = elements.roomPasswordInput.value;
    if (name.length < 2 || name.length > 40 || /^https?:\/\//i.test(name)) return showToast("房间名请输入 2～40 个字");
    if (password.length < 8) return showToast("密码至少需要 8 位");
    setCollabStatus("正在创建协作房间…", "pending");
    try {
      const credentials = await deriveRoom(name, password);
      const currentState = JSON.parse(JSON.stringify(state));
      roomId = credentials.id;
      roomName = name;
      roomNameKey = credentials.normalized;
      roomKey = credentials.key;
      roomProof = credentials.proof;
      roomMode = "secure";
      roomIntent = "create";
      const roomCacheKey = `${STORAGE_KEY}:room:${roomId}`;
      state = localStorage.getItem(roomCacheKey)
        ? loadState(roomCacheKey)
        : { ...defaultState(), ...currentState };
      history = [];
      elements.roomPasswordInput.value = "";
      window.history.replaceState({}, "", roomUrl());
      renderAll();
      startRoom();
    } catch {
      setCollabStatus("创建失败，请稍后重试", "error");
      showToast("无法创建房间，请检查浏览器是否支持安全连接");
    }
  }

  async function joinRoom() {
    flushNoteSave();
    const parsed = parseRoomInput(elements.roomInput.value);
    if (!parsed) return showToast("请输入房间名或邀请链接");
    if (parsed.name.length > 40) return showToast("房间名不能超过 40 个字");
    const password = elements.roomPasswordInput.value;
    if (parsed.mode === "secure" && !password) return showToast("请输入房间密码");
    setCollabStatus("正在加入协作房间…", "pending");
    try {
      const credentials = parsed.mode === "secure" ? await deriveRoom(parsed.name, password) : null;
      roomId = credentials?.id || parsed.name;
      roomName = parsed.name;
      roomNameKey = credentials?.normalized || "";
      roomKey = credentials?.key || null;
      roomProof = credentials?.proof || null;
      roomMode = parsed.mode;
      roomIntent = "join";
      state = loadState(activeStorageKey(), parsed.mode === "legacy");
      history = [];
      elements.roomPasswordInput.value = "";
      window.history.replaceState({}, "", roomUrl());
      renderAll();
      startRoom();
    } catch {
      setCollabStatus("加入失败，请稍后重试", "error");
      showToast("无法加入房间，请检查房间名和密码");
    }
  }

  function leaveRoom() {
    flushNoteSave();
    roomId = null;
    roomName = "";
    roomNameKey = "";
    roomKey = null;
    roomProof = null;
    roomToken = null;
    roomMode = "";
    roomIntent = "";
    state = loadState();
    history = [];
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    url.searchParams.delete("name");
    window.history.replaceState({}, "", url);
    elements.roomInput.value = "";
    elements.roomPasswordInput.value = "";
    renderAll();
    startRoom();
    showToast("已退出协作房间，返回本机记录");
  }

  function snapshot() {
    history.push(JSON.stringify(state));
    if (history.length > 30) history.shift();
    elements.undoButton.disabled = false;
  }

  function commit(message) {
    clearTimeout(noteSaveTimer);
    noteSaveTimer = null;
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
      const matchesRarity = selectedRarity === "all" || operator.rarity === Number(selectedRarity);
      const matchesQuery = !query || operator.name.toLowerCase().includes(query);
      return matchesAvailability && matchesProfession && matchesRarity && matchesQuery;
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
    const activeSearch = document.activeElement?.closest(".stage-operator-search");
    const searchDraft = activeSearch ? {
      stageId: activeSearch.closest(".stage-card").dataset.stageId,
      value: activeSearch.value,
      cursor: activeSearch.selectionStart,
    } : null;
    const query = elements.stageSearch.value.trim().toLowerCase();
    const chapters = selectedChapter === "all" ? DATA.chapters : [chapterById.get(selectedChapter)].filter(Boolean);
    let visibleCount = 0;

    const content = chapters.map((chapter) => {
      const stages = chapter.stages.filter((stage) => {
        const planned = assignmentList(stage.id).length > 0;
        const cleared = Boolean(state.cleared[stage.id]);
        const matchesQuery = !query || stage.code.toLowerCase().includes(query) || chapter.title.toLowerCase().includes(query);
        const matchesFilter = stageFilter === "all"
          || (stageFilter === "cleared" && cleared)
          || (stageFilter === "uncleared" && !cleared)
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
    if (searchDraft) {
      const input = document.getElementById(`operator-search-${searchDraft.stageId}`);
      if (input) {
        input.value = searchDraft.value;
        input.focus({ preventScroll: true });
        input.setSelectionRange(searchDraft.cursor, searchDraft.cursor);
        renderStageOperatorResults(input);
      }
    }
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
        <div class="stage-picker">
          <label class="stage-picker-label" for="operator-search-${stage.id}">＋ 搜索添加干员</label>
          <input id="operator-search-${stage.id}" class="stage-operator-search" type="text" autocomplete="off" placeholder="输入干员名字…" aria-label="搜索干员并添加到 ${stage.code}" aria-controls="operator-results-${stage.id}">
          <div id="operator-results-${stage.id}" class="stage-operator-results" aria-label="${stage.code} 的干员搜索结果" hidden></div>
        </div>
        ${hasNote ? `<textarea class="stage-note" placeholder="记录技能、站位或打法…">${escapeHtml(state.notes[stage.id] || "")}</textarea>` : ""}
      </article>`;
  }

  function stageOperatorMatches(input) {
    const query = input.value.trim().toLowerCase();
    if (!query) return [];
    const stageId = input.closest(".stage-card").dataset.stageId;
    return DATA.operators.filter((operator) => operator.name.toLowerCase().includes(query)).map((operator) => {
      const placement = operatorPlacement(operator.id);
      const status = operator.id === silverash.id ? "已默认编入"
        : assignmentList(stageId).some((item) => item.operatorId === operator.id) ? "已在本关"
        : !isAvailable(operator) ? `已用于 ${placement.stageId}` : "点击编入";
      return { operator, status, available: status === "点击编入" };
    }).sort((a, b) => Number(b.available) - Number(a.available)
      || Number(b.operator.name.toLowerCase() === query) - Number(a.operator.name.toLowerCase() === query)
      || b.operator.rarity - a.operator.rarity
      || a.operator.name.localeCompare(b.operator.name, "zh-CN"));
  }

  function renderStageOperatorResults(input) {
    const results = input.closest(".stage-picker").querySelector(".stage-operator-results");
    const matches = stageOperatorMatches(input);
    results.hidden = !input.value.trim();
    results.innerHTML = matches.length ? matches.map(({ operator, status, available }) => `
      <button type="button" class="stage-operator-option" data-add-operator="${escapeHtml(operator.id)}" ${available ? "" : "disabled"}>
        <span><strong>${escapeHtml(operator.name)}</strong><small>${operator.rarity}★ · ${escapeHtml(operator.profession)}</small></span>
        <span class="stage-option-status">${escapeHtml(status)}</span>
      </button>`).join("") : '<p class="stage-search-empty" role="status">没有找到该干员，请换个名字</p>';
  }

  function addSearchedOperator(input, operatorId) {
    const stageId = input.closest(".stage-card").dataset.stageId;
    input.value = "";
    addOperatorToStage(operatorId, stageId);
    document.getElementById(`operator-search-${stageId}`)?.focus({ preventScroll: true });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" }[char]));
  }

  function renderStats() {
    const spent = DATA.operators.filter((operator) => !operator.repeatable && !isAvailable(operator)).length;
    const available = DATA.operators.length - spent;
    const cleared = Object.values(state.cleared).filter(Boolean).length;
    const silverashCount = DATA.meta.stageCount;
    elements.poolCount.textContent = availabilityFilter === "available" ? available : DATA.operators.length;
    elements.availableStat.textContent = available;
    elements.spentStat.textContent = spent;
    elements.clearedStat.textContent = cleared;
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
  elements.leaveRoomButton.addEventListener("click", leaveRoom);
  elements.syncRoomButton.addEventListener("click", async () => {
    if (!roomReady || !isDurableRoom()) return;
    if (localEditsPending) await publishDurableState();
    else await pollDurableRoom(roomGeneration);
    if (roomReady) void refreshOverview(roomGeneration);
    if (roomReady) showToast(localEditsPending ? "仍有记录等待云端保存" : "已检查云端最新记录");
  });
  elements.restoreLegacyButton.addEventListener("click", () => {
    if (!roomReady || !isDurableRoom()) return;
    const backupKey = `${STORAGE_KEY}:legacy-backup:${roomId}`;
    const old = JSON.parse(localStorage.getItem(backupKey) || "null");
    if (!old?.assignments) return;
    if (!window.confirm("将旧本机记录合并进当前云端房间？同一关有冲突时会以旧本机记录为准。")) return;
    snapshot();
    state = mergeStageChanges(defaultState(), old, state);
    localStorage.removeItem(backupKey);
    elements.restoreLegacyButton.hidden = true;
    commit("旧本机记录已合并，正在保存到云端");
  });
  elements.roomInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") joinRoom();
  });
  elements.roomPasswordInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") joinRoom();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushNoteSave();
    if (!roomReady || !isDurableRoom()) return;
    const generation = roomGeneration;
    if (!document.hidden) {
      void pollDurableRoom(generation);
      void refreshOverview(generation);
    }
    scheduleDurablePoll(generation);
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
    showToast("邀请链接已复制，密码请单独告知队友");
  });

  elements.professionTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-profession]");
    if (!button) return;
    selectedProfession = button.dataset.profession;
    renderProfessionControls();
    renderOperators();
  });

  elements.rarityTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-rarity]");
    if (!button) return;
    selectedRarity = button.dataset.rarity;
    elements.rarityTabs.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
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
    stageFilter = button.dataset.filter === "toggle-clear"
      ? stageFilter === "cleared" ? "uncleared" : "cleared"
      : button.dataset.filter;
    elements.stageFilter.querySelectorAll("button").forEach((item) => {
      item.classList.toggle("active", item.dataset.filter === "toggle-clear"
        ? stageFilter === "cleared" || stageFilter === "uncleared"
        : item.dataset.filter === stageFilter);
    });
    const clearFilter = elements.stageFilter.querySelector('[data-filter="toggle-clear"]');
    clearFilter.textContent = stageFilter === "uncleared" ? "未通关" : "已通关";
    clearFilter.setAttribute("aria-label", `${clearFilter.textContent}关卡，再点切换`);
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
    if (event.target.closest(".stage-picker")) {
      const option = event.target.closest("button[data-add-operator]");
      if (option && !option.disabled) {
        addSearchedOperator(stageCard.querySelector(".stage-operator-search"), option.dataset.addOperator);
      }
      return;
    }
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
    if (event.target.matches(".stage-operator-search")) {
      renderStageOperatorResults(event.target);
      return;
    }
    const textarea = event.target.closest(".stage-note");
    if (!textarea) return;
    const stageId = textarea.closest(".stage-card").dataset.stageId;
    state.notes[stageId] = textarea.value;
    saveState({ sync: false });
    if (isDurableRoom()) {
      localEditsPending = true;
      writeSyncMeta(true);
      clearTimeout(syncTimer);
    }
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(flushNoteSave, 2500);
  });

  elements.chapterContent.addEventListener("focusin", (event) => {
    if (event.target.matches(".stage-operator-search")) renderStageOperatorResults(event.target);
  });

  elements.chapterContent.addEventListener("focusout", (event) => {
    if (event.target.matches(".stage-note")) flushNoteSave();
    const picker = event.target.closest(".stage-picker");
    if (picker && !picker.contains(event.relatedTarget)) picker.querySelector(".stage-operator-results").hidden = true;
  });

  elements.chapterContent.addEventListener("keydown", (event) => {
    const picker = event.target.closest(".stage-picker");
    if (!picker || event.isComposing || event.keyCode === 229) return;
    const input = picker.querySelector(".stage-operator-search");
    if (event.key === "Escape") {
      event.preventDefault();
      input.focus();
      picker.querySelector(".stage-operator-results").hidden = true;
    } else if (event.target === input && event.key === "Enter") {
      event.preventDefault();
      const available = stageOperatorMatches(input).filter((match) => match.available);
      const exact = available.find(({ operator }) => operator.name.toLowerCase() === input.value.trim().toLowerCase());
      const match = exact || (available.length === 1 ? available[0] : null);
      if (match) addSearchedOperator(input, match.operator.id);
      else if (input.value.trim()) showToast(available.length ? "请点击要编入的干员" : "没有匹配的可用干员");
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (event.target === input) renderStageOperatorResults(input);
      const options = [...picker.querySelectorAll(".stage-operator-option:not(:disabled)")];
      const index = options.indexOf(event.target);
      const next = event.key === "ArrowDown" ? index + 1 : (index < 0 ? options.length - 1 : index - 1);
      if (next >= 0 && next < options.length) options[next].focus();
      else input.focus();
    }
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

  const savedNickname = localStorage.getItem(`${STORAGE_KEY}:nickname`);
  elements.memberNameInput.value = savedNickname || `玩家-${Math.random().toString(36).slice(2, 6)}`;
  if (!savedNickname) localStorage.setItem(`${STORAGE_KEY}:nickname`, elements.memberNameInput.value);
  elements.memberNameInput.addEventListener("change", () => {
    elements.memberNameInput.value = memberName();
    localStorage.setItem(`${STORAGE_KEY}:nickname`, memberName());
    if (roomReady && isDurableRoom()) void refreshOverview(roomGeneration);
  });

  if (initialParams.get("name")) elements.roomInput.value = initialParams.get("name");
  renderAll();
  startRoom();
})();

