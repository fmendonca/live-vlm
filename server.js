import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnalysisRecord, exportAnalysisRecord, getExportConfig, isExportConfigured } from "./storage.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const appVersion = process.env.APP_VERSION || "0.1.13";
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const rtspSessions = new Map();
const exportConfig = getExportConfig();
const defaultAzureApiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-12-01-preview";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

mkdirSync(publicDir, { recursive: true });

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 25 * 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve(raw ? JSON.parse(raw) : {});
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = normalize(join(publicDir, requested));

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const ext = extname(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    res.end(readFileSync(filePath));
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function buildOpenAiPayload({ model, prompt, imageDataUrl }) {
  return {
    model: model || "llama-3.2-11b-vision",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } }
        ]
      }
    ],
    temperature: 0.2,
    max_tokens: 500
  };
}

function buildAzurePayload({ prompt, imageDataUrl }) {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } }
        ]
      }
    ],
    max_completion_tokens: 500
  };
}

function normalizeEndpointInput(endpoint) {
  const value = String(endpoint || "").trim();
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) return value;
  return `http://${value}`;
}

function normalizeOpenAiUrl(endpoint, resource) {
  const url = new URL(normalizeEndpointInput(endpoint));
  const path = url.pathname.replace(/\/+$/, "");

  if (resource === "models") {
    if (path.endsWith("/v1/models")) return url.toString();
    if (path.endsWith("/v1/chat/completions")) {
      url.pathname = path.replace(/\/chat\/completions$/, "/models");
      return url.toString();
    }
    if (path.endsWith("/v1")) {
      url.pathname = `${path}/models`;
      return url.toString();
    }
    url.pathname = `${path}/v1/models`;
    return url.toString();
  }

  if (path.endsWith("/v1/chat/completions")) return url.toString();
  if (path.endsWith("/v1/models")) {
    url.pathname = path.replace(/\/models$/, "/chat/completions");
    return url.toString();
  }
  if (path.endsWith("/v1")) {
    url.pathname = `${path}/chat/completions`;
    return url.toString();
  }
  url.pathname = `${path}/v1/chat/completions`;
  return url.toString();
}

function normalizeAzureUrl(endpoint, deployment) {
  const url = new URL(normalizeEndpointInput(endpoint));
  const path = url.pathname.replace(/\/+$/, "");
  const encodedDeployment = encodeURIComponent(deployment);

  if (!url.searchParams.has("api-version")) {
    url.searchParams.set("api-version", defaultAzureApiVersion);
  }

  if (path.endsWith("/chat/completions") && path.includes("/openai/deployments/")) {
    return url.toString();
  }

  if (path.includes("/openai/deployments/")) {
    url.pathname = `${path}/chat/completions`;
    return url.toString();
  }

  url.pathname = `${path}/openai/deployments/${encodedDeployment}/chat/completions`;
  return url.toString();
}

function normalizeOllamaUrl(endpoint, resource) {
  const url = new URL(normalizeEndpointInput(endpoint));
  const path = url.pathname.replace(/\/+$/, "");

  if (resource === "models") {
    if (path.endsWith("/api/tags")) return url.toString();
    if (path.endsWith("/api/chat")) {
      url.pathname = path.replace(/\/chat$/, "/tags");
      return url.toString();
    }
    if (path.endsWith("/api")) {
      url.pathname = `${path}/tags`;
      return url.toString();
    }
    url.pathname = `${path}/api/tags`;
    return url.toString();
  }

  if (path.endsWith("/api/chat")) return url.toString();
  if (path.endsWith("/api/tags")) {
    url.pathname = path.replace(/\/tags$/, "/chat");
    return url.toString();
  }
  if (path.endsWith("/api")) {
    url.pathname = `${path}/chat`;
    return url.toString();
  }
  url.pathname = `${path}/api/chat`;
  return url.toString();
}

function buildOllamaPayload({ model, prompt, imageDataUrl }) {
  return {
    model: model || "llava:latest",
    stream: false,
    messages: [
      {
        role: "user",
        content: prompt,
        images: [imageDataUrl.replace(/^data:image\/\w+;base64,/, "")]
      }
    ],
    options: {
      temperature: 0.2
    }
  };
}

