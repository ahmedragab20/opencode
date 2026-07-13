/**
 * image-router.js — Intercepts image attachments in messages to text-only
 * router agents and replaces them with text markers so the model can
 * delegate to the vision agent instead of trying to process images itself.
 *
 * OpenCode TUI embeds pasted clipboard images as `data:<mime>;base64,…`
 * URLs and never writes them to disk. The vision subagent relies on a
 * `clipboard-*.png` filename lookup under known temp roots, which fails
 * because the file does not exist there. This plugin decodes the data URL,
 * writes the image to `~/.local/share/opencode/tool-output/` (which the
 * vision agent has explicit read permission for via `external_directory`),
 * and emits a marker carrying both the basename and the absolute path so
 * vision can recover the bytes deterministically.
 *
 * OpenCode's part schema also requires `part.id` to start with `prt` and
 * `part.messageID` to start with `msg` (or be absent). Earlier versions of
 * this plugin prepended "img-" to the original id, producing
 * "img-prt_..." ids and triggering SchemaError on every paste. The plugin
 * preserves the original `prt_…` id when one exists, and only generates a
 * fresh id when the replacement does not have one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROUTER_AGENT_IDS = new Set(["router", "router-paid"]);
const PRT_PREFIX = "prt_";
const TOOL_OUTPUT_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode",
  "tool-output",
);

const MIME_TO_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

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

function extForMime(mime) {
  return MIME_TO_EXT[mime] || "bin";
}

function uniqHash() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  );
}

function decodeDataURL(url) {
  const match = /^data:([^;,]+)(?:;charset=[^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const dataMime = match[1];
  const isBase64 = match[2] === ";base64";
  const payload = match[3];
  let bytes;
  try {
    bytes = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
  } catch (_e) {
    return null;
  }
  return { mime: dataMime, bytes };
}

function saveToToolOutput(mime, bytes) {
  try {
    const ext = extForMime(mime);
    const filename = "clipboard-" + uniqHash() + "." + ext;
    fs.mkdirSync(TOOL_OUTPUT_DIR, { recursive: true });
    const filepath = path.join(TOOL_OUTPUT_DIR, filename);
    fs.writeFileSync(filepath, bytes);
    return { filename, filepath };
  } catch (_e) {
    return null;
  }
}

function summarizeReplace(part) {
  const filename = part.filename || "pasted-image";
  const ext = extForMime(part.mime);

  let savedFilename = filename;
  let savedPath = null;

  const url = typeof part.url === "string" ? part.url : "";
  if (url.startsWith("data:")) {
    const decoded = decodeDataURL(url);
    if (decoded && decoded.bytes.length > 0) {
      const saved = saveToToolOutput(decoded.mime || part.mime, decoded.bytes);
      if (saved) {
        savedFilename = saved.filename;
        savedPath = saved.filepath;
      }
    }
  } else if (url.startsWith("file://")) {
    try {
      const real = fileURLToPath(url);
      savedFilename = path.basename(real);
      savedPath = real;
    } catch (_e) {
      savedPath = null;
    }
  }

  const marker =
    "[IMAGE DETECTED: " +
    savedFilename +
    " (" +
    part.mime +
    ")" +
    (savedPath ? " at " + savedPath : "") +
    "]";

  return { marker, savedFilename, savedPath };
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

            const { marker } = summarizeReplace(part);
            const partMessageID = isValidMsgID(part.messageID)
              ? part.messageID
              : parentMessageID;

            parts[i] = {
              id: isValidPrtID(part.id) ? part.id : freshPrtID("imgrpl"),
              sessionID: sessionID,
              messageID: partMessageID,
              type: "text",
              text: marker,
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
              text:
                "[SYSTEM: Pasted image attachments have been decoded and written to " +
                TOOL_OUTPUT_DIR +
                ". Each marker above includes an `at <absolute path>` suffix; the vision subagent must read the file at that path before parsing. Delegate to the `vision` agent via the task tool.]",
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
