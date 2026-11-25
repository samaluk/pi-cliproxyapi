import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionFactory, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  createDiscovery, defaultCacheDir, gatewayFetch, providerID, record, resolveConnection, stringOption,
  warnOnDiscoveryStatus, type CatalogModel,
} from "./catalog";

const packageName = "pi-cliproxyapi";

export interface PiOptions {
  providerId?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: "openai-responses" | "openai-completions";
  cacheDir?: string;
}

async function readOptions(): Promise<Record<string, unknown>> {
  const path = join(getAgentDir(), "cliproxyapi-discovery.json");
  try {
    const options = record(JSON.parse(await readFile(path, "utf8")));
    if (Object.hasOwn(options, "apiKey")) throw new Error("API key in configuration file");
    return options;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Invalid Pi cliproxyapi-discovery.json. Supply the API key through the environment or in code.");
  }
}

function toModel(row: CatalogModel): ProviderModelConfig {
  const supported = new Set(row.efforts);
  const thinkingLevelMap: ThinkingLevelMap = {
    off: supported.has("none") ? "none" : null,
    minimal: supported.has("minimal") ? "minimal" : null,
    low: supported.has("low") ? "low" : null,
    medium: supported.has("medium") ? "medium" : null,
    high: supported.has("high") ? "high" : null,
    xhigh: supported.has("xhigh") ? "xhigh" : null,
    max: supported.has("max") ? "max" : supported.has("ultra") ? "ultra" : null,
  };
  return {
    id: row.id,
    name: row.name,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    input: row.input.filter((modality) => modality === "text" || modality === "image"),
    reasoning: row.efforts.length > 0,
    thinkingLevelMap,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export function createExtension(overrides: PiOptions = {}): ExtensionFactory {
  return async (pi) => {
    const options = { ...await readOptions(), ...overrides };
    const connection = resolveConnection(options);
    const id = providerID(options.providerId);
    const name = stringOption(options.name, "name") ?? "CLIProxyAPI";
    const api = options.api ?? "openai-responses";
    if (api !== "openai-responses" && api !== "openai-completions") throw new Error("Invalid Pi API option");
    const cacheDir = stringOption(options.cacheDir, "cacheDir") ?? defaultCacheDir(packageName);
    const discover = createDiscovery(connection, cacheDir);
    const report = warnOnDiscoveryStatus(packageName);
    let defaults = new Map<string, CatalogModel["defaultEffort"]>();

    const refresh = async (signal?: AbortSignal) => {
      const result = await discover(signal);
      report(result);
      defaults = new Map(result.catalog.models.map(({ id, defaultEffort }) => [id, defaultEffort]));
      return result.catalog.models.map(toModel);
    };
    let models: ProviderModelConfig[] = [];
    try {
      models = await refresh();
    } catch {
      report();
    }

    pi.registerProvider(id, {
      name,
      baseUrl: connection.baseUrl,
      api,
      apiKey: overrides.apiKey ?? "$CLIPROXYAPI_API_KEY",
      models,
      refreshModels: ({ signal }) => refresh(signal),
      streamSimple(model, context, streamOptions) {
        const native = getApiProvider(api);
        if (!native) throw new Error("Pi did not load the configured CLIProxyAPI transport");
        const effort = defaults.get(model.id);
        // An explicit Pi level, including an advertised off, takes precedence over the gateway default.
        const fallback = effort && model.thinkingLevelMap?.off === null
          ? Object.entries(model.thinkingLevelMap).find(([, mapped]) => mapped === effort)?.[0] as ThinkingLevel | undefined
          : undefined;
        return native.streamSimple(model, context, {
          ...streamOptions,
          reasoning: streamOptions?.reasoning ?? fallback,
          fetch: gatewayFetch(connection, streamOptions?.fetch) as typeof fetch,
        });
      },
    });
  };
}

const extension: ExtensionFactory = createExtension();
export default extension;
