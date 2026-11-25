import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDiscovery, fetchCatalog, gatewayFetch, normalizeBaseUrl, resolveConnection, type Fetch,
} from "../src/catalog";

const apiKey = "fixture-bearer";
const connection = { baseUrl: "https://gateway.example/v1", apiKey };
const rich = {
  models: [
    { slug: "personal/provider/hidden", visibility: "hide", base_instructions: "private instructions" },
    {
      slug: "personal/provider/reasoning",
      display_name: "Reasoning Example",
      context_window: 500_000,
      max_tokens: 128_000,
      input_modalities: ["image", "text", "audio", "unknown"],
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "none" }, { effort: "unknown" }],
      default_reasoning_level: "medium",
      supports_tool_use: true,
      base_instructions: "private instructions",
    },
    { slug: "personal/provider/basic", context_window: 2_048 },
  ],
};
const richResponse: Fetch = async () => Response.json(rich);
const down: Fetch = async () => { throw new Error("network unavailable"); };
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "cpa-catalog-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("normalizes a gateway prefix and one terminal /v1", () => {
  expect(normalizeBaseUrl("https://GATEWAY.example:443")).toBe(connection.baseUrl);
  expect(normalizeBaseUrl("https://gateway.example/v1/")).toBe(connection.baseUrl);
  expect(normalizeBaseUrl("https://gateway.example/proxy/v1/v1///")).toBe("https://gateway.example/proxy/v1");
  expect(normalizeBaseUrl("http://127.0.0.1:8317")).toBe("http://127.0.0.1:8317/v1");
  for (const bad of ["relative", "file:///v1", "https://user:pass@gateway.example", "https://gateway.example/v1?", "https://gateway.example/v1#"]) {
    expect(() => normalizeBaseUrl(bad)).toThrow();
  }
});

test("gives options precedence over launcher variables", () => {
  const env = { CLIPROXYAPI_BASE_URL: "https://fallback.example", CLIPROXYAPI_API_KEY: "fallback-key" };
  expect(resolveConnection({ baseUrl: connection.baseUrl, apiKey }, env)).toEqual(connection);
  expect(resolveConnection({}, env)).toEqual({ baseUrl: "https://fallback.example/v1", apiKey: "fallback-key" });
  expect(() => resolveConnection({ apiKey: "token\r\ninvalid" }, env)).toThrow();
});

test("whitelists rich metadata, hides routes, and distinguishes none from unsupported reasoning", async () => {
  const catalog = await fetchCatalog(connection, undefined, richResponse);
  expect(catalog).toEqual({
    mode: "rich",
    models: [
      {
        id: "personal/provider/basic", name: "personal/provider/basic",
        contextWindow: 2_048, maxTokens: 2_048, input: ["text"], output: ["text"],
        efforts: [], defaultEffort: undefined, tools: undefined,
      },
      {
        id: "personal/provider/reasoning", name: "Reasoning Example",
        contextWindow: 500_000, maxTokens: 128_000, input: ["text", "image", "audio"], output: ["text"],
        efforts: ["none", "medium"], defaultEffort: "medium", tools: true,
      },
    ],
  });
});

test("rejects duplicates, malformed rows, unsafe names and credential echoes", async () => {
  for (const rows of [
    [rich.models[0], { slug: rich.models[0].slug }],
    [{ slug: "../bad" }],
    [{ slug: "good", context_window: -1 }],
    [{ slug: "good", display_name: "\x1b[31munsafe" }],
    [{ slug: "good", input_modalities: [1] }],
    [{ slug: "good", supported_reasoning_levels: [{ effort: 2 }] }],
    [{ slug: "good", display_name: `Bearer ${apiKey}` }],
  ]) {
    let calls = 0;
    await expect(fetchCatalog(connection, undefined, async () => {
      calls++;
      return Response.json({ models: rows });
    })).rejects.toThrow();
    expect(calls).toBe(1);
  }
});

test("does not downgrade a valid empty catalog", async () => {
  let calls = 0;
  const catalog = await fetchCatalog(connection, undefined, async () => {
    calls++;
    return Response.json({ models: [] });
  });
  expect(catalog).toEqual({ mode: "rich", models: [] });
  expect(calls).toBe(1);
});

