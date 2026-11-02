const PAIR_TTL_MS = 15 * 60 * 1000;
const COMPLETED_PAIR_TTL_MS = 24 * 60 * 60 * 1000;
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const PAIR_RATE_WINDOW_MS = 10 * 60 * 1000;
const CLIENT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_PAIR_STARTS = 6;
const MAX_SETUP_CHECKS = 30;
const MAX_PAIRINGS = 5_000;
const MAX_RATE_KEYS = 5_000;
const MAX_EVENTS = 500;
const MAX_DELIVERIES = 5_000;
const MAX_CLIENTS = 32;
const MAX_LINKED_PRS = 20;
const MAX_EVENTS_PER_RESPONSE = 100;
const MAX_WEBHOOK_BYTES = 512 * 1024;
const MAX_JSON_BYTES = 8 * 1024;
const INTERNAL_ORIGIN = "https://relay.internal";

export interface RelayEvent {
  deliveryId: string;
  event: "check_run.completed" | "workflow_run.completed" | "pull_request.closed" | "pull_request.synchronize";
  repository: string;
  prNumber: number;
  headSha: string;
  runId?: number;
  attempt?: number;
  conclusion?: string;
  occurredAt: string;
}

export interface StoredEvent {
  seq: number;
  expiresAt: number;
  metadata: RelayEvent;
}

export interface ClientState {
  cursor: number;
  ackedDeliveryIds: string[];
  expiresAt: number;
}

export interface InstallationState {
  nextSeq: number;
  events: StoredEvent[];
  deliveries: Record<string, number>;
  clients: Record<string, ClientState>;
  revoked: boolean;
}

interface Pairing {
  expiresAt: number;
  installationId?: number;
  completed?: { installationId: number; tokenHash: string };
}

export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request | string, init?: RequestInit): Promise<Response> };
}

export interface Env {
  RELAY: DurableObjectNamespaceLike;
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_PRIVATE_KEY: string;
  WEBHOOK_SECRET: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d{1,20}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isState(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isDeliveryId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[A-Fa-f0-9-]{1,128}$/.test(value);
}

function isRepository(value: unknown): value is string {
  return typeof value === "string" && value.length <= 205 && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-fA-F0-9]{40,64}$/.test(value);
}

function isoDate(value: unknown, fallback: number): string {
  if (typeof value === "string" && value.length <= 40) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallback).toISOString();
}

function allowedEventName(value: unknown): value is RelayEvent["event"] {
  return value === "check_run.completed" || value === "workflow_run.completed" || value === "pull_request.closed" || value === "pull_request.synchronize";
}

function sanitizeEvent(value: unknown): RelayEvent | undefined {
  if (!isRecord(value) || !isDeliveryId(value.deliveryId) || !allowedEventName(value.event) ||
      !isRepository(value.repository) || !positiveInteger(value.prNumber) || !isSha(value.headSha) ||
      typeof value.occurredAt !== "string" || value.occurredAt.length > 40 || !Number.isFinite(Date.parse(value.occurredAt))) return undefined;

  const result: RelayEvent = {
    deliveryId: value.deliveryId,
    event: value.event,
    repository: value.repository,
    prNumber: value.prNumber as number,
    headSha: value.headSha.toLowerCase(),
    occurredAt: new Date(Date.parse(value.occurredAt)).toISOString(),
  };
  const runId = positiveInteger(value.runId);
  const attempt = positiveInteger(value.attempt);
  if (runId !== undefined) result.runId = runId;
  if (attempt !== undefined) result.attempt = attempt;
  if (typeof value.conclusion === "string" && value.conclusion.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value.conclusion)) result.conclusion = value.conclusion;
  return result;
}

export function emptyInstallationState(): InstallationState {
  return { nextSeq: 0, events: [], deliveries: {}, clients: {}, revoked: false };
}

