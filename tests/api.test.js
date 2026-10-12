import test from "node:test";
import assert from "node:assert/strict";
import handler, { aliceResponse, fitAliceText, isSearchIntent, safeHistory } from "../api/index.js";
async function request(command, history = [], method = "POST") {
  let result;
  const res = { status(code) { assert.equal(code, 200); return this; }, json(value) { result = value; } };
  await handler({ method, body: { request: { command }, state: { session: { history } } } }, res);
  return result;
}
test("Alice response envelope", () => {
  const result = aliceResponse("Привет", false, []);
  assert.equal(result.version, "1.0"); assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false); assert.deepEqual(result.session_state.history, []);
});
test("search intent in Russian and English", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
});
test("Alice response length and sentence boundary", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024); assert.ok(value.endsWith("."));
});
test("history filtering and size", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 8); assert.equal(result[0].text, "4"); assert.equal(result[7].text, "11");
});
test("health check identifies NordRouter and exact GPT model", async () => {
  const result = await request("", [], "GET");
  assert.equal(result.ok, true); assert.equal(result.service, "alice-nordrouter-gpt");
  assert.equal(result.model, "openai/gpt-6.1-sol");
});
test("launch greeting without external keys", async () => {
  const result = await request("");
  assert.equal(result.version, "1.0"); assert.match(result.response.text, /Привет/);
});
test("GPT request uses NordRouter auth, model and conversation history", async (t) => {
  const old = process.env.NORDROUTER_API_KEY;
  process.env.NORDROUTER_API_KEY = "test-key";
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://global-api.nordrouter.com/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "openai/gpt-6.1-sol"); assert.equal(body.messages[0].role, "system");
    assert.deepEqual(body.messages.slice(1), [{ role: "assistant", content: "Привет" }, { role: "user", content: "Два плюс два?" }]);
    assert.equal(body.stream, false);
    return new Response(JSON.stringify({ choices: [{ message: { content: "Четыре." } }] }));
  });
  try {
    const result = await request("Два плюс два?", [{ role: "model", text: "Привет" }]);
    assert.equal(result.response.text, "Четыре."); assert.equal(result.session_state.history.at(-1).text, "Четыре.");
  } finally { if (old === undefined) delete process.env.NORDROUTER_API_KEY; else process.env.NORDROUTER_API_KEY = old; }
});
test("missing key, rejected key, empty response and timeout return valid Alice replies", async (t) => {
  const old = process.env.NORDROUTER_API_KEY;
  try {
    delete process.env.NORDROUTER_API_KEY;
    assert.match((await request("Привет")).response.text, /NORDROUTER_API_KEY/);
    process.env.NORDROUTER_API_KEY = "test-key";
    const mock = t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 401 }));
    assert.match((await request("Привет")).response.text, /API-ключ/);
    mock.mock.mockImplementation(async () => new Response('{"choices":[]}'));
    assert.match((await request("Привет")).response.text, /Не получилось/);
    mock.mock.mockImplementation(async () => { throw new DOMException("Aborted", "AbortError"); });
    const result = await request("Привет"); assert.equal(result.version, "1.0"); assert.match(result.response.text, /Не успела/);
  } finally { if (old === undefined) delete process.env.NORDROUTER_API_KEY; else process.env.NORDROUTER_API_KEY = old; }
});
