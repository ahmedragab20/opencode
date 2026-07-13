/**
 * image-router.js — Intercepts image attachments in messages to text-only
 * router agents and replaces them with text markers so the model can
 * delegate to the vision agent instead of trying to process images itself.
 *
 * OpenCode's part schema requires part.id to start with "prt" and
 * part.messageID to start with "msg" (or be absent). Earlier versions of
 * this plugin prepended "img-" to the original id, producing
 * "img-prt_..." ids and triggering SchemaError on every paste. Keep the
 * original prt_-prefixed id when one exists, and only generate a fresh id
 * when the replacement does not have one.
 */

const ROUTER_AGENT_IDS = new Set(["router", "router-paid"]);
const PRT_PREFIX = "prt_";

function isValidPrtID(value) {
  return typeof value === "string" && value.startsWith(PRT_PREFIX);
}

function isValidMsgID(value) {
  return typeof value === "string" && value.startsWith("msg_");
}

function freshPrtID(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return PRT_PREFIX + prefix + "_" + Date.now().toString(36) + "_" + rand;
}

/**
 * Plugin: strip image attachments from messages destined for text-only routers.
 */
const ImageRouterPlugin = async () => {
  try {
    return {
      "chat.message": async (_input, _output) => {
        try {
          const agent = _input && _input.agent;
          if (!agent || !ROUTER_AGENT_IDS.has(agent)) return;

          const parts = _output && _output.parts;
          if (!parts || !Array.isArray(parts) || parts.length === 0) return;

          const sessionID = _input.sessionID || "";
          let parentMessageID = "";
          let replacedAny = false;

          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!part || typeof part !== "object") continue;

            if (!parentMessageID && isValidMsgID(part.messageID)) {
              parentMessageID = part.messageID;
            }

            if (part.type !== "file") continue;
            if (typeof part.mime !== "string" || !part.mime.startsWith("image/")) continue;

            const filename = part.filename || "pasted-image";
            const partMessageID = isValidMsgID(part.messageID) ? part.messageID : parentMessageID;

            parts[i] = {
              id: isValidPrtID(part.id) ? part.id : freshPrtID("imgrpl"),
              sessionID: sessionID,
              messageID: partMessageID,
              type: "text",
              text: "[IMAGE DETECTED: " + filename + " (" + part.mime + ")]",
              synthetic: true,
            };
            replacedAny = true;
          }

          if (replacedAny) {
            parts.push({
              id: freshPrtID("imginstr"),
              sessionID: sessionID,
              messageID: parentMessageID,
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
