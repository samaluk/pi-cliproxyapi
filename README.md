# CLIProxyAPI model discovery for Pi

Discover the CLIProxyAPI models available to your API key in Pi 1.6.0 or later in the 1.x series. The extension registers a provider and uses Pi's native OpenAI Responses or Chat Completions transport.

## Requirements

Use Node.js 22.19 or later and a CLIProxyAPI gateway that supports the transport you select. For full model metadata, stock CLIProxyAPI serves `GET /v1/models?client_version=cpa` with a `models` array. The gateway API key must have access to the models you want to use.

## Install

Use the [Pi package manager](https://github.com/earendil-works/pi/blob/v1.6.0/packages/coding-agent/docs/packages.md#install-and-manage-packages).

```sh
pi install npm:@samaluk/pi-cliproxyapi@0.1.0
```

Pi records the package in your personal `settings.json`. Add `--local` to install it for a trusted project.

Set `CLIPROXYAPI_BASE_URL` to your gateway URL, for example `https://gateway.example`, and supply its bearer token through `CLIPROXYAPI_API_KEY` in Pi's environment. Run `pi --list-models` to check discovery or select a model in Pi with `/model`.

## Options

Put optional settings in `cliproxyapi-discovery.json` in Pi's agent directory (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`).

```json
{
  "providerId": "cliproxyapi",
  "api": "openai-responses"
}
```

| Option | Default and behavior |
| --- | --- |
| `baseUrl` | `CLIPROXYAPI_BASE_URL`. Accepts an HTTP(S) origin or gateway path prefix, with or without a trailing `/v1`. |
| `providerId` | `cliproxyapi`. ID for the provider registered with Pi. |
| `name` | `CLIProxyAPI`. Display name for the provider. |
| `api` | `openai-responses`. Set `openai-completions` to use Chat Completions. |
| `cacheDir` | `$XDG_CACHE_HOME/pi-cliproxyapi` or `~/.cache/pi-cliproxyapi`. |

The settings file accepts nonsecret options only. When writing a wrapper extension, you can import `createExtension(options)` from `@samaluk/pi-cliproxyapi` and export the returned factory. Options passed by the wrapper override the settings file and environment defaults. A wrapper can also pass an in-memory `apiKey`.

## Refresh and cache

Pi discovers models at startup. Run `pi update --models` to refresh on demand. On authentication failure, invalid responses, or outages, the extension uses the last valid catalog in memory or on disk. Cached catalogs have no expiration, so model availability can be stale until the gateway returns.

The cache contains selected model metadata. It uses atomic writes and owner-only file permissions (`0600` on POSIX systems), with separate files per normalized gateway URL and key. The bearer stays out of the cache and extension diagnostics. Requests attach the bearer only at the configured origin and reject redirects. Use HTTPS for remote gateways.

## Catalog support

Full discovery hides routes marked `visibility: hide`, preserves reported limits, and maps text and image inputs into Pi's supported modalities. Pricing is reported as zero because the catalog supplies no pricing. Missing limits default to 8,192 context tokens and up to 4,096 output tokens.

An advertised `none` effort maps to Pi's `off`. Pi's `max` maps to the gateway's `max` when available and to `ultra` when the gateway offers only `ultra` at that level. Pi's selected thinking level takes precedence. If there is no selection and the model has no `none` level, the extension can use an advertised default that Pi can represent.

If the rich endpoint is unsupported or returns a plain model list, the extension requests `/v1/models` and appends `(ID only)` to the display names. This fallback has no visibility, reasoning, or capability metadata, so it can include routes that rich discovery would hide.

## Releasing

For the first release, create a short-lived [granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens) on npmjs.com with **Read and write (publish and stage)** access to the `@samaluk` scope. Leave **Bypass 2FA** off. Run these commands from the repository root with Bun 1.4.5. Paste the token when prompted. Bun opens a browser for two-factor authentication if npm requests it. For a one-time code, append `--otp <code>` to the publish command.

```sh
(
  bun install --frozen-lockfile &&
  bun run check &&
  bun test &&
  bun run build &&
  bun pm pack --dry-run &&
  printf 'npm publish token: ' &&
  IFS= read -rs npm_publish_token &&
  printf '\n' &&
  NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_TOKEN="${npm_publish_token:?Token required}" \
    bun publish --no-env-file --registry https://registry.npmjs.org --access public
)
```

For automated releases, create a granular token limited to this package with **Read and write (publish and stage)** and **Bypass 2FA** enabled. Save it as the `NPM_TOKEN` repository secret in GitHub Actions. Bump the version in `package.json`, push the commit, and push a matching tag such as `v0.1.1`.

Bun 1.4.5 uses token authentication and publishes without provenance. npm [plans to retire direct publishing with granular tokens in January 2027](https://docs.npmjs.com/about-access-tokens#direct-publishing-is-being-deprecated).