async function handleModels(req, res) {
  let modelsUrl = "";
  try {
    const body = await readBody(req);
    const endpoint = String(body.endpoint || "").trim();
    const apiKey = String(body.apiKey || "").trim();
    const protocol = ["azure", "ollama"].includes(body.protocol) ? body.protocol : "vllm";

    if (!endpoint) {
      sendJson(res, 400, { error: "endpoint is required" });
      return;
    }

    if (protocol === "azure") {
      sendJson(res, 400, {
        error: "Azure OpenAI não expõe uma listagem /models compatível aqui. Informe o deployment/modelo manualmente."
      });
      return;
    }

    const headers = {};
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    modelsUrl = protocol === "ollama"
      ? normalizeOllamaUrl(endpoint, "models")
      : normalizeOpenAiUrl(endpoint, "models");
    logApp("models_load_attempt", { protocol, endpoint: modelsUrl });
    const upstream = await fetch(modelsUrl, { method: "GET", headers });
    const text = await upstream.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    const models = protocol === "ollama"
      ? (Array.isArray(parsed?.models) ? parsed.models.map((item) => item.name).filter(Boolean) : [])
      : (Array.isArray(parsed?.data) ? parsed.data.map((item) => item.id).filter(Boolean) : []);

    sendJson(res, upstream.ok ? 200 : upstream.status, {
      ok: upstream.ok,
      status: upstream.status,
      models,
      endpoint: modelsUrl,
      raw: parsed
    });
  } catch (error) {
    logApp("models_load_error", { endpoint: modelsUrl || null, error: error.message }, "error");
    sendJson(res, 500, {
      error: error.message,
      endpoint: modelsUrl || null,
      hint: "Para Ollama, use algo como http://IP:11434 ou IP:11434. O servidor da WebUI precisa conseguir acessar esse IP pela rede."
    });
  }
}

async function handleAnalyze(req, res) {
  const upstreamAbort = new AbortController();
  const timeout = setTimeout(() => upstreamAbort.abort(), 120000);
  res.on("close", () => {
    if (!res.writableEnded) upstreamAbort.abort();
  });

  try {
    const body = await readBody(req);
    const endpoint = String(body.endpoint || "").trim();
    const prompt = String(body.prompt || "").trim();
    const imageDataUrl = String(body.imageDataUrl || "").trim();
    const apiKey = String(body.apiKey || "").trim();
    const model = String(body.model || "").trim();
    const effectiveModel = model || "llama-3.2-11b-vision";
    const protocol = ["azure", "generic", "ollama"].includes(body.protocol) ? body.protocol : "vllm";
    const preset = String(body.preset || "").trim();
    const source = String(body.source || "").trim();

    if (!endpoint || !prompt || !imageDataUrl) {
      sendJson(res, 400, { error: "endpoint, prompt and imageDataUrl are required" });
      return;
    }

    if (!imageDataUrl.startsWith("data:image/")) {
      sendJson(res, 400, { error: "imageDataUrl must be a data:image URL" });
      return;
    }

    if (protocol === "azure" && !model) {
      sendJson(res, 400, { error: "Azure OpenAI requires a deployment/model name." });
      return;
    }

    const headers = { "content-type": "application/json" };
    if (apiKey) {
      if (protocol === "azure") headers["api-key"] = apiKey;
      else headers.authorization = `Bearer ${apiKey}`;
    }

    const payload =
      protocol === "azure"
        ? buildAzurePayload({ prompt, imageDataUrl })
        : protocol === "vllm"
          ? buildOpenAiPayload({ model: effectiveModel, prompt, imageDataUrl })
        : protocol === "ollama"
          ? buildOllamaPayload({ model: effectiveModel, prompt, imageDataUrl })
        : {
            model: effectiveModel,
            prompt,
            image: imageDataUrl.replace(/^data:image\/\w+;base64,/, "")
          };

    const startedAt = Date.now();
    const upstreamUrl = protocol === "azure"
      ? normalizeAzureUrl(endpoint, model)
      : protocol === "vllm"
        ? normalizeOpenAiUrl(endpoint, "chat")
        : protocol === "ollama"
          ? normalizeOllamaUrl(endpoint, "chat")
          : endpoint;
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: upstreamAbort.signal
    });

    const text = await upstream.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    const answer =
      parsed?.choices?.[0]?.message?.content ||
      parsed?.choices?.[0]?.text ||
      parsed?.message?.content ||
      parsed?.answer ||
      parsed?.response ||
      parsed?.raw ||
      "";

    const responsePayload = {
      ok: upstream.ok,
      status: upstream.status,
      latencyMs: Date.now() - startedAt,
      endpoint: upstreamUrl,
      answer,
      raw: parsed
    };

    if (upstream.ok && exportConfig.enabled) {
      const record = createAnalysisRecord({
        appVersion,
        request: { model, protocol, prompt, preset, source },
        response: responsePayload
      });
      try {
        logApp("analysis_export_attempt", {
          provider: exportConfig.provider,
          model: effectiveModel,
          status: upstream.status,
          latencyMs: responsePayload.latencyMs
        });
        responsePayload.export = await exportAnalysisRecord(record, exportConfig);
        logApp("analysis_export_success", {
          provider: responsePayload.export.provider,
          key: responsePayload.export.key,
          model: effectiveModel,
          latencyMs: responsePayload.latencyMs
        });
      } catch (error) {
        responsePayload.export = {
          enabled: true,
          provider: exportConfig.provider,
          error: error.message
        };
        logApp("analysis_export_error", {
          provider: exportConfig.provider,
          model: effectiveModel,
          error: error.message
        }, "error");
      }
    } else {
      responsePayload.export = { enabled: exportConfig.enabled };
    }

    if (!res.writableEnded) sendJson(res, upstream.ok ? 200 : upstream.status, responsePayload);
  } catch (error) {
    if (error.name === "AbortError") {
      if (!res.writableEnded) sendJson(res, 499, { error: "LLM request aborted" });
      return;
    }
    if (!res.writableEnded) sendJson(res, 500, { error: error.message });
  } finally {
    clearTimeout(timeout);
  }
}

