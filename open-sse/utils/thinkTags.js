// Helpers for handling reasoning text wrapped in `<think>...</think>` tags.
//
// Some upstream providers (DeepSeek, GLM, Kimi, nyxos relays...) emit reasoning
// inline inside `<think>...</think>` blocks, sometimes alongside a separate
// `reasoning_content` channel. OpenAI-compatible clients render assistant
// `content` verbatim, so the wrapper leaks into the visible reply. The helpers
// here strip these wrappers consistently across streaming/non-streaming paths.
//
// Set the env var KEEP_THINK_TAGS=1 to disable stripping (legacy behaviour).

const KEEP_THINK_TAGS = process.env.KEEP_THINK_TAGS === "1";

const THINK_BLOCK_RE = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const THINK_OPEN_RE = /<think\b[^>]*>[\s\S]*$/i;
const THINK_CLOSE_RE = /^[\s\S]*?<\/think>/i;

/**
 * Remove `<think>...</think>` blocks from a final assistant message.
 * - Strips matched pairs.
 * - Drops trailing `<think>` with no close (treats as open reasoning that never
 *   reached visible content).
 * - Drops leading `</think>` so dangling closes don't appear in output.
 */
export function stripThinkTagsFromText(text) {
  if (!text || typeof text !== "string" || KEEP_THINK_TAGS) return text;
  let cleaned = text.replace(THINK_BLOCK_RE, "");
  cleaned = cleaned.replace(THINK_OPEN_RE, "");
  cleaned = cleaned.replace(THINK_CLOSE_RE, "");
  return cleaned.trimStart();
}

/**
 * Returns a stateful filter for streaming `delta.content` chunks. Tracks an
 * `inThinkBlock` flag across chunk boundaries so split tags are still removed.
 *
 * Usage:
 *   const filter = createStreamingThinkTagFilter();
 *   const visible = filter(delta.content);
 *   if (visible) emit(visible);
 */
export function createStreamingThinkTagFilter() {
  if (KEEP_THINK_TAGS) {
    return (chunk) => chunk;
  }

  let buffer = "";
  let inThink = false;

  return function filterChunk(chunk) {
    if (typeof chunk !== "string" || chunk.length === 0) return chunk;
    buffer += chunk;
    let visible = "";

    while (buffer.length > 0) {
      if (inThink) {
        const closeIdx = buffer.toLowerCase().indexOf("</think>");
        if (closeIdx === -1) {
          // Wait for more chunks. Drop everything we have so far.
          buffer = "";
          break;
        }
        buffer = buffer.slice(closeIdx + "</think>".length);
        inThink = false;
        continue;
      }

      const openMatch = /<think\b[^>]*>/i.exec(buffer);
      if (!openMatch) {
        // No more tags. Emit the buffer as visible content.
        visible += buffer;
        buffer = "";
        break;
      }

      visible += buffer.slice(0, openMatch.index);
      buffer = buffer.slice(openMatch.index + openMatch[0].length);
      inThink = true;
    }

    return visible;
  };
}