export function pruneInstallationState(state: InstallationState, now: number): InstallationState {
  const kept = state.events.filter(event => event.expiresAt > now);
  const discardedThrough = state.events.filter(event => event.expiresAt <= now).reduce((max, event) => Math.max(max, event.seq), 0);
  state.events = kept;
  if (discardedThrough > 0) {
    for (const client of Object.values(state.clients)) client.cursor = Math.max(client.cursor, discardedThrough);
  }
  for (const [id, expiresAt] of Object.entries(state.deliveries)) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) delete state.deliveries[id];
  }
  const visibleDeliveryIds = new Set(state.events.map(event => event.metadata.deliveryId));
  for (const client of Object.values(state.clients)) {
    client.ackedDeliveryIds = client.ackedDeliveryIds.filter(id => visibleDeliveryIds.has(id));
  }
  return state;

}
export function appendWebhookEvents(state: InstallationState, deliveryId: string, values: unknown[], now: number): number {
  pruneInstallationState(state, now);
  if (!isDeliveryId(deliveryId) || state.deliveries[deliveryId] !== undefined) return 0;

  const sanitized: RelayEvent[] = [];
  const unique = new Set<string>();
  for (const value of values.slice(0, MAX_LINKED_PRS)) {
    const event = sanitizeEvent(value);
    if (!event || event.deliveryId !== deliveryId) continue;
    const key = `${event.event}\u0000${event.repository}\u0000${event.prNumber}`;
    if (unique.has(key)) continue;
    unique.add(key);
    sanitized.push(event);
  }
  if (sanitized.length === 0) return 0;

  state.deliveries[deliveryId] = now + EVENT_TTL_MS;
  for (const metadata of sanitized) {
    state.nextSeq += 1;
    state.events.push({ seq: state.nextSeq, expiresAt: now + EVENT_TTL_MS, metadata });
  }
  if (state.events.length > MAX_EVENTS) {
    const removed = state.events.splice(0, state.events.length - MAX_EVENTS);
    const discardedThrough = removed.reduce((max, event) => Math.max(max, event.seq), 0);
    for (const client of Object.values(state.clients)) client.cursor = Math.max(client.cursor, discardedThrough);
  }
  const deliveryEntries = Object.entries(state.deliveries);
  if (deliveryEntries.length > MAX_DELIVERIES) {
    deliveryEntries.sort((a, b) => a[1] - b[1]);
    for (const [id] of deliveryEntries.slice(0, deliveryEntries.length - MAX_DELIVERIES)) delete state.deliveries[id];
  }
  pruneInstallationState(state, now);
  return sanitized.length;
}

/** Verifies a GitHub X-Hub-Signature-256 header against the untouched request body. */
export async function verifyWebhookSignature(body: Uint8Array, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature) || !secret) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
    const suppliedHex = signature.slice(7);
    const supplied = new Uint8Array(32);
    for (let i = 0; i < supplied.length; i += 1) supplied[i] = Number.parseInt(suppliedHex.slice(i * 2, i * 2 + 2), 16);
    return constantTimeEqual(expected, supplied);
  } catch {
    return false;
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

/** Extracts only allow-listed metadata; webhook payloads and CI logs are never persisted. */
export function extractEvents(payload: unknown, eventName: string, deliveryId: string, now = Date.now()): RelayEvent[] {
  if (!isRecord(payload) || !isDeliveryId(deliveryId)) return [];
  const repository = isRecord(payload.repository) && isRepository(payload.repository.full_name) ? payload.repository.full_name : undefined;
  if (!repository) return [];

  let event: RelayEvent["event"];
  let details: Record<string, unknown>;
  let linkedPullRequests: unknown[];
  if (eventName === "check_run" && payload.action === "completed" && isRecord(payload.check_run)) {
    event = "check_run.completed";
    details = payload.check_run;
    linkedPullRequests = Array.isArray(details.pull_requests) ? details.pull_requests : [];
  } else if (eventName === "workflow_run" && payload.action === "completed" && isRecord(payload.workflow_run)) {
    event = "workflow_run.completed";
    details = payload.workflow_run;
    linkedPullRequests = Array.isArray(details.pull_requests) ? details.pull_requests : [];
  } else if (eventName === "pull_request" && (payload.action === "closed" || payload.action === "synchronize") && isRecord(payload.pull_request)) {
    event = payload.action === "closed" ? "pull_request.closed" : "pull_request.synchronize";
    details = payload.pull_request;
    linkedPullRequests = [details];
  } else {
    return [];
  }

  const head = event.startsWith("pull_request.") && isRecord(details.head) ? details.head.sha : details.head_sha;
  if (!isSha(head)) return [];
  const occurred = event === "check_run.completed" ? details.completed_at
    : event === "workflow_run.completed" ? details.completed_at ?? details.updated_at
      : details.updated_at;
  const result: RelayEvent[] = [];
  const seenNumbers = new Set<number>();
  for (const linked of linkedPullRequests.slice(0, MAX_LINKED_PRS)) {
    if (!isRecord(linked)) continue;
    const number = positiveInteger(linked.number);
    if (number === undefined || seenNumbers.has(number)) continue;
    seenNumbers.add(number);
    const metadata: RelayEvent = {
      deliveryId,
      event,
      repository,
      prNumber: number,
      headSha: head.toLowerCase(),
      occurredAt: isoDate(occurred, now),
    };
    const runId = positiveInteger(details.id) ?? positiveInteger(details.run_id);
    const attempt = positiveInteger(details.run_attempt);
    if (runId !== undefined) metadata.runId = runId;
    if (attempt !== undefined) metadata.attempt = attempt;
    if (typeof details.conclusion === "string" && details.conclusion.length <= 64 && /^[A-Za-z0-9_-]+$/.test(details.conclusion)) metadata.conclusion = details.conclusion;
    result.push(metadata);
  }
  return result;
}

function jsonResponse(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(status: number, error: string, extraHeaders?: HeadersInit): Response {
  return jsonResponse(status, { error }, extraHeaders);
}

async function readBytesBounded(request: Request, limit: number): Promise<Uint8Array | Response> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) return errorResponse(413, "body_too_large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return errorResponse(413, "body_too_large");
      }
      chunks.push(value);
    }
  } catch {
    return errorResponse(400, "invalid_body");
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readJsonBounded(request: Request, limit = MAX_JSON_BYTES): Promise<{ value?: unknown; error?: Response }> {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return { error: errorResponse(415, "content_type_must_be_application_json") };
  const body = await readBytesBounded(request, limit);
  if (body instanceof Response) return { error: body };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { error: errorResponse(400, "invalid_json") };
  }
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(request.url).origin) return false;
    } catch {
      return false;
    }
  }
  return request.headers.get("sec-fetch-site")?.toLowerCase() !== "cross-site";
}

