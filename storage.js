import { createHash, createHmac, randomUUID } from "node:crypto";

const trueValues = new Set(["1", "true", "yes", "on", "enabled"]);

export function getExportConfig(env = process.env) {
  return {
    enabled: trueValues.has(String(env.ANALYSIS_EXPORT_ENABLED || "").toLowerCase()),
    provider: String(env.ANALYSIS_EXPORT_PROVIDER || "").toLowerCase(),
    prefix: String(env.ANALYSIS_EXPORT_PREFIX || "analysis").replace(/^\/+|\/+$/g, ""),
    azureSasUrl: env.AZURE_BLOB_SAS_URL || "",
    s3Bucket: env.AWS_S3_BUCKET || "",
    s3Region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
    s3Endpoint: env.AWS_S3_ENDPOINT || "",
    s3AccessKeyId: env.AWS_ACCESS_KEY_ID || "",
    s3SecretAccessKey: env.AWS_SECRET_ACCESS_KEY || "",
    s3SessionToken: env.AWS_SESSION_TOKEN || ""
  };
}

export function isExportConfigured(config = getExportConfig()) {
  if (!config.enabled) return true;
  if (config.provider === "azure") return Boolean(config.azureSasUrl);
  if (config.provider === "s3") {
    return Boolean(config.s3Bucket && config.s3AccessKeyId && config.s3SecretAccessKey);
  }
  return false;
}

export function createAnalysisRecord({ request, response, appVersion }) {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    app: "ntt-live-vlm",
    version: appVersion,
    source: request.source || null,
    model: request.model,
    protocol: request.protocol,
    endpoint: response.endpoint,
    preset: request.preset || null,
    prompt: request.prompt,
    answer: response.answer,
    status: response.status,
    ok: response.ok,
    latencyMs: response.latencyMs,
    raw: response.raw
  };
}

export async function exportAnalysisRecord(record, config = getExportConfig()) {
  if (!config.enabled) return { enabled: false };
  if (!isExportConfigured(config)) {
    throw new Error(`Analysis export is enabled but ${config.provider || "provider"} is not configured`);
  }

  const objectKey = buildObjectKey(config.prefix, record);
  const body = `${JSON.stringify(record)}\n`;
  logExport("analysis_export_upload_start", {
    provider: config.provider,
    key: objectKey,
    bytes: Buffer.byteLength(body)
  });

  if (config.provider === "azure") {
    await uploadAzureBlob({ config, objectKey, body });
  } else if (config.provider === "s3") {
    await uploadS3Object({ config, objectKey, body });
  } else {
    throw new Error(`Unsupported ANALYSIS_EXPORT_PROVIDER: ${config.provider}`);
  }

  return {
    enabled: true,
    provider: config.provider,
    key: objectKey
  };
}

function buildObjectKey(prefix, record) {
  const day = record.timestamp.slice(0, 10);
  return `${prefix}/${day}/${record.timestamp.replace(/[:.]/g, "-")}-${record.id}.jsonl`;
}

async function uploadAzureBlob({ config, objectKey, body }) {
  const sasUrl = new URL(config.azureSasUrl);
  const basePath = sasUrl.pathname.replace(/\/+$/, "");
  sasUrl.pathname = `${basePath}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
  logExport("analysis_export_target", {
    provider: "azure",
    accountHost: sasUrl.host,
    containerPath: basePath || "/",
    key: objectKey
  });

  const response = await fetch(sasUrl, {
    method: "PUT",
    headers: {
      "content-type": "application/x-ndjson",
      "x-ms-blob-type": "BlockBlob"
    },
    body
  });

  if (!response.ok) {
    throw new Error(`Azure Blob upload failed with ${response.status}: ${await response.text()}`);
  }
}

async function uploadS3Object({ config, objectKey, body }) {
  const payloadHash = sha256Hex(body);
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const host = s3Host(config);
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  const url = s3Url(config, encodedKey);
  logExport("analysis_export_target", {
    provider: "s3",
    bucket: config.s3Bucket,
    region: config.s3Region,
    endpointHost: host,
    key: objectKey
  });
  const headers = {
    host,
    "content-type": "application/x-ndjson",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  };
  if (config.s3SessionToken) headers["x-amz-security-token"] = config.s3SessionToken;

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key]}\n`)
    .join("");
  const canonicalUri = new URL(url).pathname;
  const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${config.s3Region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const signature = hmacHex(signingKey(config.s3SecretAccessKey, dateStamp, config.s3Region), stringToSign);

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.s3AccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    },
    body
  });

  if (!response.ok) {
    throw new Error(`S3 upload failed with ${response.status}: ${await response.text()}`);
  }
}

function s3Host(config) {
  if (config.s3Endpoint) return new URL(config.s3Endpoint).host;
  return `${config.s3Bucket}.s3.${config.s3Region}.amazonaws.com`;
}

function s3Url(config, encodedKey) {
  if (config.s3Endpoint) {
    const endpoint = new URL(config.s3Endpoint);
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${config.s3Bucket}/${encodedKey}`;
    return endpoint.toString();
  }
  return `https://${s3Host(config)}/${encodedKey}`;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key, value) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function signingKey(secret, dateStamp, region) {
  const dateKey = hmac(`AWS4${secret}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function logExport(event, details) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...details
  }));
}
