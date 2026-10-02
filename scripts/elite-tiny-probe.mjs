export const ELITE_CANDIDATE_MODELS = Object.freeze([
  'claude-haiku-4.5',
  'mistral-small-4',
  'gpt-5.4-mini',
  'gemini-3.1-flash-lite'
]);

export async function probeEliteModel({ key, model, baseUrl, fetcher = fetch, timeoutMs = 10000 }) {
  const start = performance.now();
  let httpStatus = null;
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !key?.trim()) {
    return { model, httpStatus, latencyMs: Math.round(performance.now() - start), choicesExists: false, choicesType: 'unavailable', choicesLength: null, messageExists: false, contentExists: false, contentType: 'unavailable', jsonValid: false, failureType: 'configuration' };
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let result;
  try {
    const response = await fetcher(base.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Return only this JSON object: {"ok":true}' }], stream: false, max_tokens: 32 }),
      signal: controller.signal
    });
    httpStatus = response.status;
    if (!response.ok) {
      result = { choicesExists: false, choicesType: 'unavailable', choicesLength: null, messageExists: false, contentExists: false, contentType: 'unavailable', jsonValid: false, failureType: 'http-error' };
    } else {
      let envelope;
      try { envelope = await response.json(); }
      catch { result = { choicesExists: false, choicesType: 'unavailable', choicesLength: null, messageExists: false, contentExists: false, contentType: 'unavailable', jsonValid: false, failureType: 'malformed-envelope' }; }
      if (!result) {
        const choicesExists = envelope !== null && typeof envelope === 'object' && 'choices' in envelope;
        const choices = choicesExists ? envelope.choices : undefined;
        const choicesType = Array.isArray(choices) ? 'array' : typeof choices;
        const choice = Array.isArray(choices) ? choices[0] : undefined;
        const messageExists = choice !== null && typeof choice === 'object' && 'message' in choice;
        const message = messageExists ? choice.message : undefined;
        const content = message !== null && typeof message === 'object' && 'content' in message ? message.content : undefined;
        const contentType = typeof content;
        const contentExists = message !== null && typeof message === 'object' && 'content' in message;
        let jsonValid = false;
        let failureType = null;
        if (!Array.isArray(choices) || !choice || typeof choice !== 'object' || !message || typeof message !== 'object' || typeof content !== 'string') failureType = 'malformed-envelope';
        else {
          let jsonText = content.trim();
          const fence = /^```json\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(jsonText);
          if (fence) jsonText = fence[1].trim();
          try {
            const parsed = JSON.parse(jsonText);
            jsonValid = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.ok === true;
            if (!jsonValid) failureType = 'unexpected-json';
          } catch { failureType = 'invalid-json'; }
        }
        result = { choicesExists, choicesType, choicesLength: Array.isArray(choices) ? choices.length : null, messageExists, contentExists, contentType, jsonValid, failureType };
      }
    }
  } catch {
    result = { choicesExists: false, choicesType: 'unavailable', choicesLength: null, messageExists: false, contentExists: false, contentType: 'unavailable', jsonValid: false, failureType: controller.signal.aborted ? 'timeout' : 'network-error' };
  } finally { clearTimeout(timer); }
  return { model, httpStatus, latencyMs: Math.round(performance.now() - start), ...result };
}