function tokenFromRequest(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/);
  return match?.[1];
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

function setupHtml(status: number, message: string): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GitHub relay setup</title></head><body><main><h1>GitHub relay</h1><p>${message}</p></main></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

function internalRequest(path: string, body: unknown): Request {
  return new Request(`${INTERNAL_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function objectId(env: Env, name: string) {
  return env.RELAY.get(env.RELAY.idFromName(name));
}

async function callInternal(env: Env, name: string, path: string, body: unknown): Promise<Response> {
  return objectId(env, name).fetch(internalRequest(path, body));
}

async function internalJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function validAppConfig(env: Env): boolean {
  return typeof env.GITHUB_APP_ID === "string" && /^\d{1,20}$/.test(env.GITHUB_APP_ID) &&
    typeof env.GITHUB_APP_PRIVATE_KEY === "string" && env.GITHUB_APP_PRIVATE_KEY.length > 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function privateKeyDer(pem: string): Uint8Array {
  const match = pem.match(/-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----([\s\S]*?)-----END \1-----/);
  if (!match) throw new Error("Invalid private key PEM");
  const binary = atob(match[2].replace(/\s/g, ""));
  const key = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (match[1] === "PRIVATE KEY") return key;
  // GitHub App keys are commonly PKCS#1 PEM; wrap in the PKCS#8 RSA PrivateKeyInfo envelope.
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const privateOctet = [0x04, ...derLength(key.length), ...key];
  const sequenceBody = [0x02, 0x01, 0x00, ...algorithm, ...privateOctet];
  return Uint8Array.from([0x30, ...derLength(sequenceBody.length), ...sequenceBody]);
}

export async function createAppJwt(env: Env, now = Date.now()): Promise<string> {
  if (!validAppConfig(env)) throw new Error("GitHub App credentials are not configured");
  const issuedAt = Math.floor(now / 1000) - 30;
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ iat: issuedAt, exp: Math.floor(now / 1000) + 8 * 60, iss: env.GITHUB_APP_ID })));
  const content = `${header}.${payload}`;
  const key = await crypto.subtle.importKey("pkcs8", privateKeyDer(env.GITHUB_APP_PRIVATE_KEY), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(content));
  return `${content}.${base64Url(new Uint8Array(signature))}`;
}

export type InstallationCheck = { ok: true } | { ok: false; status: number; error: string };

export async function verifyAppInstallation(env: Env, installationId: number, fetcher: typeof fetch = fetch): Promise<InstallationCheck> {
  if (!validAppConfig(env)) return { ok: false, status: 503, error: "github_app_not_configured" };
  let jwt: string;
  try {
    jwt = await createAppJwt(env);
  } catch {
    return { ok: false, status: 503, error: "github_app_credentials_invalid" };
  }
  try {
    const response = await fetcher(`https://api.github.com/app/installations/${installationId}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "github-relay-worker",
      },
      signal: AbortSignal.timeout(5_000),
    });
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (response.status === 429 || (response.status === 403 && (remaining === "0" || response.headers.has("retry-after")))) return { ok: false, status: 503, error: "github_api_rate_limited" };
    if (response.status === 200) {
      const value: unknown = await response.json().catch(() => null);
      return isRecord(value) && positiveInteger(value.id) === installationId
        ? { ok: true }
        : { ok: false, status: 403, error: "installation_not_authorized" };
    }
    if (response.status >= 500) return { ok: false, status: 503, error: "github_api_unavailable" };
    return { ok: false, status: 403, error: "installation_not_authorized" };
  } catch (error) {
    return { ok: false, status: 503, error: error instanceof Error && error.name === "TimeoutError" ? "github_api_timeout" : "github_api_unavailable" };
  }
}

