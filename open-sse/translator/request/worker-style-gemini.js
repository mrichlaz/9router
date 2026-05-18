// Worker-style native Gemini translator.
// Mirrors the OpenAI -> Gemini behavior of the standalone Cloudflare Worker:
// - role: "function" turns for tool responses
// - normalized tool response content (string/object/array)
// - stable ids; OpenAI-style "call_*" ids are nullified for Gemini
// - thoughts and synthetic signatures dropped
// - schemas sanitized via the helper used elsewhere
// - thinking config gated by model family (Gemma off, gemini-3 uses thinkingLevel,
//   other gemini-* uses thinkingBudget)
// - no default safetySettings unless explicitly requested

import {
  DEFAULT_SAFETY_SETTINGS,
  convertOpenAIContentToParts,
  extractTextContent,
  tryParseJSON,
  cleanJSONSchemaForAntigravity
} from "../helpers/geminiHelper.js";

function sanitizeGeminiFunctionName(name) {
  if (!name) return "_unknown";
  let sanitized = name.replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  if (!/^[a-zA-Z_]/.test(sanitized)) sanitized = "_" + sanitized;
  return sanitized.substring(0, 64);
}

function normalizeToolResponseContent(content) {
  if (typeof content === "string") {
    const parsed = tryParseJSON(content);
    if (parsed === null) return { result: content };
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { result: parsed };
    }
    return parsed;
  }
  if (Array.isArray(content)) {
    const text = content
      .map(item => {
        if (typeof item === "string") return item;
        if (item?.type === "text") return item.text || "";
        return JSON.stringify(item);
      })
      .join("\n");
    return { result: text };
  }
  if (typeof content === "object" && content !== null) return content;
  return { result: content };
}

function hasVisiblePart(part) {
  return Boolean(
    part?.text ||
    part?.inlineData ||
    part?.fileData ||
    part?.functionCall ||
    part?.functionResponse
  );
}

function pruneEmpty(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    for (let i = obj.length - 1; i >= 0; i -= 1) {
      pruneEmpty(obj[i]);
      if (obj[i] === undefined || obj[i] === null) obj.splice(i, 1);
    }
    return obj;
  }
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === undefined || value === null) {
      delete obj[key];
      continue;
    }
    if (typeof value === "object") {
      pruneEmpty(value);
      if (Array.isArray(value) && value.length === 0) delete obj[key];
      else if (!Array.isArray(value) && Object.keys(value).length === 0) delete obj[key];
    }
  }
  return obj;
}

function pruneEmptyContents(result) {
  if (!Array.isArray(result.contents)) return;
  result.contents = result.contents
    .map(content => ({
      ...content,
      parts: Array.isArray(content.parts) ? content.parts.filter(hasVisiblePart) : content.parts
    }))
    .filter(content => Array.isArray(content.parts) && content.parts.length > 0);
}

function buildToolMessageMap(messages) {
  const map = new Map();
  for (const msg of messages) {
    if (msg?.role === "tool" && msg.tool_call_id) {
      map.set(msg.tool_call_id, msg);
    }
  }
  return map;
}

function nullableId(id) {
  if (typeof id !== "string") return null;
  return id.startsWith("call_") ? null : id;
}

