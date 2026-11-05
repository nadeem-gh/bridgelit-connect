// HTTPS calls to the BridgeLit server. The computer only ever calls out;
// nothing listens on a port here.
import { VERSION } from "./config.js";

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `Server error ${status}`);
    this.status = status;
  }
}

export class Api {
  /** @param {string} server @param {string | null} token */
  constructor(server, token = null, fetchImpl = globalThis.fetch) {
    this.server = server;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async post(path, body = {}, { timeoutMs = 30_000 } = {}) {
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": `bridgelit-connect/${VERSION} (${process.platform}; node ${process.versions.node})`,
    };
    if (this.token) headers.Authorization = `Bridge ${this.token}`;
    const response = await this.fetch(`${this.server}/api/bridge/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 204) return { status: 204, data: {} };
    const data = await response.json().catch(() => ({}));
    if (response.status >= 400 && response.status !== 410) {
      throw new ApiError(response.status, data?.detail);
    }
    return { status: response.status, data };
  }

  startPairing(info) {
    return this.post("device/pair/", info);
  }

  /** @param {string} deviceCode @param {object} [info] who this computer is (used for a portal-started login) */
  pollPairing(deviceCode, info = {}) {
    return this.post("device/pair/poll/", { ...info, device_code: deviceCode });
  }

  hello(info) {
    return this.post("device/hello/", info);
  }

  nextJob() {
    return this.post("device/jobs/next/");
  }

  progress(jobId, partial) {
    return this.post(`device/jobs/${jobId}/progress/`, { partial });
  }

  result(jobId, body) {
    return this.post(`device/jobs/${jobId}/result/`, body, { timeoutMs: 60_000 });
  }

  logout() {
    return this.post("device/logout/");
  }
}
