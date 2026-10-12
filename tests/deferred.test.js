import test from "node:test";
import assert from "node:assert/strict";
import { createDeferredHandler } from "../lib/deferred.js";
function fixture(ask = async () => "Четыре.") {
  const records = new Map(), tasks = [];
  let calls = 0;
  const handler = createDeferredHandler({
    getCache: () => ({ get: async k => records.get(k), set: async (k,v) => records.set(k,v) }),
    waitUntil: task => tasks.push(task), ask: async (...args) => { calls++; return ask(...args); },
    sync: (_,res) => res.status(200).json({ greeting: true }),
    reply: (text, end_session, history) => ({ version: "1.0", response: { text, end_session }, session_state: { history } }),
    history: value => Array.isArray(value) ? value : [], errorText: () => "Ошибка модели"
  });
  async function request(command, state = {}, session = "one") {
    let result;
    const res = { status: () => res, json: value => { result = value; return value; } };
    await handler({ method:"POST", body:{ request:{command}, session:{session_id:session,skill_id:"skill"},state:{session:state} } },res);
    return result;
  }
  return { request, tasks, records, calls: () => calls };
}
test("slow model returns pending first and its result on polling without regeneration", async () => {
  process.env.NORDROUTER_API_KEY = "test-only";
  let resolve;
  const f=fixture(() => new Promise(r => {resolve=r;}));
  const first=await f.request("2+2");
  assert.match(first.response.text,/Готовлю/);
  const waiting=await f.request("Готово?",first.session_state);
  assert.equal(waiting.session_state.pending.id,first.session_state.pending.id);
  resolve("Четыре."); await Promise.all(f.tasks);
  const done=await f.request("Готово?",first.session_state);
  assert.equal(done.response.text,"Четыре.");
  assert.equal(done.session_state.pending,undefined);
  assert.equal(done.session_state.history.length,2);
  assert.equal(f.calls(),1);
});
test("cached answers cannot be read from another Alice session",async () => {
  const f=fixture(); const first=await f.request("2+2"); await Promise.all(f.tasks);
  const stolen=await f.request("Готово?",first.session_state,"another");
  assert.match(stolen.response.text,/недоступен/); assert.equal(f.calls(),1);
});
test("lost or expired cache does not repeat a paid generation",async () => {
  const f=fixture(); const first=await f.request("2+2"); await Promise.all(f.tasks); f.records.clear();
  const lost=await f.request("Готово?",first.session_state);
  assert.match(lost.response.text,/недоступен/);
  first.session_state.pending.started=Date.now()-121000;
  assert.match((await f.request("Готово?",first.session_state)).response.text,/завершилось/);
  assert.equal(f.calls(),1);
});
test("background errors become a valid reply and cancellation clears pending",async () => {
  const f=fixture(async () => {throw Error("network");});
  const first=await f.request("2+2"); await Promise.all(f.tasks);
  assert.equal((await f.request("Готово?",first.session_state)).response.text,"Ошибка модели");
  assert.equal((await f.request("Отмена",first.session_state)).session_state.pending,undefined);
  assert.equal(f.calls(),1);
});
