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
 * - Image pastes are intercepted by image-router.js and routed to the vision
 *   subagent — Otto models still advertise image input so OpenCode accepts
 *   clipboard attachments before the router strips them.
 *
 * Startup is intentionally lazy:
 * - Otto dist modules (including proxy.js) are imported on first use, not at
 *   plugin evaluation time.
 * - `config()` only seeds from a local disk cache / static placeholder and
 *   never awaits Cursor network discovery or proxy bind.
 * - Model discovery + proxy start happen in `auth.loader` / `provider.models`
 *   (and optionally as a fire-and-forget background refresh after config).
 *
 * proxy.js computes its fixed port from OPENCODE_CURSOR_PROXY_PORT at module
 * evaluation time. The otto dist modules are therefore imported dynamically
 * after the port env is set so the proxy binds to this provider's port.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OTTO_DIST = join(
  __dirname,
  "..",
  "node_modules",
  "@otto-assistant",
  "opencode-cursor-oauth",
  "dist",
);
const importOtto = (moduleName) =>
  import(pathToFileURL(join(OTTO_DIST, moduleName)).href);

const OTTO_PROXY_PORT = (() => {
  const raw = process.env.OPENCODE_CURSOR_OTTO_PROXY_PORT ?? "8789";
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 8789;
})();
process.env.OPENCODE_CURSOR_PROXY_PORT = String(OTTO_PROXY_PORT);

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
const CURSOR_BASE_URL = `http://localhost:${OTTO_PROXY_PORT}/v1`;
const MODEL_CACHE_PATH = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "opencode-cursor",
  "otto-models.json",
);
const MODEL_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Static seed so config never needs Otto imports or network. */
const STATIC_SEED_MODELS = [
  {
    id: DEFAULT_MODEL_ID,
    name: "Cursor (loading models…)",
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 64_000,
    variants: {},
  },
];

/** @type {Promise<any> | null} */
let ottoModulesPromise = null;

function loadOttoModules() {
  if (!ottoModulesPromise) {
    // Port env must be set before proxy.js evaluates (done above at module load).
    ottoModulesPromise = Promise.all([
      importOtto("auth.js"),
      importOtto("models.js"),
      importOtto("proxy.js"),
      importOtto("model-selection.js"),
      importOtto("log.js"),
    ]).then(([auth, models, proxy, selection, logMod]) => ({
      refreshCursorToken: auth.refreshCursorToken,
      RefreshTokenInvalidError: auth.RefreshTokenInvalidError,
      getCursorModels: models.getCursorModels,
      LOGIN_PLACEHOLDER_MODELS: models.LOGIN_PLACEHOLDER_MODELS,
      resolveCursorModelSelection: models.resolveCursorModelSelection,
      startProxy: proxy.startProxy,
      CURSOR_SELECTION_HEADER: selection.CURSOR_SELECTION_HEADER,
      encodeCursorModelSelection: selection.encodeCursorModelSelection,
      log: logMod.log,
    }));
  }
  return ottoModulesPromise;
}

