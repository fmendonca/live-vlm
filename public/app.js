const presets = [
  {
    id: "security",
    name: "Segurança",
    prompt:
      "Analise a cena em tempo real. Descreva pessoas, veículos, objetos relevantes, comportamentos incomuns, riscos imediatos e mudanças importantes desde a última observação. Seja objetivo."
  },
  {
    id: "industrial",
    name: "Operação industrial",
    prompt:
      "Monitore a cena como inspeção industrial. Identifique EPIs, máquinas, zonas bloqueadas, vazamentos, fumaça, obstruções, pessoas em área de risco e anomalias visuais."
  },
  {
    id: "retail",
    name: "Varejo",
    prompt:
      "Observe fluxo de pessoas, filas, prateleiras, áreas vazias, interações e eventos que exigem atenção operacional. Responda com uma lista curta de achados."
  },
  {
    id: "traffic",
    name: "Tráfego",
    prompt:
      "Analise o tráfego. Identifique congestionamento, pedestres, veículos parados, acidentes, direção de fluxo, bloqueios e situações inseguras."
  },
  {
    id: "custom",
    name: "Customizado",
    prompt: "Descreva a imagem e destaque qualquer detalhe importante para tomada de decisão."
  }
];

const state = {
  mode: "webcam",
  stream: null,
  rtspSession: null,
  analysisTimer: null,
  analysisActive: false,
  analysisAbort: null,
  inFlight: false,
  lastAnswer: ""
};

const $ = (id) => document.getElementById(id);

const els = {
  webcamMode: $("webcamMode"),
  rtspMode: $("rtspMode"),
  cameraSelect: $("cameraSelect"),
  rtspUrl: $("rtspUrl"),
  startSource: $("startSource"),
  stopSource: $("stopSource"),
  endpoint: $("endpoint"),
  model: $("model"),
  loadModels: $("loadModels"),
  apiKey: $("apiKey"),
  protocol: $("protocol"),
  presetSelect: $("presetSelect"),
  prompt: $("prompt"),
  interval: $("interval"),
  intervalLabel: $("intervalLabel"),
  startAnalysis: $("startAnalysis"),
  stopAnalysis: $("stopAnalysis"),
  abortAnalysis: $("abortAnalysis"),
  singleShot: $("singleShot"),
  clearLog: $("clearLog"),
  video: $("video"),
  rtspPreview: $("rtspPreview"),
  canvas: $("captureCanvas"),
  emptyState: $("emptyState"),
  sourceStatus: $("sourceStatus"),
  analysisStatus: $("analysisStatus"),
  log: $("log")
};

async function loadVersion() {
  try {
    const response = await fetch("/api/version");
    const data = await response.json();
    const versionEl = $("appVersion");
    if (versionEl && data.version) versionEl.textContent = `v${data.version}`;
  } catch {
    // The static UI remains usable even if version metadata is unavailable.
  }
}

function setStatus(el, text, kind = "idle") {
  el.textContent = text;
  el.className = `status ${kind}`;
}

function toggleMode(mode) {
  state.mode = mode;
  els.webcamMode.classList.toggle("active", mode === "webcam");
  els.rtspMode.classList.toggle("active", mode === "rtsp");
  document.querySelectorAll(".webcam-only").forEach((el) => el.classList.toggle("hidden", mode !== "webcam"));
  document.querySelectorAll(".rtsp-only").forEach((el) => el.classList.toggle("hidden", mode !== "rtsp"));
}

function addLog(message, meta = "") {
  const entry = document.createElement("article");
  entry.className = "entry";
  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `
    <div class="entry-meta"><span>${time}</span><span>${meta}</span></div>
    <pre></pre>
  `;
  entry.querySelector("pre").textContent = message || "(sem resposta)";
  els.log.prepend(entry);
}

function updateAnalysisControls() {
  els.startAnalysis.disabled = state.analysisActive;
  els.stopAnalysis.disabled = !state.analysisActive;
  els.abortAnalysis.disabled = !state.analysisActive && !state.inFlight;
  els.singleShot.disabled = state.inFlight;
}

async function loadCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === "videoinput");
    els.cameraSelect.innerHTML = "";
    cameras.forEach((camera, index) => {
      const option = document.createElement("option");
      option.value = camera.deviceId;
      option.textContent = camera.label || `Camera ${index + 1}`;
      els.cameraSelect.append(option);
    });
  } catch (error) {
    addLog(`Não foi possível listar webcams: ${error.message}`, "fonte");
  }
}