test("requests plain IDs only after an unsupported rich route or a plain envelope", async () => {
  for (const firstResponse of [
    () => new Response(null, { status: 404 }),
    () => Response.json({ data: [{ id: "ignored-first-envelope" }] }),
  ]) {
    const urls: string[] = [];
    const catalog = await fetchCatalog(connection, undefined, async (input, init) => {
      urls.push(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
      expect(init?.redirect).toBe("error");
      return urls.length === 1 ? firstResponse() : Response.json({ data: [{ id: "personal/plain" }] });
    });
    expect(urls).toEqual([`${connection.baseUrl}/models?client_version=cpa`, `${connection.baseUrl}/models`]);
    expect(catalog.mode).toBe("degraded");
    expect(catalog.models[0]).toMatchObject({
      id: "personal/plain", name: "personal/plain (ID only)", input: ["text"], efforts: [],
    });
  }
});

test("does not downgrade auth failures, outages, or malformed rich envelopes", async () => {
  for (const firstResponse of [
    () => new Response(null, { status: 401 }),
    () => new Response(null, { status: 403 }),
    () => new Response(null, { status: 503 }),
    () => Response.json({ models: null, data: [{ id: "plain" }] }),
  ]) {
    let calls = 0;
    await expect(fetchCatalog(connection, undefined, async () => {
      calls++;
      return firstResponse();
    })).rejects.toThrow();
    expect(calls).toBe(1);
  }
});

test("blocks a changed origin and refuses redirects before forwarding a bearer", async () => {
  let targetCalls = 0;
  let gatewayCalls = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    targetCalls++;
    return Response.json(rich);
  } });
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    gatewayCalls++;
    expect(request.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    return Response.redirect(target.url, 307);
  } });
  const local = { baseUrl: normalizeBaseUrl(gateway.url.href), apiKey };
  try {
    await expect(fetchCatalog(local)).rejects.toThrow();
    expect(() => gatewayFetch(local)(target.url)).toThrow("changed origin");
    expect(gatewayCalls).toBe(1);
    expect(targetCalls).toBe(0);
  } finally {
    await gateway.stop(true);
    await target.stop(true);
  }
});

test("writes a private sanitized cache, uses it on outage, and scopes it to endpoint and credential", async () => {
  const directory = await temporaryDirectory();
  const cache = join(directory, "cache");
  let upstream = richResponse;
  const lookup = createDiscovery(connection, cache, (...args) => upstream(...args));
  const live = await lookup();
  const entries = await readdir(cache);
  expect(entries).toHaveLength(1);
  expect((await stat(cache)).mode & 0o777).toBe(0o700);
  const path = join(cache, entries[0]);
  const persisted = await readFile(path, "utf8");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  for (const privateText of ["private instructions", "personal/provider/hidden", apiKey, connection.baseUrl]) {
    expect(persisted).not.toContain(privateText);
  }
  upstream = down;
  expect(await lookup()).toEqual({ catalog: live.catalog, source: "cache" });
  expect(await createDiscovery(connection, cache, down)()).toEqual({ catalog: live.catalog, source: "cache" });
  await expect(createDiscovery({ ...connection, apiKey: "another-key" }, cache, down)()).rejects.toThrow("no private cache");
  await expect(createDiscovery({ ...connection, baseUrl: "https://elsewhere.example/v1" }, cache, down)()).rejects.toThrow("no private cache");

  await chmod(path, 0o644);
  await expect(createDiscovery(connection, cache, down)()).rejects.toThrow("no private cache");
});

test("cancellation skips fallback and invalid network data never replaces last good cache", async () => {
  const directory = await temporaryDirectory();
  const { catalog } = await createDiscovery(connection, directory, richResponse)();
  const invalid: Fetch = async () => Response.json({ models: [{ slug: "bad path" }] });
  expect(await createDiscovery(connection, directory, invalid)()).toEqual({ catalog, source: "cache" });
  expect(await createDiscovery(connection, directory, down)()).toEqual({ catalog, source: "cache" });
  await expect(createDiscovery(connection, directory, down)(AbortSignal.abort())).rejects.toThrow();
});
