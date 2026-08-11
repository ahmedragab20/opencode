/**
 * image-router.js — For every primary lead (smart, cursor, otto):
 * 1) strip image attachments from the lead message
 * 2) write them to disk
 * 3) auto-run vision (opencode-go/gpt-5.6-luna) in a child session
 * 4) inject [VISION DESCRIPTION] so the lead can answer immediately
 *
 * Leads retain full tool access. This plugin only fixes delegation reliability
 * and speed — it never denies permissions.
 *
 * Speed path: pass file:// parts so the vision model sees the image natively
 * (no read-tool round-trip). Fallback to vision-free on any Luna failure.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL as toFileURL } from "node:url";

const PRIMARY_LEAD_IDS = new Set(["smart", "cursor", "otto"]);
const VISION_AGENT = "vision";
const VISION_FREE_AGENT = "vision-free";
const PRT_PREFIX = "prt_";
/** Per-attempt budget. Primary then free fallback ⇒ worst case ~2× this. */
const VISION_TIMEOUT_MS = 45_000;
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
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function pathToFileURL(filepath) {
  return toFileURL(path.resolve(filepath)).href;
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
  let savedFilename = filename;
  let savedPath = null;
  let fileUrl = typeof part.url === "string" ? part.url : "";

  if (fileUrl.startsWith("data:")) {
    const decoded = decodeDataURL(fileUrl);
    if (decoded && decoded.bytes.length > 0) {
      const saved = saveToToolOutput(decoded.mime || part.mime, decoded.bytes);
      if (saved) {
        savedFilename = saved.filename;
        savedPath = saved.filepath;
        fileUrl = pathToFileURL(saved.filepath);
      }
    }
  } else if (fileUrl.startsWith("file://")) {
    try {
      const real = fileURLToPath(fileUrl);
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

  return {
    marker,
    savedFilename,
    savedPath,
    mime: part.mime,
    fileUrl: fileUrl || (savedPath ? pathToFileURL(savedPath) : ""),
  };
}

function extractText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function extractTextFromPromptParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function needsFallback(text) {
  if (!text) return true;
  return /VISION_FALLBACK_NEEDED/i.test(text);
}

function buildVisionPrompt(markers, userText) {
  const lines = [
    "Describe the pasted image(s) in structured markdown for the lead agent.",
    "The image file(s) are attached to this message — look at them directly.",
    "Only use the read tool if you cannot see an attachment; then read the absolute path from the markers.",
    "Return only the description. No preamble about being a vision agent.",
    "",
    "Markers:",
    ...markers,
  ];
  if (userText) {
    lines.push("", "User message context:", userText);
  }
  return lines.join("\n");
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(label + " timed out after " + ms + "ms"));
    }, ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function runVisionOnChild(client, directory, childSessionID, agent, prompt, fileParts) {
  const parts = [{ type: "text", text: prompt }];
  for (const fp of fileParts) {
    if (!fp.fileUrl || !fp.mime) continue;
    parts.push({
      type: "file",
      mime: fp.mime,
      filename: fp.savedFilename || "pasted-image",
      url: fp.fileUrl,
    });
  }

  const request = client.session.prompt({
    path: { id: childSessionID },
    query: { directory },
    body: {
      agent,
      // Prefer native multimodal; keep read as a cheap recovery path only.
      tools: {
        bash: false,
        edit: false,
        task: false,
        webfetch: false,
        websearch: false,
        todo: false,
      },
      parts,
    },
  });

  const { data, error } = await withTimeout(
    request,
    VISION_TIMEOUT_MS,
    "Vision subagent (" + agent + ")",
  );

  if (error) {
    throw new Error(String(error));
  }

  return extractTextFromPromptParts(data?.parts ?? []);
}

async function delegateToVision(client, directory, parentSessionID, images, userText) {
  const { data: child, error: createError } = await client.session.create({
    body: {
      parentID: parentSessionID,
      title: "Vision parse",
    },
    query: { directory },
  });

  if (createError || !child?.id) {
    throw new Error(
      "Failed to create vision child session: " + String(createError ?? "no id"),
    );
  }

  const markers = images.map((img) => img.marker);
  const prompt = buildVisionPrompt(markers, userText);

  let agentUsed = VISION_AGENT;
  let text = "";
  let primaryError = null;

  try {
    text = await runVisionOnChild(
      client,
      directory,
      child.id,
      VISION_AGENT,
      prompt,
      images,
    );
  } catch (err) {
    primaryError = err instanceof Error ? err.message : String(err);
    console.error("[image-router] vision failed, trying vision-free:", primaryError);
  }

  if (needsFallback(text) || primaryError) {
    agentUsed = VISION_FREE_AGENT;
    text = await runVisionOnChild(
      client,
      directory,
      child.id,
      VISION_FREE_AGENT,
      prompt,
      images,
    );
  }

  if (!text || needsFallback(text)) {
    throw new Error(
      "Vision unavailable" +
        (primaryError ? " (primary: " + primaryError + ")" : "") +
        "; free fallback also failed or returned VISION_FALLBACK_NEEDED.",
    );
  }

  return { text, agentUsed };
}

const ImageRouterPlugin = async (pluginInput) => {
  const client = pluginInput?.client;
  const directory = pluginInput?.directory;

  try {
    return {
      "chat.message": async (input, output) => {
        try {
          const agent = input && input.agent;
          if (!agent || !PRIMARY_LEAD_IDS.has(agent)) return;

          const parts = output && output.parts;
          if (!parts || !Array.isArray(parts) || parts.length === 0) return;

          const sessionID = input.sessionID || "";
          let parentMessageID = "";
          let replacedAny = false;
          const images = [];

          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!part || typeof part !== "object") continue;

            if (!parentMessageID && isValidMsgID(part.messageID)) {
              parentMessageID = part.messageID;
            }

            if (part.type !== "file") continue;
            if (typeof part.mime !== "string" || !part.mime.startsWith("image/")) continue;

            const summarized = summarizeReplace(part);
            images.push(summarized);

            const partMessageID = isValidMsgID(part.messageID)
              ? part.messageID
              : parentMessageID;

            parts[i] = {
              id: isValidPrtID(part.id) ? part.id : freshPrtID("imgrpl"),
              sessionID: sessionID,
              messageID: partMessageID,
              type: "text",
              text: summarized.marker,
              synthetic: true,
            };
            replacedAny = true;
          }

          if (!replacedAny) return;

          const userText = extractText(parts);

          let visionResult = null;
          let visionError = null;

          if (client?.session?.create && client?.session?.prompt && directory) {
            try {
              visionResult = await delegateToVision(
                client,
                directory,
                sessionID,
                images,
                userText,
              );
            } catch (err) {
              visionError = err instanceof Error ? err.message : String(err);
              console.error("[image-router] vision delegation failed:", visionError);
            }
          } else {
            visionError =
              "OpenCode client unavailable in image-router plugin; lead must delegate to vision via task.";
          }

          if (visionResult?.text) {
            parts.push({
              id: freshPrtID("imgvis"),
              sessionID: sessionID,
              messageID: parentMessageID,
              type: "text",
              text:
                "[VISION DESCRIPTION from " +
                visionResult.agentUsed +
                ":\n" +
                visionResult.text +
                "]",
              synthetic: true,
            });

            parts.push({
              id: freshPrtID("imginstr"),
              sessionID: sessionID,
              messageID: parentMessageID,
              type: "text",
              text:
                "[SYSTEM: image-router already ran the vision subagent and injected [VISION DESCRIPTION] above. Prefer that description for your answer. You retain full tool access — do not re-run vision unless the description is missing or clearly wrong.]",
              synthetic: true,
            });
          } else {
            parts.push({
              id: freshPrtID("imginstr"),
              sessionID: sessionID,
              messageID: parentMessageID,
              type: "text",
              text:
                "[SYSTEM: Pasted image(s) were decoded to " +
                TOOL_OUTPUT_DIR +
                ". Vision auto-delegation failed: " +
                (visionError ?? "unknown error") +
                ". Your FIRST tool call MUST be task with agent `vision` (pass every marker path). If vision returns VISION_FALLBACK_NEEDED, retry once with `vision-free`. You retain full tool access.]",
              synthetic: true,
            });
          }
        } catch (innerErr) {
          console.error("[image-router] chat.message error:", innerErr);
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