async function startWebcam() {
  stopCurrentSource();
  const deviceId = els.cameraSelect.value;
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  });
  els.video.srcObject = state.stream;
  els.video.classList.remove("hidden");
  els.rtspPreview.classList.add("hidden");
  els.emptyState.classList.add("hidden");
  setStatus(els.sourceStatus, "webcam ativa", "live");
  await loadCameras();
}

async function startRtsp() {
  stopCurrentSource();
  const rtspUrl = els.rtspUrl.value.trim();
  if (!rtspUrl) throw new Error("Informe uma URL RTSP.");

  const response = await fetch("/api/rtsp/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rtspUrl })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Falha ao iniciar RTSP.");

  state.rtspSession = data;
  els.rtspPreview.src = `${data.mjpegUrl}?t=${Date.now()}`;
  els.video.classList.add("hidden");
  els.rtspPreview.classList.remove("hidden");
  els.emptyState.classList.add("hidden");
  setStatus(els.sourceStatus, "rtsp ativo", "live");
}

function stopCurrentSource() {
  if (state.analysisActive || state.inFlight) stopAnalysisLoop();

  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }

  if (state.rtspSession) {
    fetch(`/api/rtsp/${state.rtspSession.id}/stop`, { method: "POST" }).catch(() => {});
    state.rtspSession = null;
  }

  els.video.srcObject = null;
  els.rtspPreview.removeAttribute("src");
  els.video.classList.add("hidden");
  els.rtspPreview.classList.add("hidden");
  els.emptyState.classList.remove("hidden");
  setStatus(els.sourceStatus, "fonte parada", "idle");
}

async function captureFrame() {
  const canvas = els.canvas;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  if (state.mode === "rtsp") {
    if (!state.rtspSession) throw new Error("RTSP não iniciado.");
    const response = await fetch(`/api/rtsp/${state.rtspSession.id}/snapshot?t=${Date.now()}`);
    if (!response.ok) throw new Error("Snapshot RTSP ainda não disponível.");
    const blob = await response.blob();
    return await blobToDataUrl(blob);
  }

  if (!state.stream || !els.video.videoWidth) throw new Error("Webcam não iniciada.");
  const width = Math.min(720, els.video.videoWidth);
  const height = Math.round((els.video.videoHeight / els.video.videoWidth) * width);
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(els.video, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.72);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function analyzeOnce() {
  if (state.inFlight) return;
  state.inFlight = true;
  state.analysisAbort = new AbortController();
  updateAnalysisControls();
  setStatus(els.analysisStatus, "analisando", "busy");

  try {
    const imageDataUrl = await captureFrame();
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: els.endpoint.value.trim(),
        model: els.model.value.trim(),
        apiKey: els.apiKey.value.trim(),
        protocol: els.protocol.value,
        prompt: withContext(els.prompt.value.trim()),
        imageDataUrl
      }),
      signal: state.analysisAbort.signal
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 499) {
        pauseAnalysisLoop("análise pausada por erro do modelo");
      }
      const detail = data?.raw?.message || data?.raw?.error?.message || data?.error || data?.answer;
      throw new Error(detail || `Falha ao analisar frame (${response.status}).`);
    }

    state.lastAnswer = data.answer;
    addLog(data.answer, `${data.latencyMs}ms · ${data.endpoint || "endpoint"}`);
  } catch (error) {
    if (error.name === "AbortError") {
      addLog("Chamada ao LLM interrompida.", "parado");
    } else {
      addLog(error.message, "erro");
    }
  } finally {
    state.inFlight = false;
    state.analysisAbort = null;
    setStatus(els.analysisStatus, state.analysisActive ? "análise ativa" : "análise pausada", state.analysisActive ? "live" : "idle");
    updateAnalysisControls();
  }
}

