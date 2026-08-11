/**
 * cursor-vision.js — Keep native image input enabled for Cursor lead models.
 *
 * Smart is the only text-only lead (see image-router.js). Cursor should use
 * the configured model's native multimodal vision.
 *
 * cursor-oauth-opencode only advertises attachment/input.image for a small
 * "vision-proven" allowlist (claude-sonnet-5, composer-2.5). Everything else
 * — including grok-4.5-fast — is registered as text-only even though the
 * proxy forwards inbound images. OpenCode then strips clipboard/uploads with:
 *   Cannot read "clipboard" (this model does not support image input)
 *
 * auth.loader also replaces provider.models after config merge, so a static
 * opencode.jsonc modalities override is not enough. This plugin wraps
 * provider.cursor / provider.cursor-code so every models assign
 * (config seed + auth.loader + background refresh) re-enables image input.
 */

const CURSOR_PROVIDER_IDS = ["cursor", "cursor-code"];
const PROVIDER_WRAPPED = Symbol.for("opencode.cursorVision.provider");
const SLOT_KEYS = Symbol.for("opencode.cursorVision.slotKeys");

function ensureImageInList(list) {
  const next = Array.isArray(list) ? list.slice() : ["text"];
  if (!next.includes("text")) next.unshift("text");
  if (!next.includes("image")) next.push("image");
  return next;
}

function enableVisionOnModel(model) {
  if (!model || typeof model !== "object" || Array.isArray(model)) return;

  model.attachment = true;

  const modalities =
    model.modalities && typeof model.modalities === "object" && !Array.isArray(model.modalities)
      ? model.modalities
      : (model.modalities = {});
  modalities.input = ensureImageInList(modalities.input);
  if (!Array.isArray(modalities.output) || modalities.output.length === 0) {
    modalities.output = ["text"];
  }

  // Runtime shape from cursor-oauth-opencode's buildCursorProviderModels.
  if (model.capabilities && typeof model.capabilities === "object") {
    model.capabilities.attachment = true;
    const input =
      model.capabilities.input && typeof model.capabilities.input === "object"
        ? model.capabilities.input
        : (model.capabilities.input = {});
    input.text = true;
    input.image = true;
  }
}

function enableVisionOnModels(models) {
  if (!models || typeof models !== "object" || Array.isArray(models)) return;
  for (const model of Object.values(models)) {
    enableVisionOnModel(model);
  }
}

function wrapModelsProperty(provider) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return;
  if (provider[PROVIDER_WRAPPED]) {
    enableVisionOnModels(provider.models);
    return;
  }

  let models = provider.models;
  enableVisionOnModels(models);

  Object.defineProperty(provider, "models", {
    configurable: true,
    enumerable: true,
    get() {
      return models;
    },
    set(next) {
      models = next;
      enableVisionOnModels(models);
    },
  });

  Object.defineProperty(provider, PROVIDER_WRAPPED, {
    value: true,
    enumerable: false,
  });
}

function wrapProviderSlot(providerMap, id) {
  if (!providerMap || typeof providerMap !== "object") return;

  let wrappedIds = providerMap[SLOT_KEYS];
  if (!(wrappedIds instanceof Set)) {
    wrappedIds = new Set();
    Object.defineProperty(providerMap, SLOT_KEYS, {
      value: wrappedIds,
      enumerable: false,
    });
  }

  if (wrappedIds.has(id)) {
    wrapModelsProperty(providerMap[id]);
    return;
  }

  let provider = providerMap[id];
  Object.defineProperty(providerMap, id, {
    configurable: true,
    enumerable: true,
    get() {
      return provider;
    },
    set(next) {
      provider = next;
      wrapModelsProperty(provider);
    },
  });
  wrappedIds.add(id);

  if (provider) wrapModelsProperty(provider);
}

function installCursorVision(cfg) {
  try {
    cfg.provider ??= {};
    for (const id of CURSOR_PROVIDER_IDS) {
      wrapProviderSlot(cfg.provider, id);
    }
  } catch (_err) {
    // Never block startup over a vision patch.
  }
}

const CursorVisionPlugin = async () => {
  return {
    config: async (cfg) => {
      installCursorVision(cfg);
    },
  };
};

export { CursorVisionPlugin };
export default CursorVisionPlugin;
