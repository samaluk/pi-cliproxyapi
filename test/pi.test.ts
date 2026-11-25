import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtension } from "../src/index";

test("Pi registers native discovery, preserves advertised none, and refreshes models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpa-pi-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const reasoning = {
    slug: "sample/reasoning",
    input_modalities: ["audio", "image", "text"],
    supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }, { effort: "ultra" }],
    default_reasoning_level: "low",
  };
  let rows: unknown[] = [{ slug: "sample/basic" }, reasoning];
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++;
    expect(request.headers.get("authorization")).toBe("Bearer fixture-bearer");
    return Response.json({ models: rows });
  } });

  try {
    const registrations: Provider[] = [];
    const api = { registerProvider(provider: Provider) {
      registrations.push(provider);
    } } as ExtensionAPI;
    await createExtension({
      baseUrl: server.url.href, apiKey: "fixture-bearer", providerId: "test-cpa", cacheDir: directory,
    })(api);
    expect(registrations).toHaveLength(1);
    const [provider] = registrations;
    expect(provider.id).toBe("test-cpa");
    expect(provider.baseUrl).toBe(new URL("/v1", server.url).href);
    expect(provider.getModels()).toMatchObject([
      { id: "sample/basic", api: "openai-responses", provider: "test-cpa", reasoning: false, thinkingLevelMap: { off: null, low: null } },
      {
        id: "sample/reasoning", input: ["text", "image"], reasoning: true,
        thinkingLevelMap: { off: "none", minimal: null, low: "low", high: null, max: "ultra" },
      },
    ]);
    const reasoningModel = provider.getModels()[1];
    rows = [reasoning];
    const refresh: RefreshModelsContext = {
      allowNetwork: true,
      signal: new AbortController().signal,
      async publish({ update }) {
        expect(provider.getModels()).toHaveLength(2);
        update?.();
        return true;
      },
    };
    await provider.refreshModels!({ ...refresh, allowNetwork: false });
    expect(requests).toBe(1);
    await provider.refreshModels!({ ...refresh, publish: async () => false });
    expect(provider.getModels()).toHaveLength(2);
    await provider.refreshModels!(refresh);
    expect(provider.getModels()).toEqual([reasoningModel]);
    await expect(provider.refreshModels!({ ...refresh, signal: AbortSignal.abort() })).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
