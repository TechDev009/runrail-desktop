import { describe, expect, test } from "bun:test";
import worker, {
  appendWebhookEvents,
  createAppJwt,
  emptyInstallationState,
  extractEvents,
  pruneInstallationState,
  RelayDurableObject,
  verifyAppInstallation,
  verifyWebhookSignature,
  type DurableObjectStorageLike,
  type Env,
} from "../src/index";

class MemoryStorage implements DurableObjectStorageLike {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

class MemoryNamespace {
  instances = new Map<string, RelayDurableObject>();
  env!: Env;
  idFromName(name: string): string { return name; }
  get(id: unknown): RelayDurableObject {
    const name = String(id);
    let instance = this.instances.get(name);
    if (!instance) {
      instance = new RelayDurableObject({ storage: new MemoryStorage() }, this.env);
      this.instances.set(name, instance);
    }
    return instance;
  }
}

function makeEnv(): { env: Env; namespace: MemoryNamespace } {
  const namespace = new MemoryNamespace();
  const env = {
    RELAY: namespace,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "relay-test-app",
    GITHUB_APP_PRIVATE_KEY: "unused-in-tests",
    WEBHOOK_SECRET: "unused-in-tests",
  } as Env;
  namespace.env = env;
  return { env, namespace };
}

async function internal(namespace: MemoryNamespace, objectName: string, path: string, body: unknown): Promise<Response> {
  return namespace.get(objectName).fetch(new Request(`https://internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function metadata(deliveryId: string, prNumber: number, extras: Record<string, unknown> = {}) {
  return {
    deliveryId,
    event: "workflow_run.completed",
    repository: "octo/project",
    prNumber,
    headSha: "a".repeat(40),
    occurredAt: "2025-01-01T00:00:00.000Z",
    ...extras,
  };
}

const deliveryOne = "11111111-1111-4111-8111-111111111111";
const tokenHashA = "a".repeat(64);
const tokenHashB = "b".repeat(64);
const stateHash = "c".repeat(64);
const ipHash = "d".repeat(64);

describe("GitHub webhook validation and minimization", () => {
  test("accepts only an exact HMAC-SHA256 signature", async () => {
    const body = new TextEncoder().encode('{"action":"completed"}');
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
    const signature = `sha256=${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
    expect(await verifyWebhookSignature(body, signature, "test-secret")).toBe(true);
    expect(await verifyWebhookSignature(body, signature, "wrong-secret")).toBe(false);
    const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
    expect(await verifyWebhookSignature(body, tamperedSignature, "test-secret")).toBe(false);
    expect(await verifyWebhookSignature(body, "sha1=deadbeef", "test-secret")).toBe(false);
  });

  test("extracts only bounded metadata and supports multiple linked PRs", () => {
    const payload = {
      action: "completed",
      repository: { full_name: "octo/project", private: true },
      workflow_run: {
        id: 90210,
        run_attempt: 2,
        head_sha: "ABCDEF0123456789abcdef0123456789abcdef01",
        completed_at: "2025-02-03T04:05:06Z",
        conclusion: "success",
        name: "private workflow name",
        pull_requests: [{ number: 11 }, { number: 12 }, { number: 11 }],
        logs: "must never be stored",
      },
      secrets: { token: "must never be stored" },
    };
    const events = extractEvents(payload, "workflow_run", deliveryOne, Date.parse("2025-02-04T00:00:00Z"));
    expect(events).toHaveLength(2);
    expect(events.map(event => event.prNumber)).toEqual([11, 12]);
    expect(events[0]).toEqual({
      deliveryId: deliveryOne,
      event: "workflow_run.completed",
      repository: "octo/project",
      prNumber: 11,
      headSha: "abcdef0123456789abcdef0123456789abcdef01",
      runId: 90210,
      attempt: 2,
      conclusion: "success",
      occurredAt: "2025-02-03T04:05:06.000Z",
    });
    expect(JSON.stringify(events)).not.toContain("must never be stored");
    expect(extractEvents({ ...payload, action: "requested" }, "workflow_run", deliveryOne)).toEqual([]);
  });

  test("signs a short-lived GitHub App JWT and verifies installations through the injected HTTPS client", async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const base64 = btoa(Array.from(der, byte => String.fromCharCode(byte)).join(""));
    const pemBody = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
    const env = { ...makeEnv().env, GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----` };
    const jwt = await createAppJwt(env);
    const [header, payload, signature] = jwt.split(".");
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();
    const decode = (part: string): Uint8Array => {
      const base64Part = part.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64Part + "=".repeat((4 - base64Part.length % 4) % 4);
      return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
    };
    const claims = JSON.parse(new TextDecoder().decode(decode(payload!))) as { iss: string; iat: number; exp: number };
    expect(claims.iss).toBe(env.GITHUB_APP_ID);
    expect(claims.exp - claims.iat).toBe(510);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, decode(signature!), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);

    const checked = await verifyAppInstallation(env, 42, async (input, init) => {
      expect(String(input)).toBe("https://api.github.com/app/installations/42");
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return new Response(JSON.stringify({ id: 42 }), { status: 200, headers: { "content-type": "application/json" } });
    });
    expect(checked).toEqual({ ok: true });
  });
});

describe("durable event state", () => {
  test("deduplicates delivery IDs and prunes events at the 24-hour expiry", () => {
    const state = emptyInstallationState();
    const event = metadata(deliveryOne, 11);
    expect(appendWebhookEvents(state, deliveryOne, [event], 1_000)).toBe(1);
    expect(appendWebhookEvents(state, deliveryOne, [event], 2_000)).toBe(0);
    expect(state.events).toHaveLength(1);
    pruneInstallationState(state, 1_000 + 24 * 60 * 60 * 1000);
    expect(state.events).toHaveLength(0);
    expect(state.deliveries[deliveryOne]).toBeUndefined();
    expect(appendWebhookEvents(state, deliveryOne, [event], 1_001 + 24 * 60 * 60 * 1000)).toBe(1);
  });

  test("keeps independent cursors and acknowledgements for desktop clients; revoke removes access", async () => {
    const { namespace } = makeEnv();
    const installName = "installation:42";
    expect((await internal(namespace, installName, "/installation/client/register", { clientHash: tokenHashA })).status).toBe(200);
    expect((await internal(namespace, installName, "/installation/client/register", { clientHash: tokenHashB })).status).toBe(200);
    await internal(namespace, installName, "/installation/webhook/events", { deliveryId: deliveryOne, events: [metadata(deliveryOne, 11)] });

    const first = await internal(namespace, installName, "/installation/client/events", { clientHash: tokenHashA, cursor: null });
    expect(await first.json()).toEqual({ events: [metadata(deliveryOne, 11)], cursor: "1" });
    const second = await internal(namespace, installName, "/installation/client/events", { clientHash: tokenHashB, cursor: "0" });
    expect(await second.json()).toEqual({ events: [metadata(deliveryOne, 11)], cursor: "1" });

    const crashReplay = await internal(namespace, installName, "/installation/client/events", { clientHash: tokenHashA, cursor: null });
    expect(await crashReplay.json()).toEqual({ events: [metadata(deliveryOne, 11)], cursor: "1" });
    await internal(namespace, installName, "/installation/client/ack", { clientHash: tokenHashA, deliveryIds: [deliveryOne] });
    const committed = await internal(namespace, installName, "/installation/client/events", { clientHash: tokenHashA, cursor: null });
    expect(await committed.json()).toEqual({ events: [], cursor: "1" });

    const replayA = await internal(namespace, installName, "/installation/client/events", { clientHash: tokenHashA, cursor: "0" });
    expect(await replayA.json()).toEqual({ events: [], cursor: "1" });
    const replayB = await internal(namespace, installName, "/installation/client/events", { clientHash: tokenHashB, cursor: "0" });
    expect((await replayB.json() as { events: unknown[] }).events).toHaveLength(1);

    expect((await internal(namespace, installName, "/installation/client/events", { clientHash: "e".repeat(64), cursor: null })).status).toBe(401);
    expect((await internal(namespace, installName, "/installation/client/unpair", { clientHash: tokenHashA })).status).toBe(200);
    expect((await internal(namespace, installName, "/installation/client/events", { clientHash: tokenHashA, cursor: "0" })).status).toBe(401);
    expect((await internal(namespace, installName, "/installation/client/events", { clientHash: tokenHashB, cursor: "0" })).status).toBe(200);
  });

  test("a signed GitHub App deletion revokes all paired clients and queued events", async () => {
    const { env, namespace } = makeEnv();
    const installName = "installation:91";
    await internal(namespace, installName, "/installation/client/register", { clientHash: tokenHashA });
    await internal(namespace, installName, "/installation/webhook/events", { deliveryId: deliveryOne, events: [metadata(deliveryOne, 91)] });
    const delivery = "22222222-2222-4222-8222-222222222222";
    const body = JSON.stringify({ action: "deleted", installation: { id: 91 } });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    const signature = `sha256=${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
    const revoked = await worker.fetch(new Request("https://relay.test/v1/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "installation", "x-github-delivery": delivery, "x-hub-signature-256": signature },
      body,
    }), env);
    expect(revoked.status).toBe(202);
    expect(await revoked.json()).toEqual({ accepted: true, revoked: true });
    expect((await internal(namespace, installName, "/installation/client/register", { clientHash: tokenHashB })).status).toBe(410);
    expect((await internal(namespace, installName, "/installation/webhook/events", { deliveryId: delivery, events: [metadata(delivery, 92)] })).status).toBe(410);
    const object = namespace.instances.get(installName)! as unknown as { state: { storage: MemoryStorage } };
    const saved = await object.state.storage.get<InstallationState>("installation-state");
    expect(saved?.revoked).toBe(true);
    expect(saved?.clients).toEqual({});
    expect(saved?.events).toEqual([]);
  });

  test("keeps linked PR records from one delivery together across response pages", async () => {
    const { namespace } = makeEnv();
    const installName = "installation:77";
    await internal(namespace, installName, "/installation/client/register", { clientHash: tokenHashA });
    for (let i = 1; i <= 95; i += 1) {
      const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
      await internal(namespace, installName, "/installation/webhook/events", { deliveryId: id, events: [metadata(id, i)] });
    }
    const linkedDelivery = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await internal(namespace, installName, "/installation/webhook/events", {
      deliveryId: linkedDelivery,
      events: Array.from({ length: 10 }, (_, index) => metadata(linkedDelivery, 200 + index)),
    });
    const firstPage = await internal(namespace, installName, "/installation/client/events", { clientHash: tokenHashA, cursor: "0" });
    const firstValue = await firstPage.json() as { events: unknown[]; cursor: string };
    expect(firstValue.events).toHaveLength(95);
    expect(firstValue.cursor).toBe("95");
    const secondPage = await internal(namespace, installName, "/installation/client/events", { clientHash: tokenHashA, cursor: firstValue.cursor });
    const secondValue = await secondPage.json() as { events: unknown[]; cursor: string };
    expect(secondValue.events).toHaveLength(10);
    expect(secondValue.cursor).toBe("105");
  });
});

describe("pairing state", () => {
  test("requires a live bound state and makes completion idempotent only for its original token", async () => {
    const { namespace } = makeEnv();
    const coordinator = "coordinator";
    expect((await internal(namespace, coordinator, "/coordinator/start", { stateHash, ipHash })).status).toBe(200);
    const pending = await internal(namespace, coordinator, "/coordinator/complete", { stateHash, tokenHash: tokenHashA });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ pending: true });
    expect((await internal(namespace, coordinator, "/coordinator/bind", { stateHash, installationId: 42 })).status).toBe(200);

    const completed = await internal(namespace, coordinator, "/coordinator/complete", { stateHash, tokenHash: tokenHashA });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({ installationId: 42 });
    const repeated = await internal(namespace, coordinator, "/coordinator/complete", { stateHash, tokenHash: tokenHashA });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ installationId: 42 });
    expect((await internal(namespace, coordinator, "/coordinator/complete", { stateHash, tokenHash: tokenHashB })).status).toBe(409);
    expect((await internal(namespace, "installation:42", "/installation/client/register", { clientHash: tokenHashA })).status).toBe(200);
  });

  test("expires uncompleted pairing states", async () => {
    const { namespace } = makeEnv();
    await internal(namespace, "coordinator", "/coordinator/start", { stateHash, ipHash });
    const coordinator = namespace.instances.get("coordinator")! as unknown as { state: { storage: MemoryStorage } };
    await coordinator.state.storage.put(`pair:${stateHash}`, { expiresAt: 0 });
    expect((await internal(namespace, "coordinator", "/coordinator/bind", { stateHash, installationId: 42 })).status).toBe(404);
  });
});

