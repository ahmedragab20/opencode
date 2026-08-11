/**
 * cursor-otto.js — Cursor Otto provider plugin.
 *
 * Runs @otto-assistant/opencode-cursor-oauth's runtime on a SEPARATE provider
 * id `cursor-otto` so it can coexist with cursor-oauth-opencode (which owns
 * `cursor` and `cursor-code`).
 *
 * Differences from otto's built-in CursorAuthPlugin:
 * - PROVIDER_ID is `cursor-otto`; OAuth credentials are SHARED with the
 *   `cursor` provider (AUTH_KEY = "cursor", the same auth.json entry used by
 *   cursor-oauth-opencode). readStoredCursorAuth / writeStoredCursorAuth and
 *   the token-refresh auth.set write-backs all target the shared `cursor` key.
 * - No auth.methods are registered: the user signs in via
 *   `opencode auth login --provider cursor`. The cursor-otto auth loader
 *   bootstraps from the shared cursor store when the cursor-otto entry is
 *   empty.
 * - The proxy listens on its own port (8789 by default via
 *   OPENCODE_CURSOR_OTTO_PROXY_PORT) so it does not collide with the
 *   cursor / cursor-code proxy on 8788.
 * - Otto already advertises image input on every model — no vision shim needed.
 *
 * proxy.js computes its fixed port from OPENCODE_CURSOR_PROXY_PORT at module
 * evaluation time, and ESM static imports are hoisted above module-body
 * statements. The otto dist modules are therefore imported dynamically after
 * the port env is set so the proxy binds to this provider's port.
 */

// Plain node builtins — no proxy-port dependency, safe as static imports.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// @otto-assistant/opencode-cursor-oauth only exports "." — internal dist modules
// must be loaded via file URLs (package "exports" blocks subpath imports).
const __dirname = dirname(fileURLToPath(import.meta.url));
const OTTO_DIST = join(__dirname, "..", "node_modules", "@otto-assistant", "opencode-cursor-oauth", "dist");
const importOtto = (moduleName) => import(pathToFileURL(join(OTTO_DIST, moduleName)).href);

// Otto's proxy.js reads OPENCODE_CURSOR_PROXY_PORT at module evaluation time.
// cursor-oauth-opencode loads first and pins 8788 — force Otto's dedicated port
// before importing Otto's proxy module (separate ESM instance from cursor-oauth).
const OTTO_PROXY_PORT = (() => {
  const raw = process.env.OPENCODE_CURSOR_OTTO_PROXY_PORT ?? "8789";
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 8789;
})();
process.env.OPENCODE_CURSOR_PROXY_PORT = String(OTTO_PROXY_PORT);

const { refreshCursorToken, RefreshTokenInvalidError } = await importOtto("auth.js");
const { getCursorModels, LOGIN_PLACEHOLDER_MODELS, loginPlaceholderModels, resolveCursorModelSelection } = await importOtto("models.js");
const { startProxy } = await importOtto("proxy.js");
const { CURSOR_SELECTION_HEADER, encodeCursorModelSelection } = await importOtto("model-selection.js");
const { startCursorBrowserLogin } = await importOtto("auth-login.js");
const { log } = await importOtto("log.js");

const PROVIDER_ID = "cursor-otto";
const AUTH_KEY = "cursor";
const DEFAULT_MODEL_ID = "default";
const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
const CURSOR_VARIANT_OPTION = "cursorVariant";
const GENERATED_VARIANT_KEYS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
// Base URL OpenCode uses for the statically-declared provider. It points at
// the proxy's fixed port so requests reach the local proxy (OpenCode resolves
// the base URL from static config, not from the auth loader).
const CURSOR_BASE_URL = `http://localhost:${OTTO_PROXY_PORT}/v1`;

