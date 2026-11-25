import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
const modalities = ["text", "image", "audio", "video", "pdf"] as const;
const fallbackContext = 8_192;
const fallbackOutput = 4_096;
const unsupportedStatuses = [400, 404, 406, 422, 501];

type Effort = (typeof efforts)[number];
type Modality = (typeof modalities)[number];
export type CatalogModel = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: Modality[];
  output: Modality[];
  efforts: Effort[];
  defaultEffort?: Effort;
  tools?: boolean;
};
export type Catalog = { mode: "rich" | "degraded"; models: CatalogModel[] };
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Connection = { baseUrl: string; apiKey: string };
type DiscoveryResult = { catalog: Catalog; source: "live" | "cache"; cacheWriteFailed?: boolean };

export function record(value: unknown, message = "Invalid CLIProxyAPI catalog"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

export function stringOption(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Invalid ${name} option`);
  return value;
}

export function providerID(value: unknown): string {
  const id = stringOption(value, "providerId") ?? "cliproxyapi";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error("Invalid providerId option");
  return id;
}

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid CLIProxyAPI base URL");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || /[?#]/.test(value)) {
    throw new Error("CLIProxyAPI requires an HTTP(S) base URL without credentials, query, or fragment");
  }
  const prefix = url.pathname.replace(/\/+$/, "").replace(/(?:\/v1)+$/, "").replace(/\/+$/, "");
  return url.origin + prefix + "/v1";
}

export function resolveConnection(options: Record<string, unknown>, env = process.env): Connection {
  const baseUrl = stringOption(options.baseUrl, "baseUrl") ?? env.CLIPROXYAPI_BASE_URL;
  const apiKey = stringOption(options.apiKey, "apiKey") ?? env.CLIPROXYAPI_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("Set CLIPROXYAPI_BASE_URL and CLIPROXYAPI_API_KEY or pass options");
  // RFC 6750 bearer-token syntax also prevents Pi from treating a key as a shell command or interpolation.
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(apiKey)) throw new Error("Invalid CLIProxyAPI bearer token");
  return { baseUrl: normalizeBaseUrl(baseUrl), apiKey };
}

export function defaultCacheDir(packageName: string): string {
  const root = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(root, packageName);
}

/** Both discovery and generation pin the origin before attaching the bearer. */
export function gatewayFetch({ baseUrl, apiKey }: Connection, fetcher: Fetch = fetch): Fetch {
  const origin = new URL(baseUrl).origin;
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin || url.username || url.password) throw new Error("CLIProxyAPI request changed origin");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("authorization", `Bearer ${apiKey}`);
    return fetcher(input, { ...init, headers, redirect: "error" });
  };
}

function getID(value: unknown, seen: Set<string>): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+@-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:+@-]*)*$/.test(value)) {
    throw new Error("Invalid CLIProxyAPI model ID");
  }
  if (seen.has(value)) throw new Error("Duplicate CLIProxyAPI model ID");
  seen.add(value);
  return value;
}

function nameOf(value: unknown, id: string): string {
  if (value == null) return id;
  if (typeof value !== "string" || !value.trim() || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new Error("Invalid CLIProxyAPI display name");
  }
  return value.trim();
}

function tokenLimit(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Invalid CLIProxyAPI token limit");
  }
  return value;
}

function selectModalities(value: unknown): Modality[] {
  if (value == null) return ["text"];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Invalid CLIProxyAPI modality list");
  }
  return modalities.filter((modality) => value.includes(modality));
}

function selectEfforts(value: unknown): Effort[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("Invalid CLIProxyAPI reasoning list");
  const advertised = value.map((item) => record(item).effort);
  if (!advertised.every((effort) => typeof effort === "string")) {
    throw new Error("Invalid CLIProxyAPI reasoning effort");
  }
  return efforts.filter((effort) => advertised.includes(effort));
}

function sortModels(models: CatalogModel[]): CatalogModel[] {
  return models.sort((left, right) => (left.id < right.id ? -1 : Number(left.id > right.id)));
}

function richCatalog(rows: unknown): Catalog {
  if (!Array.isArray(rows)) throw new Error("Invalid CLIProxyAPI rich catalog");
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const entry of rows) {
    const row = record(entry);
    const id = getID(row.slug, seen);
    if (row.visibility === "hide") continue;
    if (row.visibility != null && row.visibility !== "list") throw new Error("Invalid CLIProxyAPI model visibility");
    const contextWindow = tokenLimit(row.context_window, fallbackContext);
    const supported = selectEfforts(row.supported_reasoning_levels);
    const defaultEffort = supported.find((effort) => effort === row.default_reasoning_level);
    if (row.default_reasoning_level != null && typeof row.default_reasoning_level !== "string") {
      throw new Error("Invalid CLIProxyAPI reasoning default");
    }
    if (row.supports_tool_use != null && typeof row.supports_tool_use !== "boolean") {
      throw new Error("Invalid CLIProxyAPI tool capability");
    }
    models.push({
      id,
      name: nameOf(row.display_name, id),
      contextWindow,
      maxTokens: tokenLimit(row.max_tokens, Math.min(fallbackOutput, contextWindow)),
      input: selectModalities(row.input_modalities),
      output: selectModalities(row.output_modalities),
      efforts: supported,
      defaultEffort,
      tools: row.supports_tool_use ?? undefined,
    });
  }
  return { mode: "rich", models: sortModels(models) };
}

function degradedCatalog(rows: unknown): Catalog {
  if (!Array.isArray(rows)) throw new Error("Invalid CLIProxyAPI ID-only catalog");
  const seen = new Set<string>();
  const models = rows.map((entry): CatalogModel => {
    const id = getID(record(entry).id, seen);
    return {
      id,
      name: `${id} (ID only)`,
      contextWindow: fallbackContext,
      maxTokens: fallbackOutput,
      input: ["text"],
      output: ["text"],
      efforts: [],
    };
  });
  return { mode: "degraded", models: sortModels(models) };
}

export async function fetchCatalog(connection: Connection, signal?: AbortSignal, fetcher?: Fetch): Promise<Catalog> {
  const send = gatewayFetch(connection, fetcher);
  const timeout = AbortSignal.timeout(10_000);
  const init = { signal: signal ? AbortSignal.any([timeout, signal]) : timeout, headers: { accept: "application/json" } };
  const endpoint = `${connection.baseUrl}/models`;
  const rich = await send(`${endpoint}?client_version=cpa`, init);
  if (rich.ok) {
    const document = record(await rich.json());
    if (Object.hasOwn(document, "models")) return checkedCatalog(richCatalog(document.models), connection.apiKey);
    if (!Array.isArray(document.data)) throw new Error("Unrecognized CLIProxyAPI catalog");
  } else {
    await rich.body?.cancel();
    if (!unsupportedStatuses.includes(rich.status)) throw new Error("CLIProxyAPI rich catalog request failed");
  }
  const plain = await send(endpoint, init);
  if (!plain.ok) {
    await plain.body?.cancel();
    throw new Error("CLIProxyAPI ID-only catalog request failed");
  }
  return checkedCatalog(degradedCatalog(record(await plain.json()).data), connection.apiKey);
}

function checkedCatalog(catalog: Catalog, key: string): Catalog {
  if (catalog.models.some(({ id, name }) =>
    id === key || name === key || name.includes(`Bearer ${key}`) ||
    (key.length >= 16 && (id.includes(key) || name.includes(key))))) {
    throw new Error("CLIProxyAPI catalog echoed its credential");
  }
  return catalog;
}

function encodeCache(catalog: Catalog): string {
  const rows = catalog.mode === "degraded"
    ? catalog.models.map(({ id }) => ({ id }))
    : catalog.models.map((model) => ({
        slug: model.id,
        display_name: model.name,
        context_window: model.contextWindow,
        max_tokens: model.maxTokens,
        input_modalities: model.input,
        output_modalities: model.output,
        supported_reasoning_levels: model.efforts.map((effort) => ({ effort })),
        default_reasoning_level: model.defaultEffort,
        supports_tool_use: model.tools,
      }));
  return JSON.stringify({ version: 1, mode: catalog.mode, rows }) + "\n";
}

async function readCache(path: string, key: string): Promise<Catalog | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) return;
      const { version, mode, rows } = record(JSON.parse(await file.readFile("utf8")));
      if (version !== 1) return;
      if (mode === "rich") return checkedCatalog(richCatalog(rows), key);
      if (mode === "degraded") return checkedCatalog(degradedCatalog(rows), key);
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

async function writeCache(directory: string, path: string, contents: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, contents, { flag: "wx", mode: 0o600 });
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export function createDiscovery(connection: Connection, cacheDir: string, fetcher?: Fetch) {
  const identity = createHash("sha256").update(connection.baseUrl).update("\0").update(connection.apiKey).digest("hex");
  const path = join(cacheDir, `catalog-v1-${identity}.json`);
  let lastGood: Catalog | undefined;
  let lastWritten: string | undefined;

  return async (signal?: AbortSignal): Promise<DiscoveryResult> => {
    let catalog: Catalog;
    try {
      catalog = await fetchCatalog(connection, signal, fetcher);
    } catch {
      signal?.throwIfAborted();
      const cached = lastGood ?? await readCache(path, connection.apiKey);
      signal?.throwIfAborted();
      if (!cached) throw new Error("CLIProxyAPI catalog unavailable and no private cache is readable");
      lastGood = cached;
      return { catalog: cached, source: "cache" };
    }
    signal?.throwIfAborted();
    lastGood = catalog;
    // Write each first live result and retry a failed write on subsequent refreshes.
    const contents = encodeCache(catalog);
    try {
      if (contents !== lastWritten) {
        await writeCache(cacheDir, path, contents);
        lastWritten = contents;
      }
      return { catalog, source: "live" };
    } catch {
      return { catalog, source: "live", cacheWriteFailed: true };
    }
  };
}

export function warnOnDiscoveryStatus(label: string) {
  let previous: string | undefined;
  return (status?: DiscoveryResult) => {
    const notes: string[] = [];
    if (!status) notes.push("catalog unavailable and no private cache is readable");
    if (status?.source === "cache") notes.push("using the cached catalog");
    if (status?.catalog.mode === "degraded") notes.push("degraded catalog (IDs only)");
    if (status?.cacheWriteFailed) notes.push("could not update the private catalog cache");
    const message = notes.join(". ");
    if (message && message !== previous) console.warn(`[${label}] ${message}.`);
    previous = message;
  };
}
