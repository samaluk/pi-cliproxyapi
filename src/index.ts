import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model, Provider, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  createDiscovery, defaultCacheDir, gatewayFetch, providerID, record, resolveConnection, stringOption,
  warnOnDiscoveryStatus, type CatalogModel,
} from "./catalog";

const packageName = "pi-cliproxyapi";
type GatewayApi = "openai-responses" | "openai-completions";

export interface PiOptions {
  providerId?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: GatewayApi;
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

function toModel(row: CatalogModel, provider: string, baseUrl: string, api: GatewayApi): Model<GatewayApi> {
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
    provider,
    baseUrl,
    api,
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
    const native = api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi();

    const loadCatalog = async (signal?: AbortSignal) => {
      const result = await discover(signal);
      report(result);
      return {
        models: result.catalog.models.map((row) => toModel(row, id, connection.baseUrl, api)),
        defaults: new Map(result.catalog.models.map(({ id, defaultEffort }) => [id, defaultEffort])),
      };
    };
    let catalog: Awaited<ReturnType<typeof loadCatalog>> | undefined;
    try {
      catalog = await loadCatalog();
    } catch {
      report();
    }

    const provider: Provider = {
      id,
      name,
      baseUrl: connection.baseUrl,
      auth: {
        apiKey: {
          name: `${name} API key`,
          async resolve() {
            return {
              auth: { apiKey: connection.apiKey },
              source: overrides.apiKey ? "extension options" : "CLIPROXYAPI_API_KEY",
            };
          },
        },
      },
      getModels: () => catalog?.models ?? [],
      async refreshModels({ allowNetwork, publish, signal }) {
        if (!allowNetwork) return;
        const next = await loadCatalog(signal);
        await publish({ update: () => { catalog = next; } });
      },
      stream(model, context, streamOptions) {
        return native.stream(model, context, {
          ...streamOptions,
          fetch: gatewayFetch(connection, streamOptions?.fetch) as typeof fetch,
        });
      },
      streamSimple(model, context, streamOptions) {
        const effort = catalog?.defaults.get(model.id);
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
    };
    pi.registerProvider(provider);
  };
}

const extension: ExtensionFactory = createExtension();
export default extension;