async function loadCursorRuntime(input, getAuth, provider, onModels) {
  // The cursor-otto provider owns no credentials of its own: fall back to the
  // shared `cursor` store whenever the provider-level auth is missing.
  let auth = await getAuth();
  if (!isCursorOAuthAuth(auth)) {
    auth = readStoredCursorAuth();
  }
  if (!isCursorOAuthAuth(auth)) return undefined;
  // Ensure we have a valid access token, refreshing if expired.
  // Refresh failures must NOT throw out of provider/auth hooks, or
  // OpenCode's provider.list() fails entirely and every Discord /model and
  // /login call surfaces "Failed to fetch providers". Return undefined so
  // Cursor Otto is simply treated as unavailable until the user re-runs login.
  let accessToken = auth.access;
  if (!accessToken || auth.expires < Date.now()) {
    try {
      const refreshed = await refreshCursorToken(auth.refresh);
      await input.client.auth.set({
        path: { id: AUTH_KEY },
        body: {
          type: "oauth",
          refresh: refreshed.refresh,
          access: refreshed.access,
          expires: refreshed.expires,
        },
      });
      accessToken = refreshed.access;
    } catch (err) {
      const permanent = err instanceof RefreshTokenInvalidError;
      const summary = err instanceof Error ? err.message : String(err);
      log.error(`[cursor-otto] Cursor token refresh ${permanent ? "rejected (re-login required)" : "failed (transient)"}: ${summary}`);
      return undefined;
    }
  }
  // Never advertise the hardcoded FALLBACK catalog through the provider hook —
  // OpenChamber's provider page would show ~14 stale models instead of the live
  // Cursor catalog. If discovery fails, keep a login placeholder until retry.
  const discovered = await getCursorModels(accessToken, {
    allowFallback: false,
  });
  const models = discovered.length > 0 ? discovered : LOGIN_PLACEHOLDER_MODELS;
  onModels?.(models);
  // startProxy() is idempotent: if the proxy is already running on the same
  // port it returns immediately. If it was stopped, it binds a new random port.
  const port = await startProxy(async () => {
    let currentAuth = await getAuth();
    if (!isCursorOAuthAuth(currentAuth)) {
      currentAuth = readStoredCursorAuth();
    }
    if (!isCursorOAuthAuth(currentAuth)) {
      throw new Error("Cursor auth not configured");
    }
    if (!currentAuth.access || currentAuth.expires < Date.now()) {
      const refreshed = await refreshCursorToken(currentAuth.refresh);
      await input.client.auth.set({
        path: { id: AUTH_KEY },
        body: {
          type: "oauth",
          refresh: refreshed.refresh,
          access: refreshed.access,
          expires: refreshed.expires,
        },
      });
      return refreshed.access;
    }
    return currentAuth.access;
  }, models);
  const providerModels = buildCursorProviderModels(models, port);
  if (provider) {
    provider.models = providerModels;
  }
  return { port, providerModels };
}

function isCursorOAuthAuth(auth) {
  return (
    !!auth &&
    typeof auth === "object" &&
    auth.type === "oauth" &&
    typeof auth.refresh === "string" &&
    typeof auth.expires === "number"
  );
}

/**
 * Mirror shared Cursor OAuth into the cursor-otto provider and eagerly start
 * the local Otto proxy so the first chat turn does not hit a dead localhost URL
 * before auth.loader runs.
 */
async function ensureOttoRuntime(input, onModels) {
  const stored = readStoredCursorAuth();
  if (!stored) return;
  try {
    await input.client.auth.set({
      path: { id: PROVIDER_ID },
      body: stored,
    });
  } catch (err) {
    const summary = err instanceof Error ? err.message : String(err);
    log.warn(`[cursor-otto] failed to mirror shared Cursor auth: ${summary}`);
  }
  try {
    await loadCursorRuntime(input, readStoredCursorAuth, undefined, onModels);
  } catch (err) {
    const summary = err instanceof Error ? err.message : String(err);
    log.warn(`[cursor-otto] failed to start Otto proxy during config: ${summary}`);
  }
}

/**
 * OpenCode plugin that provides Cursor (Otto) model access on a provider id
 * separate from cursor-oauth-opencode's `cursor` / `cursor-code`.
 * Register in opencode.json: { "plugin": [".../plugins/cursor-otto.js"] }
 */