describe("public pairing HTTP API", () => {
  test("enforces same-origin pairing starts, limits requests, and returns an install URL", async () => {
    const { env } = makeEnv();
    const rejected = await worker.fetch(new Request("https://relay.test/v1/pair/start", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.test" },
      body: JSON.stringify({ state: "s".repeat(43) }),
    }), env);
    expect(rejected.status).toBe(403);
    for (let index = 0; index < 6; index += 1) {
      const state = `${"s".repeat(36)}${index}`;
      const response = await worker.fetch(new Request("https://relay.test/v1/pair/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state }),
      }), env);
      expect(response.status).toBe(200);
      const body = await response.json() as { installationUrl: string };
      const installationUrl = new URL(body.installationUrl);
      expect(installationUrl.origin).toBe("https://github.com");
      expect(installationUrl.pathname).toBe("/apps/relay-test-app/installations/new");
      expect(installationUrl.searchParams.get("state")).toBe(state);
    }
    const limited = await worker.fetch(new Request("https://relay.test/v1/pair/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "x".repeat(43) }),
    }), env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
  });

  test("hashes the desktop bearer token before registering and authorizing it", async () => {
    const { env, namespace } = makeEnv();
    const state = "q".repeat(43);
    const token = "r".repeat(43);
    const stateDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state)));
    const stateHash = Array.from(stateDigest, byte => byte.toString(16).padStart(2, "0")).join("");
    const started = await worker.fetch(new Request("https://relay.test/v1/pair/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
    }), env);
    expect(started.status).toBe(200);
    expect((await internal(namespace, "coordinator", "/coordinator/bind", { stateHash, installationId: 42 })).status).toBe(200);
    const complete = () => worker.fetch(new Request("https://relay.test/v1/pair/complete", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ state }),
    }), env);
    const response = await complete();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ installationId: 42 });
    expect(await (await complete()).json()).toEqual({ installationId: 42 });
    const events = await worker.fetch(new Request("https://relay.test/v1/installations/42/events?cursor=0", {
      headers: { authorization: `Bearer ${token}` },
    }), env);
    expect(events.status).toBe(200);
    expect(await events.json()).toEqual({ events: [], cursor: "0" });
  });
});
