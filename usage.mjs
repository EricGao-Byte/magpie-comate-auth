// Comate reports real token counts in a TOKEN_USAGE event, sent after its
// terminal ANSWER. When one arrives these counts are used; the estimates below
// describe the client-visible context and stay as the fallback for a stream
// that reports none. Keep provenance beside the OpenAI-compatible counters.
const METHOD = "unicode-density-v1"
const IMAGE_TOKENS = 1024
const UPSTREAM_SCOPE = "comate-cloud"

function units(text) {
  let count = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    // Four ASCII characters or one BMP non-ASCII character per token;
    // astral characters reserve two tokens. This is not a model tokenizer.
    count += code <= 0x7f ? 1 : code <= 0xffff ? 4 : 8
  }
  return count
}

// A count as Comate sends it: a non-negative safe integer or a numeric
// string. Anything else is unknown and contributes nothing.
function count(value) {
  const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

export function createUsageMeter(messages, tools, instructions, images = new Map()) {
  let reported = null
  let estimate = null
  let textUnits = 0, reasoningUnits = 0
  const imageCount = [...images.values()].reduce((sum, list) => sum + list.length, 0)
  function estimated() {
    if (estimate === null) {
      const transcript = messages.map(message => JSON.stringify(message)).join("\n")
      estimate = Math.ceil(units(instructions + "\n\nConversation transcript:\n" + transcript + "\n" + JSON.stringify(tools)) / 4) + imageCount * IMAGE_TOKENS
    }
    return estimate
  }
  return {
    text(value) { textUnits += units(value) },
    reasoning(value) { reasoningUnits += units(value) },
    tool(call) { textUnits += units(JSON.stringify({ name: call.name, arguments: call.input })) },
    // One client request can run several executes (initial, contract
    // correction, format regeneration), and Comate reports each one, so the
    // counts accumulate.
    upstream(raw) {
      if (!raw || typeof raw !== "object") return
      const input = count(raw.inputTokens), cached = count(raw.cachedInputTokens), output = count(raw.outputTokens)
      if (input === null && cached === null && output === null) return
      const prior = reported ?? { input: 0, cached: 0, output: 0 }
      reported = { input: prior.input + (input ?? 0), cached: prior.cached + (cached ?? 0), output: prior.output + (output ?? 0) }
    },
    source() { return reported ? "upstream" : "estimated" },
    value() {
      if (reported) {
        // inputTokens is the uncached part and cachedInputTokens the cached
        // one; OpenAI's prompt_tokens counts the whole prompt.
        const prompt = reported.input + reported.cached
        return {
          prompt_tokens: prompt,
          completion_tokens: reported.output,
          total_tokens: prompt + reported.output,
          prompt_tokens_details: { cached_tokens: reported.cached, cache_write_tokens: 0 },
          comate_usage: { source: "upstream", scope: UPSTREAM_SCOPE, cached_tokens: reported.cached },
        }
      }
      const reasoning = Math.ceil(reasoningUnits / 4)
      const completion = Math.ceil(textUnits / 4) + reasoning
      return {
        prompt_tokens: estimated(),
        completion_tokens: completion,
        total_tokens: estimated() + completion,
        completion_tokens_details: { reasoning_tokens: reasoning },
        comate_usage: { source: "estimated", method: METHOD, scope: "client-visible-context", image_tokens: imageCount * IMAGE_TOKENS },
      }
    },
  }
}