export const CursorOttoPlugin = async (input) => {
  let modelCatalog = [];
  const rememberModels = (models) => {
    modelCatalog = models;
  };
  return {
    // Newer OpenCode releases (1.15.x) build the model catalog/menu only from
    // statically declared `config.provider.<id>` entries (or models.dev) and no
    // longer surface a plugin's dynamic `provider.models()` hook there. Seed a
    // concrete `cursor-otto` provider here so it always appears, without
    // clobbering any user-defined overrides. The dynamic hook + auth loader
    // below still refine connection details and models at runtime. When logged
    // out, seed a login placeholder model so OpenCode does not drop the
    // provider (empty model maps are removed from provider.list). After OAuth,
    // discovery replaces the placeholder.
    async config(config) {
      const models = await resolveConfigModels();
      rememberModels(models);
      ensureProviderConfig(config, models);
      await ensureOttoRuntime(input, rememberModels);
    },
    "chat.headers": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      const messageModel = hookInput.message.model;
      const variant = typeof messageModel.variant === "string" ? messageModel.variant : undefined;
      const selected = resolveCursorModelSelection(modelCatalog, hookInput.model.id, variant);
      if (selected) {
        output.headers[CURSOR_SELECTION_HEADER] =
          encodeCursorModelSelection(selected);
      }
    },
    "chat.params": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      // The selected Cursor variant is routed through a private local header.
      // Do not let OpenCode's generic reasoning defaults or our marker leak to
      // the OpenAI-compatible SDK request body.
      delete output.options.reasoningEffort;
      delete output.options[CURSOR_VARIANT_OPTION];
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        const runtime = await loadCursorRuntime(input, async () => ctx.auth, provider, rememberModels);
        return runtime?.providerModels ?? {};
      },
    },
    auth: {
      provider: PROVIDER_ID,
      // No auth.methods on purpose: the user signs in via
      // `opencode auth login --provider cursor` (cursor-oauth-opencode), which
      // populates the shared `cursor` store this loader bootstraps from.
      async loader(getAuth, provider) {
        const runtime = await loadCursorRuntime(input, getAuth, provider, rememberModels);
        if (!runtime) return {};
        return {
          baseURL: `http://localhost:${runtime.port}/v1`,
          apiKey: "cursor-proxy",
          async fetch(requestInput, init) {
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization");
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization");
              } else {
                delete init.headers["authorization"];
                delete init.headers["Authorization"];
              }
            }
            return fetch(requestInput, init);
          },
        };
      },
    },
  };
};

function buildCursorProviderModels(models, port) {
  const providerModels = Object.fromEntries(models.map((model) => [model.id, buildProviderModel(model, model.id, port)]));
  const defaultModel = selectDefaultCursorModel(models);
  if (defaultModel && !(DEFAULT_MODEL_ID in providerModels)) {
    providerModels[DEFAULT_MODEL_ID] = buildProviderModel(defaultModel, DEFAULT_MODEL_ID, port);
  }
  return providerModels;
}

function selectDefaultCursorModel(models) {
  return (
    models.find((model) => model.id === "composer-2") ??
    models.find((model) => model.id === "composer-2-fast") ??
    models.find((model) => model.id === "composer-1.5") ??
    models.find((model) => model.id.startsWith("composer-")) ??
    models[0]
  );
}

