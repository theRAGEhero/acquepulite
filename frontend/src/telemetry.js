const REPORT_ENDPOINT = "/api/client-errors";
const recentReports = new Map();
const REPORT_DEDUPE_MS = 30_000;

function endpointPath(input) {
  try {
    return new URL(typeof input === "string" ? input : input.url, window.location.origin).pathname;
  } catch {
    return String(input || "").split("?")[0].slice(0, 500);
  }
}

function errorDetails(error) {
  if (error instanceof Error) {
    return { message: error.message || error.name, stack: error.stack || "" };
  }
  if (typeof error === "string") return { message: error, stack: "" };
  try { return { message: JSON.stringify(error), stack: "" }; }
  catch { return { message: String(error), stack: "" }; }
}

export class ApiError extends Error {
  constructor(message, { status = 0, requestId = null, endpoint = "", payload = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.requestId = requestId;
    this.endpoint = endpoint;
    this.payload = payload;
  }
}

export function reportClientError(error, context = {}) {
  if (error?.name === "AbortError") return;
  const details = errorDetails(error);
  const payload = {
    severity: context.severity === "warning" ? "warning" : "error",
    kind: context.kind || "runtime",
    message: details.message.slice(0, 2000),
    stack: details.stack.slice(0, 12000),
    component_stack: String(context.component_stack || "").slice(0, 8000),
    page: typeof window !== "undefined" ? window.location.pathname : "",
    endpoint: context.endpoint || "",
    http_status: context.http_status || null,
    api_request_id: context.api_request_id || null,
    duration_ms: context.duration_ms == null ? null : Math.round(context.duration_ms),
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    viewport: typeof window === "undefined" ? null : { width: window.innerWidth, height: window.innerHeight }
  };
  const signature = `${payload.kind}|${payload.message}|${payload.endpoint}|${payload.http_status}`;
  const now = Date.now();
  if (now - (recentReports.get(signature) || 0) < REPORT_DEDUPE_MS) return;
  recentReports.set(signature, now);
  if (recentReports.size > 100) {
    for (const [key, time] of recentReports) if (now - time > REPORT_DEDUPE_MS) recentReports.delete(key);
  }
  fetch(REPORT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true
  }).catch(() => { /* Telemetry must never create another application error. */ });
}

export async function apiFetch(input, options = {}) {
  const startedAt = performance.now();
  const endpoint = endpointPath(input);
  try {
    const response = await fetch(input, options);
    const duration = performance.now() - startedAt;
    if (!response.ok) {
      reportClientError(new ApiError(`API request returned ${response.status}`, {
        status: response.status,
        requestId: response.headers.get("x-request-id"),
        endpoint
      }), {
        kind: "api-response",
        severity: response.status >= 500 ? "error" : "warning",
        endpoint,
        http_status: response.status,
        api_request_id: response.headers.get("x-request-id"),
        duration_ms: duration
      });
    }
    return response;
  } catch (error) {
    if (error?.name !== "AbortError") {
      reportClientError(error, {
        kind: "api-network",
        endpoint,
        duration_ms: performance.now() - startedAt
      });
    }
    throw error;
  }
}

export async function fetchJson(input, options = {}) {
  const endpoint = endpointPath(input);
  const response = await apiFetch(input, options);
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    reportClientError(error, {
      kind: "api-invalid-json",
      endpoint,
      http_status: response.status,
      api_request_id: response.headers.get("x-request-id")
    });
    throw new ApiError("API returned an invalid response", {
      status: response.status,
      requestId: response.headers.get("x-request-id"),
      endpoint
    });
  }
  if (!response.ok) {
    throw new ApiError(payload?.detail || payload?.error || `API request returned ${response.status}`, {
      status: response.status,
      requestId: response.headers.get("x-request-id"),
      endpoint,
      payload
    });
  }
  return payload;
}

export function installGlobalErrorHandlers() {
  const handleError = event => reportClientError(event.error || event.message, {
    kind: "window-error",
    endpoint: event.filename ? endpointPath(event.filename) : ""
  });
  const handleRejection = event => reportClientError(event.reason, { kind: "unhandled-rejection" });
  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleRejection);
  return () => {
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleRejection);
  };
}