async function loadModelsFromEndpoint() {
  try {
    const response = await fetch("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: els.endpoint.value.trim(),
        apiKey: els.apiKey.value.trim()
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Falha ao carregar modelos.");
    if (!data.models.length) throw new Error("O endpoint respondeu, mas não retornou modelos em data[].id.");

    if (!data.models.includes(els.model.value.trim())) {
      els.model.value = data.models[0];
      persistSettings();
    }
    addLog(`Modelos vLLM disponíveis:\n${data.models.join("\n")}`, data.endpoint);
  } catch (error) {
    addLog(error.message, "modelos");
  }
}

function withContext(prompt) {
  if (!state.lastAnswer) return prompt;
  const previous = state.lastAnswer.length > 1200 ? state.lastAnswer.slice(-1200) : state.lastAnswer;
  return `${prompt}\n\nObservação anterior do modelo:\n${previous}\n\nAtualize a análise considerando o frame atual.`;
}

async function validateModelBeforeLoop() {
  if (els.protocol.value !== "vllm") return;
  const endpoint = els.endpoint.value.trim();
  const currentModel = els.model.value.trim();
  if (!endpoint || !currentModel) throw new Error("Informe endpoint e modelo antes de iniciar a análise.");

  const response = await fetch("/api/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint,
      apiKey: els.apiKey.value.trim()
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Não foi possível validar modelos no vLLM.");
  if (data.models.length && !data.models.includes(currentModel)) {
    els.model.value = data.models[0];
    persistSettings();
    addLog(`Modelo ajustado para o id publicado pelo vLLM: ${data.models[0]}`, "modelo");
  }
}

function scheduleNextAnalysis() {
  if (!state.analysisActive) return;
  if (state.analysisTimer) clearTimeout(state.analysisTimer);
  state.analysisTimer = setTimeout(async () => {
    if (!state.analysisActive) return;
    await analyzeOnce();
    scheduleNextAnalysis();
  }, Number(els.interval.value));
}

async function startAnalysisLoop() {
  if (state.analysisActive) return;
  try {
    await validateModelBeforeLoop();
  } catch (error) {
    addLog(error.message, "modelo");
    setStatus(els.analysisStatus, "análise pausada", "idle");
    return;
  }
  state.analysisActive = true;
  setStatus(els.analysisStatus, "análise ativa", "live");
  updateAnalysisControls();
  await analyzeOnce();
  scheduleNextAnalysis();
}

function pauseAnalysisLoop(statusText = "análise pausada") {
  if (state.analysisTimer) clearTimeout(state.analysisTimer);
  state.analysisTimer = null;
  state.analysisActive = false;
  setStatus(els.analysisStatus, statusText, "idle");
  updateAnalysisControls();
}

function stopAnalysisLoop() {
  pauseAnalysisLoop("análise parada");
  if (state.analysisAbort) state.analysisAbort.abort();
}

function persistSettings() {
  const data = {
    endpoint: els.endpoint.value,
    model: els.model.value,
    protocol: els.protocol.value,
    rtspUrl: els.rtspUrl.value,
    interval: els.interval.value,
    prompt: els.prompt.value,
    preset: els.presetSelect.value
  };
  localStorage.setItem("live-vlm-settings", JSON.stringify(data));
}

function restoreSettings() {
  const saved = JSON.parse(localStorage.getItem("live-vlm-settings") || "{}");
  els.endpoint.value = saved.endpoint || "";
  els.model.value = saved.model || "llama-3.2-11b-vision";
  els.protocol.value = saved.protocol === "openai" ? "vllm" : saved.protocol || "vllm";
  els.rtspUrl.value = saved.rtspUrl || "";
  els.interval.value = saved.interval || "2000";
  els.intervalLabel.textContent = `${(Number(els.interval.value) / 1000).toFixed(1)}s`;
  els.presetSelect.value = saved.preset || "security";
  els.prompt.value = saved.prompt || presets[0].prompt;
}

function initPresets() {
  for (const preset of presets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.name;
    els.presetSelect.append(option);
  }
}

els.webcamMode.addEventListener("click", () => toggleMode("webcam"));
els.rtspMode.addEventListener("click", () => toggleMode("rtsp"));
els.startSource.addEventListener("click", async () => {
  try {
    if (state.mode === "webcam") await startWebcam();
    else await startRtsp();
  } catch (error) {
    addLog(error.message, "fonte");
  }
});
els.stopSource.addEventListener("click", () => {
  stopAnalysisLoop();
  stopCurrentSource();
});
els.startAnalysis.addEventListener("click", startAnalysisLoop);
els.stopAnalysis.addEventListener("click", () => pauseAnalysisLoop());
els.abortAnalysis.addEventListener("click", stopAnalysisLoop);
els.singleShot.addEventListener("click", analyzeOnce);
els.loadModels.addEventListener("click", loadModelsFromEndpoint);
els.clearLog.addEventListener("click", () => {
  els.log.innerHTML = "";
});
els.interval.addEventListener("input", () => {
  els.intervalLabel.textContent = `${(Number(els.interval.value) / 1000).toFixed(1)}s`;
  if (state.analysisActive) scheduleNextAnalysis();
});
els.presetSelect.addEventListener("change", () => {
  const preset = presets.find((item) => item.id === els.presetSelect.value);
  if (preset) els.prompt.value = preset.prompt;
});
document.addEventListener("input", persistSettings);
document.addEventListener("change", persistSettings);
window.addEventListener("beforeunload", () => {
  stopAnalysisLoop();
  stopCurrentSource();
});

initPresets();
restoreSettings();
loadVersion();
loadCameras();
updateAnalysisControls();
