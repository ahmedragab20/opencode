/**
 * image-router.js — Intercepts image attachments in messages to text-only
 * router agents and replaces them with text markers so the model can
 * delegate to the vision agent instead of trying to process images itself.
 */

const ROUTER_AGENT_IDS = new Set(["router", "router-paid"]);

/**
 * Plugin: strip image attachments from messages destined for text-only routers.
 */
const ImageRouterPlugin = async () => {
  try {
    return {
      "chat.message": async (_input, _output) => {
        try {
          // Only intercept messages for router agents
          const agent = _input && _input.agent;
          if (!agent || !ROUTER_AGENT_IDS.has(agent)) return;

          const parts = _output && _output.parts;
          if (!parts || !Array.isArray(parts) || parts.length === 0) return;

          const sessionID = _input.sessionID || "";
          let replacedAny = false;

          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!part || typeof part !== "object") continue;
            if (part.type !== "file") continue;
            if (typeof part.mime !== "string" || !part.mime.startsWith("image/")) continue;

            const filename = part.filename || "pasted-image";
            parts[i] = {
              id: "img-" + (part.id || String(Date.now())),
              sessionID: sessionID,
              messageID: part.messageID || "",
              type: "text",
              text: "[IMAGE DETECTED: " + filename + " (" + part.mime + ")]",
              synthetic: true,
            };
            replacedAny = true;
          }

          if (replacedAny) {
            parts.push({
              id: "img-instr-" + Date.now(),
              sessionID: sessionID,
              messageID: "",
              type: "text",
              text: "[SYSTEM: Image attachments have been replaced with text markers. Delegate to the `vision` agent via the task tool.]",
              synthetic: true,
            });
          }
        } catch (innerErr) {
          // Silently ignore — never let a plugin crash affect message delivery
        }
      },
    };
  } catch (initErr) {
    console.error("[image-router] init error:", initErr);
    return {};
  }
};

export { ImageRouterPlugin };
export default ImageRouterPlugin;