const installationCheckCache = new Map<string, number>();
async function checkInstallationCached(env: Env, installationId: number): Promise<InstallationCheck> {
  const key = `${env.GITHUB_APP_ID}:${installationId}`;
  const now = Date.now();
  if ((installationCheckCache.get(key) ?? 0) > now) return { ok: true };
  const check = await verifyAppInstallation(env, installationId);
  if (check.ok) {
    installationCheckCache.set(key, now + 60_000);
    if (installationCheckCache.size > 2_000) {
      for (const [cacheKey, expiresAt] of installationCheckCache) {
        if (expiresAt <= now || installationCheckCache.size > 2_000) installationCheckCache.delete(cacheKey);
      }
    }
  }
  return check;
}

async function handlePairStart(request: Request, env: Env): Promise<Response> {
  if (!isSameOriginRequest(request)) return errorResponse(403, "cross_origin_request_rejected");
  const parsed = await readJsonBounded(request);
  if (parsed.error) return parsed.error;
  if (!isRecord(parsed.value) || !isState(parsed.value.state)) return errorResponse(400, "state_must_be_cryptographically_random_url_safe_text");
  if (!/^[A-Za-z0-9-]{1,100}$/.test(env.GITHUB_APP_SLUG ?? "")) return errorResponse(503, "github_app_slug_not_configured");
  const stateHash = await sha256Hex(parsed.value.state);
  const ip = request.headers.get("cf-connecting-ip")?.slice(0, 128) ?? "unknown";
  const response = await callInternal(env, "coordinator", "/coordinator/start", { stateHash, ipHash: await sha256Hex(ip) });
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    return jsonResponse(response.status, await internalJson(response), retryAfter ? { "retry-after": retryAfter } : undefined);
  }
  const installationUrl = new URL(`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`);
  installationUrl.searchParams.set("state", parsed.value.state);
  return jsonResponse(200, { installationUrl: installationUrl.toString() });
}

async function handleSetupCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const installationId = positiveInteger(url.searchParams.get("installation_id"));
  const state = url.searchParams.get("state");
  if (url.searchParams.get("setup_action") !== "install" || installationId === undefined || !isState(state)) {
    return setupHtml(400, "The GitHub installation callback was invalid. Return to the desktop app and try again.");
  }
  const stateHash = await sha256Hex(state);
  const ip = request.headers.get("cf-connecting-ip")?.slice(0, 128) ?? "unknown";
  const checked = await callInternal(env, "coordinator", "/coordinator/check", { stateHash, ipHash: await sha256Hex(ip) });
  if (!checked.ok) {
    const status = checked.status;
    return setupHtml(status, status === 429 ? "Too many setup attempts. Wait a few minutes and try again." : "This setup link is invalid or has expired. Return to the desktop app and start pairing again.");
  }
  const authorized = await checkInstallationCached(env, installationId);
  if (!authorized.ok) {
    const message = authorized.status === 503 ? "GitHub could not validate this installation right now. Retry the setup callback shortly." : "This GitHub App installation could not be validated.";
    return setupHtml(authorized.status, message);
  }
  const bound = await callInternal(env, "coordinator", "/coordinator/bind", { stateHash, installationId });
  if (!bound.ok) {
    const status = bound.status;
    return setupHtml(status, status === 409 ? "This pairing state is already bound to a different installation." : "This setup link is invalid or has expired. Return to the desktop app and start pairing again.");
  }
  return setupHtml(200, "GitHub is connected. You can return to the desktop app.");
}

async function handlePairComplete(request: Request, env: Env): Promise<Response> {
  const token = tokenFromRequest(request);
  if (!token) return errorResponse(401, "bearer_token_required");
  const parsed = await readJsonBounded(request);
  if (parsed.error) return parsed.error;
  if (!isRecord(parsed.value) || !isState(parsed.value.state)) return errorResponse(400, "invalid_state");
  const response = await callInternal(env, "coordinator", "/coordinator/complete", {
    stateHash: await sha256Hex(parsed.value.state),
    tokenHash: await sha256Hex(token),
  });
  return jsonResponse(response.status, await internalJson(response));
}