function startRtspSession(rtspUrl) {
  const id = randomUUID();
  const clients = new Set();
  let latestFrame = null;
  let frameBuffer = Buffer.alloc(0);

  const ffmpeg = spawn("ffmpeg", [
    "-rtsp_transport",
    "tcp",
    "-i",
    rtspUrl,
    "-an",
    "-vf",
    "fps=8,scale=720:-1",
    "-q:v",
    "6",
    "-f",
    "mjpeg",
    "pipe:1"
  ]);

  const session = { id, rtspUrl, ffmpeg, clients, startedAt: Date.now(), latestFrame: null };
  rtspSessions.set(id, session);

  ffmpeg.stdout.on("data", (chunk) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);

    while (true) {
      const start = frameBuffer.indexOf(Buffer.from([0xff, 0xd8]));
      const end = frameBuffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (start === -1 || end === -1) break;

      const frame = frameBuffer.subarray(start, end + 2);
      frameBuffer = frameBuffer.subarray(end + 2);
      latestFrame = frame;
      session.latestFrame = frame;

      for (const client of clients) {
        client.write(`--frame\r\ncontent-type: image/jpeg\r\ncontent-length: ${frame.length}\r\n\r\n`);
        client.write(frame);
        client.write("\r\n");
      }
    }
  });

  ffmpeg.stderr.on("data", (chunk) => {
    session.lastError = chunk.toString("utf8").slice(-1200);
  });

  ffmpeg.on("close", (code) => {
    session.closedAt = Date.now();
    session.exitCode = code;
    for (const client of clients) client.end();
    clients.clear();
  });

  return session;
}

async function handleRtspStart(req, res) {
  try {
    const { rtspUrl } = await readBody(req);
    const url = String(rtspUrl || "").trim();
    if (!url.startsWith("rtsp://")) {
      sendJson(res, 400, { error: "A valid rtsp:// URL is required" });
      return;
    }

    const session = startRtspSession(url);
    sendJson(res, 200, {
      id: session.id,
      mjpegUrl: `/api/rtsp/${session.id}/mjpeg`,
      snapshotUrl: `/api/rtsp/${session.id}/snapshot`
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

function stopRtspSession(id) {
  const session = rtspSessions.get(id);
  if (!session) return false;
  session.ffmpeg.kill("SIGTERM");
  rtspSessions.delete(id);
  for (const client of session.clients) client.end();
  session.clients.clear();
  return true;
}

function handleRtspMjpeg(id, req, res) {
  const session = rtspSessions.get(id);
  if (!session) {
    sendJson(res, 404, { error: "RTSP session not found" });
    return;
  }

  res.writeHead(200, {
    "content-type": "multipart/x-mixed-replace; boundary=frame",
    "cache-control": "no-cache, no-store, must-revalidate",
    connection: "close"
  });
  session.clients.add(res);
  req.on("close", () => session.clients.delete(res));
}

function handleRtspSnapshot(id, res) {
  const session = rtspSessions.get(id);
  if (!session?.latestFrame) {
    sendJson(res, 404, { error: "No frame is available yet" });
    return;
  }

  res.writeHead(200, {
    "content-type": "image/jpeg",
    "cache-control": "no-cache"
  });
  res.end(session.latestFrame);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/analyze") {
    await handleAnalyze(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/models") {
    await handleModels(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/version") {
    sendJson(res, 200, {
      name: "live-vlm-webui",
      version: appVersion,
      image: `quay.io/fcalomen/ntt-lvm:${appVersion}`,
      export: {
        enabled: exportConfig.enabled,
        provider: exportConfig.provider || null,
        configured: isExportConfigured(exportConfig)
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      version: appVersion,
      exportConfigured: isExportConfigured(exportConfig)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rtsp/start") {
    await handleRtspStart(req, res);
    return;
  }

  const rtspMatch = url.pathname.match(/^\/api\/rtsp\/([^/]+)\/(mjpeg|snapshot|stop)$/);
  if (rtspMatch) {
    const [, id, action] = rtspMatch;
    if (action === "mjpeg" && req.method === "GET") return handleRtspMjpeg(id, req, res);
    if (action === "snapshot" && req.method === "GET") return handleRtspSnapshot(id, res);
    if (action === "stop" && req.method === "POST") return sendJson(res, 200, { stopped: stopRtspSession(id) });
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
});

server.listen(port, host, () => {
  console.log(`NTT Live VLM ${appVersion} running at http://${host}:${port}`);
  logApp("analysis_export_config", {
    enabled: exportConfig.enabled,
    provider: exportConfig.provider || null,
    configured: isExportConfigured(exportConfig),
    prefix: exportConfig.prefix
  });
});

process.on("SIGINT", () => {
  for (const id of rtspSessions.keys()) stopRtspSession(id);
  process.exit(0);
});

function logApp(event, details, level = "log") {
  console[level](JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...details
  }));
}