function readDiskModelCache() {
  try {
    const raw = JSON.parse(readFileSync(MODEL_CACHE_PATH, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    if (!Array.isArray(raw.models) || raw.models.length === 0) return null;
    const savedAt = typeof raw.savedAt === "number" ? raw.savedAt : 0;
    if (savedAt > 0 && Date.now() - savedAt > MODEL_CACHE_MAX_AGE_MS) return null;
    const models = raw.models.filter(
      (model) =>
        model &&
        typeof model === "object" &&
        typeof model.id === "string" &&
        typeof model.name === "string",
    );
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

function writeDiskModelCache(models) {
  try {
    mkdirSync(dirname(MODEL_CACHE_PATH), { recursive: true });
    const serializable = models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: !!model.reasoning,
      contextWindow: model.contextWindow > 0 ? model.contextWindow : 200_000,
      maxTokens: model.maxTokens > 0 ? model.maxTokens : 64_000,
      variants:
        model.variants && typeof model.variants === "object" ? model.variants : {},
    }));
    writeFileSync(
      MODEL_CACHE_PATH,
      `${JSON.stringify({ savedAt: Date.now(), models: serializable }, null, 2)}\n`,
    );
  } catch {
    // best-effort cache
  }
}

/**
 * Sync seed for config(): prefer yesterday's discovered catalog, else a
 * single placeholder so the provider is not dropped from provider.list().
 */
function resolveConfigModelsSync() {
  return readDiskModelCache() ?? STATIC_SEED_MODELS;
}

async function resolveAccessToken(input, getAuth, otto) {
  let auth = await getAuth();
  if (!isCursorOAuthAuth(auth)) {
    auth = readStoredCursorAuth();
  }
  if (!isCursorOAuthAuth(auth)) return undefined;

  let accessToken = auth.access;
  if (!accessToken || auth.expires < Date.now()) {
    try {
      const refreshed = await otto.refreshCursorToken(auth.refresh);
      const body = {
        type: "oauth",
        refresh: refreshed.refresh,
        access: refreshed.access,
        expires: refreshed.expires,
      };
      await input.client.auth.set({ path: { id: AUTH_KEY }, body });
      writeStoredCursorAuth(body);
      accessToken = refreshed.access;
    } catch (err) {
      const permanent = err instanceof otto.RefreshTokenInvalidError;
      const summary = err instanceof Error ? err.message : String(err);
      otto.log.error(
        `[cursor-otto] Cursor token refresh ${permanent ? "rejected (re-login required)" : "failed (transient)"}: ${summary}`,
      );
      return undefined;
    }
  }
  return accessToken;
}

/**
 * Start proxy quickly using disk-cached / placeholder models. Live Cursor
 * catalog discovery is refreshed in the background so auth.loader / first
 * chat turn do not block on AvailableModels.
 */
async function loadCursorRuntime(input, getAuth, provider, onModels) {
  const otto = await loadOttoModules();
  const accessToken = await resolveAccessToken(input, getAuth, otto);
  if (!accessToken) return undefined;

  const cached = readDiskModelCache();
  const models = cached ?? otto.LOGIN_PLACEHOLDER_MODELS;
  onModels?.(models);

  const port = await otto.startProxy(async () => {
    const token = await resolveAccessToken(input, getAuth, otto);
    if (!token) throw new Error("Cursor auth not configured");
    return token;
  }, models);

  const providerModels = buildCursorProviderModels(models, port);
  if (provider) {
    provider.models = providerModels;
  }

  // Non-blocking catalog refresh (mirrors cursor-oauth-opencode).
  void otto
    .getCursorModels(accessToken, { allowFallback: false })
    .then((discovered) => {
      if (!discovered || discovered.length === 0) return;
      onModels?.(discovered);
      writeDiskModelCache(discovered);
      const refreshed = buildCursorProviderModels(discovered, port);
      if (provider) provider.models = refreshed;
      otto.log.info(
        `[cursor-otto] background-discovered ${discovered.length} Cursor models`,
      );
    })
    .catch((err) => {
      const summary = err instanceof Error ? err.message : String(err);
      otto.log.warn(`[cursor-otto] background model discovery failed: ${summary}`);
    });

  return { port, providerModels, models };
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
 * Mirror shared Cursor OAuth into the cursor-otto provider entry only.
 * Does not import Otto modules, start the proxy, or hit the Cursor API.
 */
async function mirrorSharedCursorAuth(input) {
  const stored = readStoredCursorAuth();
  if (!stored) return;
  try {
    await input.client.auth.set({
      path: { id: PROVIDER_ID },
      body: stored,
    });
  } catch {
    // Non-fatal: auth.loader will bootstrap from the shared cursor store.
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
    // Seed static/cached provider config only. Network discovery + proxy bind
    // are deferred to auth.loader / provider.models so TUI boot stays fast.
    async config(config) {
      const models = resolveConfigModelsSync();
      rememberModels(models);
      ensureProviderConfig(config, models);
      // Fire-and-forget auth mirror only. Catalog refresh + proxy start stay on
      // auth.loader / provider.models / chat.params so boot does not import the
      // heavy Otto runtime or hit Cursor's AvailableModels API.
      void mirrorSharedCursorAuth(input).catch(() => {});
    },
    "chat.headers": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      const otto = await loadOttoModules();
      const messageModel = hookInput.message.model;
      const variant =
        typeof messageModel.variant === "string" ? messageModel.variant : undefined;
      const selected = otto.resolveCursorModelSelection(
        modelCatalog,
        hookInput.model.id,
        variant,
      );
      if (selected) {
        output.headers[otto.CURSOR_SELECTION_HEADER] =
          otto.encodeCursorModelSelection(selected);
      }
    },
    "chat.params": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      // Ensure the local proxy is up on first Otto chat turn (lazy start).
      try {
        await loadCursorRuntime(
          input,
          async () => readStoredCursorAuth(),
          undefined,
          rememberModels,
        );
      } catch {
        // auth.loader / provider path will surface a clearer error if needed
      }
      delete output.options.reasoningEffort;
      delete output.options[CURSOR_VARIANT_OPTION];
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        const runtime = await loadCursorRuntime(
          input,
          async () => ctx.auth,
          provider,
          rememberModels,
        );
        return runtime?.providerModels ?? {};
      },
    },
    auth: {
      provider: PROVIDER_ID,
      // No auth.methods on purpose: the user signs in via
      // `opencode auth login --provider cursor` (cursor-oauth-opencode), which
      // populates the shared `cursor` store this loader bootstraps from.
      async loader(getAuth, provider) {
        const runtime = await loadCursorRuntime(
          input,
          getAuth,
          provider,
          rememberModels,
        );
        if (!runtime) return {};
        return {
          baseURL: `http://localhost:${runtime.port}/v1`,
          apiKey: "cursor-proxy",
          async fetch(requestInput, init) {
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization");
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) => key.toLowerCase() !== "authorization",
                );
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
  const providerModels = Object.fromEntries(
    models.map((model) => [model.id, buildProviderModel(model, model.id, port)]),
  );
  const defaultModel = selectDefaultCursorModel(models);
  if (defaultModel && !(DEFAULT_MODEL_ID in providerModels)) {
    providerModels[DEFAULT_MODEL_ID] = buildProviderModel(
      defaultModel,
      DEFAULT_MODEL_ID,
      port,
    );
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
  const hasVariants =
    model.variants &&
    typeof model.variants === "object" &&
    Object.keys(model.variants).length > 0;
  return {
    id,
    providerID: PROVIDER_ID,
    api: {
      id,
      url: `http://localhost:${port}/v1`,
      npm: "@ai-sdk/openai-compatible",
    },
    name: id === DEFAULT_MODEL_ID ? `Default (${model.name})` : model.name,
    capabilities: {
      temperature: true,
      reasoning: id === DEFAULT_MODEL_ID ? false : !!(model.reasoning && hasVariants),
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
  const variants =
    model.variants && typeof model.variants === "object" ? model.variants : {};
  return Object.fromEntries(
    Object.keys(variants).map((key) => [key, { [CURSOR_VARIANT_OPTION]: key }]),
  );
}

function buildConfigVariants(model) {
  const variants = buildRuntimeVariants(model);
  for (const key of GENERATED_VARIANT_KEYS) {
    if (!(key in variants)) variants[key] = { disabled: true };
  }
  return variants;
}

function ensureProviderConfig(config, models) {
  if (!config || typeof config !== "object") return;
  const cfg = config;
  cfg.provider ??= {};
  const existing = cfg.provider[PROVIDER_ID] ?? {};
  const existingOptions =
    existing.options && typeof existing.options === "object"
      ? existing.options
      : {};
  const existingModels =
    existing.models && typeof existing.models === "object"
      ? existing.models
      : {};
  const providerName =
    typeof existing.name === "string" && existing.name.trim()
      ? existing.name
      : "Cursor Otto";
  cfg.provider[PROVIDER_ID] = {
    ...existing,
    name: providerName,
    npm: existing.npm ?? OPENAI_COMPATIBLE_NPM,
    options: {
      baseURL: CURSOR_BASE_URL,
      includeUsage: true,
      ...existingOptions,
    },
    models: {
      ...buildConfigModelEntries(models),
      ...existingModels,
    },
  };
}

function getOpencodeAuthPath() {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode", "auth.json");
}

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
  } catch {
    // best-effort
  }
}

function buildConfigModelEntries(models) {
  const entries = {};
  for (const model of models) {
    const contextWindow = model.contextWindow > 0 ? model.contextWindow : 200_000;
    const maxTokens = model.maxTokens > 0 ? model.maxTokens : 64_000;
    entries[model.id] = {
      name: model.name,
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
  const defaultModel = selectDefaultCursorModel(models);
  if (defaultModel && !(DEFAULT_MODEL_ID in entries)) {
    const contextWindow =
      defaultModel.contextWindow > 0 ? defaultModel.contextWindow : 200_000;
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
      variants: Object.fromEntries(
        GENERATED_VARIANT_KEYS.map((key) => [key, { disabled: true }]),
      ),
    };
  }
  return entries;
}

// $/M token rates from cursor.com/docs/models-and-pricing
const MODEL_COST_TABLE = {
  "claude-4-sonnet": { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  "claude-4-sonnet-1m": { input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
  "claude-4.5-haiku": { input: 1, output: 5, cache: { read: 0.1, write: 1.25 } },
  "claude-4.5-opus": { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
  "claude-4.5-sonnet": { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  "claude-4.6-opus": { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
  "claude-4.6-opus-fast": { input: 30, output: 150, cache: { read: 3, write: 37.5 } },
  "claude-4.6-sonnet": { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  "composer-1": { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "composer-1.5": { input: 3.5, output: 17.5, cache: { read: 0.35, write: 0 } },
  "composer-2": { input: 0.5, output: 2.5, cache: { read: 0.2, write: 0 } },
  "composer-2-fast": { input: 1.5, output: 7.5, cache: { read: 0.2, write: 0 } },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cache: { read: 0.03, write: 0 } },
  "gemini-3-flash": { input: 0.5, output: 3, cache: { read: 0.05, write: 0 } },
  "gemini-3-pro": { input: 2, output: 12, cache: { read: 0.2, write: 0 } },
  "gemini-3-pro-image": { input: 2, output: 12, cache: { read: 0.2, write: 0 } },
  "gemini-3.1-pro": { input: 2, output: 12, cache: { read: 0.2, write: 0 } },
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
  "grok-4-5": { input: 2, output: 6, cache: { read: 0.2, write: 0 } },
  "grok-4.20": { input: 2, output: 6, cache: { read: 0.2, write: 0 } },
  "grok-4-fast-reasoning": { input: 2, output: 6, cache: { read: 0.2, write: 0 } },
  "grok-4-0709": { input: 2, output: 6, cache: { read: 0.2, write: 0 } },
  "kimi-k2.5": { input: 0.6, output: 3, cache: { read: 0.1, write: 0 } },
};
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
  const stripped = normalized.replace(
    /-(high|medium|low|preview|thinking|spark-preview)$/g,
    "",
  );
  const strippedMatch = MODEL_COST_TABLE[stripped];
  if (strippedMatch) return strippedMatch;
  return MODEL_COST_PATTERNS.find((p) => p.match(normalized))?.cost ?? DEFAULT_COST;
}

export default CursorOttoPlugin;