function parseInstallationRoute(pathname: string): { id: number; endpoint: "unpair" | "events" | "ack" } | undefined {
  const match = pathname.match(/^\/v1\/installations\/(\d+)\/(unpair|events|events\/ack)$/);
  if (!match) return undefined;
  const id = positiveInteger(match[1]);
  if (id === undefined) return undefined;
  return { id, endpoint: match[2] === "unpair" ? "unpair" : match[2] === "events" ? "events" : "ack" };
}

async function handleClientRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const route = parseInstallationRoute(url.pathname);
  if (!route) return errorResponse(404, "not_found");
  if ((route.endpoint === "events" && request.method !== "GET") || (route.endpoint !== "events" && request.method !== "POST")) {
    return errorResponse(405, "method_not_allowed", { allow: route.endpoint === "events" ? "GET" : "POST" });
  }
  const token = tokenFromRequest(request);
  if (!token) return errorResponse(401, "bearer_token_required");
  const clientHash = await sha256Hex(token);
  let body: Record<string, unknown> = {};
  if (route.endpoint !== "events") {
    const parsed = await readJsonBounded(request);
    if (parsed.error) return parsed.error;
    if (!isRecord(parsed.value)) return errorResponse(400, "invalid_json_object");
    body = parsed.value;
  }
  if (route.endpoint === "ack" && (!Array.isArray(body.deliveryIds) || body.deliveryIds.length > 100 || body.deliveryIds.some(id => !isDeliveryId(id)))) {
    return errorResponse(400, "delivery_ids_must_be_an_array_of_at_most_100_ids");
  }
  const path = route.endpoint === "unpair" ? "/installation/client/unpair" : route.endpoint === "ack" ? "/installation/client/ack" : "/installation/client/events";
  const forwarded = route.endpoint === "events"
    ? { clientHash, cursor: url.searchParams.get("cursor") }
    : route.endpoint === "ack" ? { clientHash, deliveryIds: body.deliveryIds }
      : { clientHash };
  const response = await objectId(env, `installation:${route.id}`).fetch(internalRequest(path, forwarded));
  return jsonResponse(response.status, await internalJson(response));
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return errorResponse(415, "content_type_must_be_application_json");
  const eventName = request.headers.get("x-github-event");
  if (eventName !== "check_run" && eventName !== "workflow_run" && eventName !== "pull_request" && eventName !== "installation") return errorResponse(400, "unsupported_github_event");
  const deliveryId = request.headers.get("x-github-delivery");
  if (!isDeliveryId(deliveryId)) return errorResponse(400, "invalid_github_delivery_id");
  if (typeof env.WEBHOOK_SECRET !== "string" || env.WEBHOOK_SECRET.length === 0) return errorResponse(503, "webhook_secret_not_configured");
  const bytes = await readBytesBounded(request, MAX_WEBHOOK_BYTES);
  if (bytes instanceof Response) return bytes;
  if (!(await verifyWebhookSignature(bytes, request.headers.get("x-hub-signature-256"), env.WEBHOOK_SECRET ?? ""))) return errorResponse(401, "invalid_webhook_signature");
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return errorResponse(400, "invalid_json");
  }
  if (!isRecord(payload) || !isRecord(payload.installation)) return errorResponse(400, "installation_missing");
  const installationId = positiveInteger(payload.installation.id);
  if (installationId === undefined) return errorResponse(400, "invalid_installation_id");
  if (eventName === "installation") {
    if (payload.action !== "deleted") return jsonResponse(202, { accepted: true, stored: 0 });
    const response = await objectId(env, `installation:${installationId}`).fetch(internalRequest("/installation/revoke", { deliveryId }));
    if (!response.ok) return errorResponse(503, "relay_revocation_unavailable");
    return jsonResponse(202, { accepted: true, revoked: true });
  }
  const authorized = await checkInstallationCached(env, installationId);
  if (!authorized.ok) return errorResponse(authorized.status, authorized.error);

  const events = extractEvents(payload, eventName, deliveryId);
  if (events.length === 0) return jsonResponse(202, { accepted: true, stored: 0 });
  const response = await objectId(env, `installation:${installationId}`).fetch(internalRequest("/installation/webhook/events", { deliveryId, events }));
  if (!response.ok) return errorResponse(503, "relay_storage_unavailable");
  const result = await internalJson(response);
  return jsonResponse(202, { accepted: true, stored: typeof result.stored === "number" ? result.stored : 0 });
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/v1/pair/start") return request.method === "POST" ? handlePairStart(request, env) : errorResponse(405, "method_not_allowed", { allow: "POST" });
      if (url.pathname === "/v1/github/setup") return request.method === "GET" ? handleSetupCallback(request, env) : errorResponse(405, "method_not_allowed", { allow: "GET" });
      if (url.pathname === "/v1/pair/complete") return request.method === "POST" ? handlePairComplete(request, env) : errorResponse(405, "method_not_allowed", { allow: "POST" });
      if (url.pathname === "/v1/webhooks/github") return request.method === "POST" ? handleWebhook(request, env) : errorResponse(405, "method_not_allowed", { allow: "POST" });
      if (url.pathname.startsWith("/v1/installations/")) return handleClientRoute(request, url, env);
      return errorResponse(404, "not_found");
    } catch {
      return errorResponse(500, "internal_error");
    }
  },
};