function buildProviderModel(model, id, port) {
  const contextWindow = model.contextWindow > 0 ? model.contextWindow : 200_000;
  const maxTokens = model.maxTokens > 0 ? model.maxTokens : 64_000;
  return {
    id,
    providerID: PROVIDER_ID,
    api: {
      // Send the catalog/alias id literally. For the "default" alias this means
      // Cursor receives "default" and performs its own server-side model
      // auto-selection and rate-limit routing. Pre-resolving it to a concrete
      // model here would defeat that (see proxy.resolveProxyModelId).
      id,
      url: `http://localhost:${port}/v1`,
      npm: "@ai-sdk/openai-compatible",
    },
    name: id === DEFAULT_MODEL_ID ? `Default (${model.name})` : model.name,
    // Cursor agent models accept image attachments (vision). OpenCode gates
    // file/image parts client-side on these flags — leaving image:false made
    // every Cursor model report "does not support Image input".
    capabilities: {
      temperature: true,
      reasoning: id === DEFAULT_MODEL_ID ? false : model.reasoning && Object.keys(model.variants).length > 0,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    modalities: {
      input: ["text", "image"],
      output: ["text"],
    },
    cost: estimateModelCost(model.id),
    limit: {
      context: contextWindow,
      output: maxTokens,
    },
    status: "active",
    options: {
      includeUsage: true,
    },
    headers: {},
    release_date: "",
    variants: id === DEFAULT_MODEL_ID ? {} : buildRuntimeVariants(model),
  };
}

function buildRuntimeVariants(model) {
  return Object.fromEntries(Object.keys(model.variants).map((key) => [
    key,
    { [CURSOR_VARIANT_OPTION]: key },
  ]));
}

function buildConfigVariants(model) {
  const variants = buildRuntimeVariants(model);
  for (const key of GENERATED_VARIANT_KEYS) {
    if (!(key in variants)) variants[key] = { disabled: true };
  }
  return variants;
}

/**
 * Ensure OpenCode has a concrete `cursor-otto` provider declaration in its
 * config so the provider and its models appear in the model menu. Existing
 * user-defined fields and models are preserved; only missing pieces are filled
 * in. The seeded name is fixed to "Cursor Otto" (login happens through the
 * shared `cursor` provider, not this one).
 */
function ensureProviderConfig(config, models) {
  if (!config || typeof config !== "object") return;
  const cfg = config;
  cfg.provider ??= {};
  const existing = cfg.provider[PROVIDER_ID] ?? {};
  const existingOptions = existing.options && typeof existing.options === "object"
    ? existing.options
    : {};
  const existingModels = existing.models && typeof existing.models === "object"
    ? existing.models
    : {};
  const providerName = typeof existing.name === "string" && existing.name.trim()
    ? existing.name
    : "Cursor Otto";
  cfg.provider[PROVIDER_ID] = {
    ...existing,
    name: providerName,
    npm: existing.npm ?? OPENAI_COMPATIBLE_NPM,
    options: {
      baseURL: CURSOR_BASE_URL,
      // Ensure OpenAI-compatible streams surface usage chunks to OpenCode's
      // context meter (AI SDK includeUsage / stream_options.include_usage).
      includeUsage: true,
      ...existingOptions,
    },
    // User-declared model entries win over the seeded defaults.
    models: {
      ...buildConfigModelEntries(models),
      ...existingModels,
    },
  };
}

/**
 * Resolve the model list used to seed the static provider config. Prefers the
 * full set discovered from Cursor (using the shared stored OAuth access token)
 * so the whole catalog shows up in the menu.
 *
 * When logged out — or when a stored token cannot discover models — seeds a
 * single login placeholder. OpenCode drops providers with zero models from
 * `provider.list()`, which would hide Cursor Otto in OpenChamber. We
 * intentionally never seed the hardcoded FALLBACK_MODELS catalog into the
 * provider UI: that advertised ~14 stale models as if they were the live
 * Cursor list (~50).
 *
 * Never throws.
 */
async function resolveLoggedOutPlaceholder() {
  // OpenChamber's provider detail page often skips plugin OAuth methods and
  // shows a misleading API-key field. Start the same browser OAuth as
  // `opencode auth login` and embed the URL in the placeholder model name.
  // The completed login lands in the shared `cursor` auth.json entry.
  try {
    const pending = await startCursorBrowserLogin();
    return loginPlaceholderModels(pending.url);
  } catch (err) {
    const summary = err instanceof Error ? err.message : String(err);
    log.warn(`[cursor-otto] failed to start browser login: ${summary}`);
    return LOGIN_PLACEHOLDER_MODELS;
  }
}

async function resolveConfigModels() {
  const stored = readStoredCursorAuth();
  if (!stored) return resolveLoggedOutPlaceholder();
  let accessToken = stored.access;
  if (!accessToken || stored.expires < Date.now()) {
    try {
      const refreshed = await refreshCursorToken(stored.refresh);
      writeStoredCursorAuth({
        type: "oauth",
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
      });
      accessToken = refreshed.access;
    } catch (err) {
      const summary = err instanceof Error ? err.message : String(err);
      log.warn(`[cursor-otto] config model discovery refresh failed: ${summary}`);
      return resolveLoggedOutPlaceholder();
    }
  }
  // Transient h2-bridge / Cursor API hiccups at plugin load used to fall
  // straight to the login placeholder, leaving the provider with zero real
  // models until the next restart (every model request fails with
  // "Model not found"). Retry discovery briefly before giving up.
  let discovered = [];
  for (let attempt = 0; attempt < 3 && discovered.length === 0; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1_000 * attempt));
    }
    try {
      // Allow enough time for the HTTP/2 bridge + AvailableModels round-trip.
      // The previous 4s budget often fell through to the hardcoded fallback list.
      discovered = await withTimeout(getCursorModels(accessToken, { allowFallback: false }), 15_000);
    } catch (err) {
      const summary = err instanceof Error ? err.message : String(err);
      log.warn(`[cursor-otto] Cursor model discovery failed (attempt ${attempt + 1}/3) for config: ${summary}`);
    }
  }
  if (discovered.length > 0) {
    log.info(`[cursor-otto] discovered ${discovered.length} Cursor models for provider config`);
    return discovered;
  }
  log.warn("[cursor-otto] Cursor model discovery returned no models; seeding login placeholder");
  return resolveLoggedOutPlaceholder();
}

