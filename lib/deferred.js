import { createHmac, randomUUID } from "node:crypto";
const TTL = 180;
const MAX_WAIT_MS = 120000;
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("CACHE_TIMEOUT")), 1800);
    })]);
  } finally { clearTimeout(timer); }
}
export function createDeferredHandler({ getCache, waitUntil, ask, sync, reply, history, errorText }) {
  return async function handler(req, res) {
    const body = req.body || {};
    const text = String(body.request?.command || body.request?.original_utterance || "").trim();
    const sessionId = body.session?.session_id;
    if (req.method !== "POST" || !sessionId || !text) return sync(req, res);
    const oldHistory = history(body.state?.session?.history);
    const pending = body.state?.session?.pending;
    const owner = createHmac("sha256", process.env.NORDROUTER_API_KEY || "unconfigured")
      .update(String(body.session?.skill_id || "") + ":" + sessionId).digest("hex");
    const send = (text, messages = oldHistory, job = null) => {
      const result = reply(text, false, messages);
      if (job) {
        result.session_state.pending = job;
        result.response.buttons = [{ title: "Готово?", hide: false }, { title: "Отмена", hide: true }];
      }
      return res.status(200).json(result);
    };
    if (/^(отмена|хватит|стоп)[.!?]?$/i.test(text)) return send("Хорошо. Задай другой вопрос.");
    try {
      const cache = getCache();
      if (pending && /^[a-f0-9-]{36}$/.test(pending.id || "")) {
        if (!Number.isFinite(pending.started) || Date.now() - pending.started > MAX_WAIT_MS) {
          return send("Ожидание ответа завершилось. Задай вопрос заново.");
        }
        const record = await bounded(cache.get("alice-gpt-62f44471:" + pending.id));
        if (!record || record.owner !== owner) return send("Временный ответ уже недоступен. Задай вопрос заново.");
        if (record.status === "done") return send(record.text, record.history);
        if (record.status === "failed") return send(record.text);
        return send("Ответ ещё готовится. Через несколько секунд скажи: готово?", oldHistory, pending);
      }
      if (/^(готово|ответ|продолжай)[.!?]?$/i.test(text)) return send("Сначала задай вопрос.");
      if (!process.env.NORDROUTER_API_KEY?.trim()) return sync(req, res);
      const job = { id: randomUUID(), started: Date.now() };
      const key = "alice-gpt-62f44471:" + job.id;
      await bounded(cache.set(key, { owner, status: "processing" }, { ttl: TTL }));
      const work = (async () => {
        let record;
        try {
          const answer = await ask(text, oldHistory);
          const messages = history([...oldHistory, { role: "user", text }, { role: "model", text: answer }]);
          record = { owner, status: "done", text: answer, history: messages };
        } catch (error) {
          record = { owner, status: "failed", text: errorText(error) };
          console.warn("Background GPT request failed:", error?.name || "Error");
        }
        try { await cache.set(key, record, { ttl: TTL }); }
        catch { console.warn("Could not cache background GPT result"); }
      })();
      waitUntil(work);
      return send("Готовлю ответ. Через несколько секунд скажи: готово?", oldHistory, job);
    } catch {
      return send("Временное хранилище сейчас недоступно. Попробуй позже.");
    }
  };
}
