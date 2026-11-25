import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
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
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ models: rows });
  } });

  try {
    const registrations: Array<{ id: string; config: ProviderConfig }> = [];
    const api = { registerProvider(id: string, config: ProviderConfig) {
      registrations.push({ id, config });
    } } as ExtensionAPI;
    await createExtension({
      baseUrl: server.url.href, apiKey: "fixture-bearer", providerId: "test-cpa", cacheDir: directory,
    })(api);
    expect(registrations).toHaveLength(1);
    const [{ id, config }] = registrations;
    expect(id).toBe("test-cpa");
    expect(config.api).toBe("openai-responses");
    expect(config.baseUrl).toBe(new URL("/v1", server.url).href);
    expect(config.models).toMatchObject([
      { id: "sample/basic", reasoning: false, thinkingLevelMap: { off: null, low: null } },
      {
        id: "sample/reasoning", input: ["text", "image"], reasoning: true,
        thinkingLevelMap: { off: "none", minimal: null, low: "low", high: null, max: "ultra" },
      },
    ]);
    rows = [reasoning];
    const refresh = config.refreshModels!;
    const signal = new AbortController().signal;
    type RefreshContext = Parameters<typeof refresh>[0];
    expect(await refresh({ signal } as RefreshContext)).toEqual([config.models![1]]);
    await expect(refresh({ signal: AbortSignal.abort() } as RefreshContext)).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