function getOpencodeAuthPath() {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode", "auth.json");
}

/**
 * Best-effort read of the shared Cursor OAuth entry (AUTH_KEY = "cursor") from
 * OpenCode's auth store. Returns undefined if missing or malformed. Expired
 * access tokens are still returned when a refresh token is present so callers
 * can refresh.
 */
function readStoredCursorAuth() {
  try {
    const data = JSON.parse(readFileSync(getOpencodeAuthPath(), "utf8"));
    const cursor = data?.[AUTH_KEY];
    if (!cursor || cursor.type !== "oauth") return undefined;
    if (typeof cursor.refresh !== "string" || !cursor.refresh) return undefined;
    if (typeof cursor.expires !== "number") return undefined;
    return {
      type: "oauth",
      access: typeof cursor.access === "string" ? cursor.access : undefined,
      refresh: cursor.refresh,
      expires: cursor.expires,
    };
  } catch {
    return undefined;
  }
}

function writeStoredCursorAuth(auth) {
  try {
    const authPath = getOpencodeAuthPath();
    let data = {};
    try {
      data = JSON.parse(readFileSync(authPath, "utf8"));
    } catch {
      data = {};
    }
    data[AUTH_KEY] = {
      type: "oauth",
      access: auth.access,
      refresh: auth.refresh,
      expires: auth.expires,
    };
    writeFileSync(authPath, `${JSON.stringify(data, null, 2)}\n`);
  } catch (err) {
    const summary = err instanceof Error ? err.message : String(err);
    log.warn(`[cursor-otto] failed to persist refreshed Cursor auth: ${summary}`);
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function buildConfigModelEntries(models) {
  const entries = {};
  for (const model of models) {
    const contextWindow = model.contextWindow > 0 ? model.contextWindow : 200_000;
    const maxTokens = model.maxTokens > 0 ? model.maxTokens : 64_000;
    entries[model.id] = {
      name: model.name,
      // OpenCode prepends generic low/medium/high variants for reasoning-capable
      // OpenAI-compatible models before merging custom variants. Marking this
      // config descriptor non-reasoning keeps our explicit Cursor variant map
      // authoritative, including its canonical presentation order. Cursor
      // reasoning output and routing are handled by the local proxy.
      reasoning: false,
      tool_call: true,
      // Required for OpenCode's static config path: without modalities.input
      // including "image", attachments are stripped before they reach the proxy.
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
      capabilities: {
        tools: true,
        input: ["text", "image"],
        output: ["text"],
      },
      cost: estimateModelCost(model.id),
      limit: {
        context: contextWindow,
        output: maxTokens,
      },
      options: {
        includeUsage: true,
      },
      variants: buildConfigVariants(model),
    };
  }
  // Seed a "default" entry so OpenCode versions that build the model menu from
  // static config still expose Cursor's auto-routing. The entry key ("default")
  // is sent upstream verbatim, so Cursor selects/routes the model itself.
  const defaultModel = selectDefaultCursorModel(models);
  if (defaultModel && !(DEFAULT_MODEL_ID in entries)) {
    const contextWindow = defaultModel.contextWindow > 0 ? defaultModel.contextWindow : 200_000;
    const maxTokens = defaultModel.maxTokens > 0 ? defaultModel.maxTokens : 64_000;
    entries[DEFAULT_MODEL_ID] = {
      name: `Default (${defaultModel.name})`,
      reasoning: false,
      tool_call: true,
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
      capabilities: {
        tools: true,
        input: ["text", "image"],
        output: ["text"],
      },
      cost: estimateModelCost(defaultModel.id),
      limit: {
        context: contextWindow,
        output: maxTokens,
      },
      options: {
        includeUsage: true,
      },
      variants: Object.fromEntries(GENERATED_VARIANT_KEYS.map((key) => [key, { disabled: true }])),
    };
  }
  return entries;
}

// $/M token rates from cursor.com/docs/models-and-pricing
const MODEL_COST_TABLE = {
  // Anthropic
  "claude-4-sonnet": { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  "claude-4-sonnet-1m": { input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
  "claude-4.5-haiku": { input: 1, output: 5, cache: { read: 0.1, write: 1.25 } },
  "claude-4.5-opus": { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
  "claude-4.5-sonnet": { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  "claude-4.6-opus": { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
  "claude-4.6-opus-fast": { input: 30, output: 150, cache: { read: 3, write: 37.5 } },
  "claude-4.6-sonnet": { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  // Cursor
  "composer-1": { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "composer-1.5": { input: 3.5, output: 17.5, cache: { read: 0.35, write: 0 } },
  "composer-2": { input: 0.5, output: 2.5, cache: { read: 0.2, write: 0 } },
  "composer-2-fast": { input: 1.5, output: 7.5, cache: { read: 0.2, write: 0 } },
  // Google
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cache: { read: 0.03, write: 0 } },
  "gemini-3-flash": { input: 0.5, output: 3, cache: { read: 0.05, write: 0 } },
  "gemini-3-pro": { input: 2, output: 12, cache: { read: 0.2, write: 0 } },
  "gemini-3-pro-image": { input: 2, output: 12, cache: { read: 0.2, write: 0 } },
  "gemini-3.1-pro": { input: 2, output: 12, cache: { read: 0.2, write: 0 } },
  // OpenAI
  "gpt-5": { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5-fast": { input: 2.5, output: 20, cache: { read: 0.25, write: 0 } },
  "gpt-5-mini": { input: 0.25, output: 2, cache: { read: 0.025, write: 0 } },
  "gpt-5-codex": { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5.1-codex": { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5.1-codex-max": { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cache: { read: 0.025, write: 0 } },
  "gpt-5.2": { input: 1.75, output: 14, cache: { read: 0.175, write: 0 } },
  "gpt-5.2-codex": { input: 1.75, output: 14, cache: { read: 0.175, write: 0 } },
  "gpt-5.3-codex": { input: 1.75, output: 14, cache: { read: 0.175, write: 0 } },
  "gpt-5.4": { input: 2.5, output: 15, cache: { read: 0.25, write: 0 } },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cache: { read: 0.075, write: 0 } },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cache: { read: 0.02, write: 0 } },
  // xAI
  "grok-4-5": { input: 2, output: 6, cache: { read: 0.2, write: 0 } },
  "grok-4.20": { input: 2, output: 6, cache: { read: 0.2, write: 0 } },
  "grok-4-fast-reasoning": { input: 2, output: 6, cache: { read: 0.2, write: 0 } },
  "grok-4-0709": { input: 2, output: 6, cache: { read: 0.2, write: 0 } },
  // Moonshot
  "kimi-k2.5": { input: 0.6, output: 3, cache: { read: 0.1, write: 0 } },
};
// Most-specific first
const MODEL_COST_PATTERNS = [
  { match: (id) => /claude.*opus.*fast/i.test(id), cost: MODEL_COST_TABLE["claude-4.6-opus-fast"] },
  { match: (id) => /claude.*opus/i.test(id), cost: MODEL_COST_TABLE["claude-4.6-opus"] },
  { match: (id) => /claude.*haiku/i.test(id), cost: MODEL_COST_TABLE["claude-4.5-haiku"] },
  { match: (id) => /claude.*sonnet/i.test(id), cost: MODEL_COST_TABLE["claude-4.6-sonnet"] },
  { match: (id) => /claude/i.test(id), cost: MODEL_COST_TABLE["claude-4.6-sonnet"] },
  { match: (id) => /composer-?2/i.test(id), cost: MODEL_COST_TABLE["composer-2"] },
  { match: (id) => /composer-?1\.5/i.test(id), cost: MODEL_COST_TABLE["composer-1.5"] },
  { match: (id) => /composer/i.test(id), cost: MODEL_COST_TABLE["composer-1"] },
  { match: (id) => /gpt-5\.4.*nano/i.test(id), cost: MODEL_COST_TABLE["gpt-5.4-nano"] },
  { match: (id) => /gpt-5\.4.*mini/i.test(id), cost: MODEL_COST_TABLE["gpt-5.4-mini"] },
  { match: (id) => /gpt-5\.4/i.test(id), cost: MODEL_COST_TABLE["gpt-5.4"] },
  { match: (id) => /gpt-5\.3/i.test(id), cost: MODEL_COST_TABLE["gpt-5.3-codex"] },
  { match: (id) => /gpt-5\.2/i.test(id), cost: MODEL_COST_TABLE["gpt-5.2"] },
  { match: (id) => /gpt-5\.1.*mini/i.test(id), cost: MODEL_COST_TABLE["gpt-5.1-codex-mini"] },
  { match: (id) => /gpt-5\.1/i.test(id), cost: MODEL_COST_TABLE["gpt-5.1-codex"] },
  { match: (id) => /gpt-5.*mini/i.test(id), cost: MODEL_COST_TABLE["gpt-5-mini"] },
  { match: (id) => /gpt-5.*fast/i.test(id), cost: MODEL_COST_TABLE["gpt-5-fast"] },
  { match: (id) => /gpt-5/i.test(id), cost: MODEL_COST_TABLE["gpt-5"] },
  { match: (id) => /gemini.*3\.1/i.test(id), cost: MODEL_COST_TABLE["gemini-3.1-pro"] },
  { match: (id) => /gemini.*3.*flash/i.test(id), cost: MODEL_COST_TABLE["gemini-3-flash"] },
  { match: (id) => /gemini.*3/i.test(id), cost: MODEL_COST_TABLE["gemini-3-pro"] },
  { match: (id) => /gemini.*flash/i.test(id), cost: MODEL_COST_TABLE["gemini-2.5-flash"] },
  { match: (id) => /gemini/i.test(id), cost: MODEL_COST_TABLE["gemini-3.1-pro"] },
  { match: (id) => /grok/i.test(id), cost: MODEL_COST_TABLE["grok-4.20"] },
  { match: (id) => /kimi/i.test(id), cost: MODEL_COST_TABLE["kimi-k2.5"] },
];
const DEFAULT_COST = { input: 3, output: 15, cache: { read: 0.3, write: 0 } };

function estimateModelCost(modelId) {
  const normalized = modelId.toLowerCase();
  const exact = MODEL_COST_TABLE[normalized];
  if (exact) return exact;
  const stripped = normalized.replace(/-(high|medium|low|preview|thinking|spark-preview)$/g, "");
  const strippedMatch = MODEL_COST_TABLE[stripped];
  if (strippedMatch) return strippedMatch;
  return MODEL_COST_PATTERNS.find((p) => p.match(normalized))?.cost ?? DEFAULT_COST;
}

export default CursorOttoPlugin;