export function workerStyleOpenAIToGemini(model, body) {
  const result = {
    model,
    contents: [],
    generationConfig: {}
  };

  const lowerModel = String(model || "").toLowerCase();
  const isGemma = lowerModel.startsWith("gemma-");
  const isGemini3 = lowerModel.startsWith("gemini-3");
  const isGemini = lowerModel.startsWith("gemini-");

  if (body.temperature !== undefined) result.generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) result.generationConfig.topP = body.top_p;
  if (body.top_k !== undefined) result.generationConfig.topK = body.top_k;
  if (body.max_tokens !== undefined) result.generationConfig.maxOutputTokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined) {
    result.generationConfig.maxOutputTokens = body.max_completion_tokens;
  }
  if (Array.isArray(body.stop) || typeof body.stop === "string") {
    result.generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  if (typeof body.frequency_penalty === "number") {
    result.generationConfig.frequencyPenalty = body.frequency_penalty;
  }
  if (typeof body.presence_penalty === "number") {
    result.generationConfig.presencePenalty = body.presence_penalty;
  }
  if (typeof body.seed === "number") result.generationConfig.seed = body.seed;
  if (typeof body.n === "number" && body.n > 1) result.generationConfig.candidateCount = body.n;

  // Reasoning effort gating by model family
  if (body.reasoning_effort && !isGemma) {
    if (isGemini3) {
      const levelMap = { none: "minimal", minimal: "minimal", low: "minimal", medium: "medium", high: "high", xhigh: "high" };
      result.generationConfig.thinkingConfig = {
        thinkingLevel: levelMap[body.reasoning_effort] || body.reasoning_effort
      };
    } else if (isGemini) {
      const budgetMap = { none: 0, low: 1024, medium: 8192, high: 32768 };
      const budget = budgetMap[body.reasoning_effort];
      if (typeof budget === "number") {
        result.generationConfig.thinkingConfig = { thinkingBudget: budget };
      }
    }
  }

  // Build tool_call_id -> name map (for naming function responses)
  const tcID2Name = {};
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.type === "function" && tc.id && tc.function?.name) {
            tcID2Name[tc.id] = tc.function.name;
          }
        }
      }
    }
  }
  const toolMessageMap = Array.isArray(body.messages) ? buildToolMessageMap(body.messages) : new Map();

  if (Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      if (!msg) continue;
      const role = msg.role;

      if (role === "system" && body.messages.length > 1) {
        const text = typeof msg.content === "string" ? msg.content : extractTextContent(msg.content);
        if (text) {
          result.systemInstruction = result.systemInstruction || { parts: [] };
          result.systemInstruction.parts.push({ text });
        }
        continue;
      }

      if (role === "user" || (role === "system" && body.messages.length === 1)) {
        const parts = convertOpenAIContentToParts(msg.content);
        if (parts.length > 0) result.contents.push({ role: "user", parts });
        continue;
      }

      if (role === "assistant") {
        const parts = [];
        if (msg.content) {
          const text = typeof msg.content === "string" ? msg.content : extractTextContent(msg.content);
          if (text) parts.push({ text });
        }

        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            if (tc.type !== "function") continue;
            const args = tryParseJSON(tc.function?.arguments || "{}") || {};
            parts.push({
              functionCall: {
                id: nullableId(tc.id),
                name: sanitizeGeminiFunctionName(tc.function?.name),
                args
              }
            });
          }
        }

        if (parts.length > 0) result.contents.push({ role: "model", parts });

        // Group following consecutive role:"tool" results into one function turn
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          const toolParts = [];
          for (const tc of msg.tool_calls) {
            if (tc.type !== "function" || !tc.id) continue;
            const toolMsg = toolMessageMap.get(tc.id);
            if (!toolMsg) continue;
            const name = tcID2Name[tc.id] || tc.function?.name || tc.id;
            toolParts.push({
              functionResponse: {
                id: nullableId(tc.id),
                name: sanitizeGeminiFunctionName(name),
                response: normalizeToolResponseContent(toolMsg.content)
              }
            });
          }
          if (toolParts.length > 0) {
            result.contents.push({ role: "function", parts: toolParts });
          }
        }
        continue;
      }

      // role === "tool" already consumed via assistant turn matching
    }
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const functionDeclarations = [];
    for (const t of body.tools) {
      if (t?.name && t.input_schema) {
        const cleaned = cleanJSONSchemaForAntigravity(structuredClone(t.input_schema || { type: "object", properties: {} }));
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(t.name),
          description: t.description || "",
          parameters: cleaned
        });
      } else if (t?.type === "function" && t.function) {
        const fn = t.function;
        const cleaned = cleanJSONSchemaForAntigravity(structuredClone(fn.parameters || { type: "object", properties: {} }));
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(fn.name),
          description: fn.description || "",
          parameters: cleaned
        });
      }
    }
    if (functionDeclarations.length > 0) {
      result.tools = [{ functionDeclarations }];
    }
  }

  // Optional: tool_choice -> functionCallingConfig (only if explicitly requested)
  if (body.tool_choice && !isGemma) {
    const choice = body.tool_choice;
    if (choice === "none" || choice === "auto" || choice === "any") {
      result.toolConfig = { functionCallingConfig: { mode: choice.toUpperCase() } };
    } else if (choice && typeof choice === "object" && choice.type === "function" && choice.function?.name) {
      result.toolConfig = {
        functionCallingConfig: {
          mode: "ANY",
          allowed_function_names: [sanitizeGeminiFunctionName(choice.function.name)]
        }
      };
    }
  }

  // safetySettings only if explicitly requested
  if (body?.extra_body?.google?.safety_settings) {
    result.safetySettings = body.extra_body.google.safety_settings;
  } else if (body?.safety_settings === true) {
    result.safetySettings = DEFAULT_SAFETY_SETTINGS;
  }

  pruneEmptyContents(result);
  pruneEmpty(result);
  return result;
}