export default worker;

export class RelayDurableObject {
  private readonly state: DurableObjectStateLike;
  private readonly env: Env;
  private serial: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectStateLike, env: Env) {
    this.state = state;
    this.env = env;
  }

  fetch(request: Request): Promise<Response> {
    const pending = this.serial.then(() => this.dispatch(request));
    this.serial = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/coordinator/")) return this.handleCoordinator(url.pathname, request);
    if (url.pathname.startsWith("/installation/")) return this.handleInstallation(url.pathname, request);
    return errorResponse(404, "not_found");
  }

  private async internalBody(request: Request): Promise<Record<string, unknown> | undefined> {
    try {
      const value: unknown = await request.json();
      return isRecord(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async handleCoordinator(path: string, request: Request): Promise<Response> {
    if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
    const body = await this.internalBody(request);
    if (!body) return errorResponse(400, "invalid_internal_request");
    if (path === "/coordinator/start") return this.startPairing(body);
    if (path === "/coordinator/check") return this.checkPairing(body);
    if (path === "/coordinator/bind") return this.bindPairing(body);
    if (path === "/coordinator/complete") return this.completePairing(body);
    return errorResponse(404, "not_found");
  }

  private async cleanPairIndex(): Promise<string[]> {
    const current = await this.state.storage.get<string[]>("pair-index") ?? [];
    const kept: string[] = [];
    const now = Date.now();
    for (const hash of current.slice(-MAX_PAIRINGS)) {
      const pairing = await this.state.storage.get<Pairing>(`pair:${hash}`);
      if (pairing && pairing.expiresAt > now) kept.push(hash);
      else await this.state.storage.delete(`pair:${hash}`);
    }
    await this.state.storage.put("pair-index", kept);
    return kept;
  }

  private async takeRate(kind: string, ipHash: string, limit: number): Promise<boolean> {
    if (!isHash(ipHash)) return false;
    const key = `rate:${kind}:${ipHash}`;
    const now = Date.now();
    const previous = await this.state.storage.get<number[]>(key) ?? [];
    const live = previous.filter(timestamp => Number.isFinite(timestamp) && timestamp > now - PAIR_RATE_WINDOW_MS);
    if (live.length >= limit) {
      await this.state.storage.put(key, live);
      return false;
    }
    live.push(now);
    await this.state.storage.put(key, live);
    let index = await this.state.storage.get<string[]>("rate-index") ?? [];
    if (!index.includes(key)) {
      index.push(key);
      if (index.length > MAX_RATE_KEYS) {
        const removed = index.splice(0, index.length - MAX_RATE_KEYS);
        for (const oldKey of removed) await this.state.storage.delete(oldKey);
      }
      await this.state.storage.put("rate-index", index);
    }
    return true;
  }

  private async startPairing(body: Record<string, unknown>): Promise<Response> {
    if (!isHash(body.stateHash) || !isHash(body.ipHash)) return errorResponse(400, "invalid_pairing_request");
    if (!(await this.takeRate("start", body.ipHash, MAX_PAIR_STARTS))) return errorResponse(429, "pair_start_rate_limited", { "retry-after": "600" });
    const pairingKey = `pair:${body.stateHash}`;
    const existing = await this.state.storage.get<Pairing>(pairingKey);
    if (existing && existing.expiresAt > Date.now()) return jsonResponse(200, { ok: true });
    const index = await this.cleanPairIndex();
    if (index.length >= MAX_PAIRINGS) return errorResponse(503, "pairing_capacity_reached");
    const now = Date.now();
    await this.state.storage.put(pairingKey, { expiresAt: now + PAIR_TTL_MS } satisfies Pairing);
    if (!index.includes(body.stateHash)) index.push(body.stateHash);
    await this.state.storage.put("pair-index", index);
    return jsonResponse(200, { ok: true });
  }

  private async checkPairing(body: Record<string, unknown>): Promise<Response> {
    if (!isHash(body.stateHash) || !isHash(body.ipHash)) return errorResponse(400, "invalid_pairing_request");
    if (!(await this.takeRate("setup", body.ipHash, MAX_SETUP_CHECKS))) return errorResponse(429, "setup_rate_limited", { "retry-after": "600" });
    const pairing = await this.state.storage.get<Pairing>(`pair:${body.stateHash}`);
    if (!pairing || pairing.expiresAt <= Date.now()) return errorResponse(404, "pairing_state_expired");
    return jsonResponse(200, { ok: true });
  }

  private async bindPairing(body: Record<string, unknown>): Promise<Response> {
    const installationId = positiveInteger(body.installationId);
    if (!isHash(body.stateHash) || installationId === undefined) return errorResponse(400, "invalid_pairing_request");
    const key = `pair:${body.stateHash}`;
    const pairing = await this.state.storage.get<Pairing>(key);
    if (!pairing || pairing.expiresAt <= Date.now()) return errorResponse(404, "pairing_state_expired");
    if (pairing.installationId !== undefined && pairing.installationId !== installationId) return errorResponse(409, "pairing_already_bound");
    pairing.installationId = installationId;
    if (!pairing.completed) pairing.expiresAt = Date.now() + PAIR_TTL_MS;
    await this.state.storage.put(key, pairing);
    return jsonResponse(200, { ok: true });
  }

  private async completePairing(body: Record<string, unknown>): Promise<Response> {
    if (!isHash(body.stateHash) || !isHash(body.tokenHash)) return errorResponse(400, "invalid_pairing_request");
    const key = `pair:${body.stateHash}`;
    const pairing = await this.state.storage.get<Pairing>(key);
    if (!pairing || pairing.expiresAt <= Date.now()) return errorResponse(404, "pairing_state_expired");
    if (pairing.completed) {
      if (pairing.completed.tokenHash !== body.tokenHash) return errorResponse(409, "pairing_already_completed");
      return jsonResponse(200, { installationId: pairing.completed.installationId });
    }
    if (pairing.installationId === undefined) return jsonResponse(202, { pending: true });
    const response = await objectId(this.env, `installation:${pairing.installationId}`).fetch(internalRequest("/installation/client/register", { clientHash: body.tokenHash }));
    const result = await internalJson(response);
    if (!response.ok) return jsonResponse(response.status, result);
    pairing.completed = { installationId: pairing.installationId, tokenHash: body.tokenHash };
    pairing.expiresAt = Date.now() + COMPLETED_PAIR_TTL_MS;
    await this.state.storage.put(key, pairing);
    return jsonResponse(200, { installationId: pairing.installationId });
  }

  private async loadInstallationState(): Promise<InstallationState> {
    const stored = await this.state.storage.get<InstallationState>("installation-state");
    if (!stored || !Number.isSafeInteger(stored.nextSeq) || !Array.isArray(stored.events) || !isRecord(stored.deliveries) || !isRecord(stored.clients)) return emptyInstallationState();
    stored.revoked = stored.revoked === true;
    return pruneInstallationState(stored, Date.now());
  }

  private async handleInstallation(path: string, request: Request): Promise<Response> {
    if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
    const body = await this.internalBody(request);
    if (!body) return errorResponse(400, "invalid_internal_request");
    if (path === "/installation/client/register") return this.registerClient(body);
    if (path === "/installation/revoke") return this.revokeInstallation();
    if (path === "/installation/webhook/events") return this.storeEvents(body);
    if (path === "/installation/client/unpair") return this.unpairClient(body);
    if (path === "/installation/client/events") return this.readClientEvents(body);
    if (path === "/installation/client/ack") return this.ackClientEvents(body);
    return errorResponse(404, "not_found");
  }

  private async revokeInstallation(): Promise<Response> {
    const state = await this.loadInstallationState();
    state.revoked = true;
    state.events = [];
    state.deliveries = {};
    state.clients = {};
    await this.state.storage.put("installation-state", state);
    return jsonResponse(200, { revoked: true });
  }

  private async registerClient(body: Record<string, unknown>): Promise<Response> {
    if (!isHash(body.clientHash)) return errorResponse(400, "invalid_client");
    const state = await this.loadInstallationState();
    if (state.revoked) return errorResponse(410, "installation_revoked");
    for (const [hash, client] of Object.entries(state.clients)) {
      if (!Number.isFinite(client.expiresAt) || client.expiresAt <= Date.now()) delete state.clients[hash];
    }
    if (!state.clients[body.clientHash] && Object.keys(state.clients).length >= MAX_CLIENTS) return errorResponse(503, "client_capacity_reached");
    const existing = state.clients[body.clientHash];
    state.clients[body.clientHash] = { cursor: existing?.cursor ?? 0, ackedDeliveryIds: existing?.ackedDeliveryIds ?? [], expiresAt: Date.now() + CLIENT_TOKEN_TTL_MS };
    await this.state.storage.put("installation-state", state);
    return jsonResponse(200, { ok: true });
  }

  private async storeEvents(body: Record<string, unknown>): Promise<Response> {
    if (!isDeliveryId(body.deliveryId) || !Array.isArray(body.events) || body.events.length > MAX_LINKED_PRS) return errorResponse(400, "invalid_webhook_metadata");
    const state = await this.loadInstallationState();
    if (state.revoked) return errorResponse(410, "installation_revoked");
    const stored = appendWebhookEvents(state, body.deliveryId, body.events, Date.now());
    await this.state.storage.put("installation-state", state);
    return jsonResponse(200, { stored });
  }

  private clientFor(state: InstallationState, body: Record<string, unknown>): ClientState | undefined {
    const client = isHash(body.clientHash) ? state.clients[body.clientHash] : undefined;
    return client !== undefined && client.expiresAt > Date.now() ? client : undefined;
  }

  private async unpairClient(body: Record<string, unknown>): Promise<Response> {
    const state = await this.loadInstallationState();
    const client = this.clientFor(state, body);
    if (!client) return errorResponse(401, "client_not_authorized");
    delete state.clients[body.clientHash as string];
    await this.state.storage.put("installation-state", state);
    return jsonResponse(200, { ok: true });
  }

  private async readClientEvents(body: Record<string, unknown>): Promise<Response> {
    const state = await this.loadInstallationState();
    const client = this.clientFor(state, body);
    if (!client) return errorResponse(401, "client_not_authorized");
    let requested: number | undefined;
    if (body.cursor !== null && body.cursor !== undefined) {
      if (typeof body.cursor !== "string" || !/^\d{1,20}$/.test(body.cursor)) return errorResponse(400, "invalid_cursor");
      requested = Number(body.cursor);
      if (!Number.isSafeInteger(requested) || requested > state.nextSeq) return errorResponse(400, "invalid_cursor");
    }
    const start = requested ?? client.cursor;
    const acked = new Set(client.ackedDeliveryIds);
    const available: RelayEvent[] = [];
    let cursor = start;
    let index = 0;
    let blockedByPageLimit = false;
    while (index < state.events.length) {
      const first = state.events[index];
      if (first.seq <= start) {
        index += 1;
        continue;
      }
      const deliveryId = first.metadata.deliveryId;
      const group: StoredEvent[] = [];
      while (index < state.events.length && state.events[index].seq > start && state.events[index].metadata.deliveryId === deliveryId) {
        group.push(state.events[index]);
        index += 1;
      }
      if (acked.has(deliveryId)) {
        cursor = group[group.length - 1].seq;
        continue;
      }
      if (available.length + group.length > MAX_EVENTS_PER_RESPONSE) {
        blockedByPageLimit = true;
        break;
      }
      available.push(...group.map(stored => stored.metadata));
      cursor = group[group.length - 1].seq;
    }
    if (!blockedByPageLimit) {
      const latest = state.events.length === 0 ? state.nextSeq : state.events[state.events.length - 1].seq;
      cursor = Math.max(cursor, latest);
    }
    // Pruning may advance the durable floor; reading a page never commits unacknowledged events.
    await this.state.storage.put("installation-state", state);
    return jsonResponse(200, { events: available, cursor: String(cursor) });
  }

  private async ackClientEvents(body: Record<string, unknown>): Promise<Response> {
    if (!Array.isArray(body.deliveryIds) || body.deliveryIds.length > 100 || body.deliveryIds.some(id => !isDeliveryId(id))) return errorResponse(400, "invalid_delivery_ids");
    const state = await this.loadInstallationState();
    const client = this.clientFor(state, body);
    if (!client) return errorResponse(401, "client_not_authorized");
    const visible = new Set(state.events.map(event => event.metadata.deliveryId));
    const acked = new Set(client.ackedDeliveryIds);
    for (const id of body.deliveryIds as string[]) if (visible.has(id)) acked.add(id);
    client.ackedDeliveryIds = Array.from(acked);
    for (const event of [...state.events].sort((left, right) => left.seq - right.seq)) {
      if (event.seq <= client.cursor) continue;
      if (!acked.has(event.metadata.deliveryId)) break;
      client.cursor = event.seq;
    }
    await this.state.storage.put("installation-state", state);
    return jsonResponse(200, { acknowledged: body.deliveryIds.filter(id => visible.has(id)).length });
  }
}
