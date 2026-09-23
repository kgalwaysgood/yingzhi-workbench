import test from 'node:test';
import assert from 'node:assert/strict';
import { explainModelConnectionFailure, generateWithLocalModel, localModelServerArgs, localModelSettings, readModelContent } from './local-model-provider.mjs';

test('only a loopback HTTP model endpoint is accepted', () => {
  for (const endpoint of ['https://example.com', 'http://192.168.1.1:8080', 'https://localhost:8080']) {
    assert.throws(() => localModelSettings('D:\\local', { DOUYIN_LOCAL_LLM_URL: endpoint }), /本机 HTTP/);
  }
  assert.equal(localModelSettings('D:\\local', { DOUYIN_LOCAL_LLM_URL: 'http://127.0.0.1:8080' }).endpoint, 'http://127.0.0.1:8080');
});

test('local knowledge generation sends JSON schema without a cloud key', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'string' } } };
  let called = 0;
  const request = async (url, options) => {
    called++;
    assert.equal(url, 'http://127.0.0.1:8080/v1/chat/completions');
    assert.ok(!('Authorization' in options.headers));
    const body = JSON.parse(options.body);
    assert.deepEqual(body.response_format, {
      type: 'json_schema',
      json_schema: { name: 'knowledge_summary', strict: true, schema },
    });
    assert.equal(body.max_tokens, 2048);
    assert.equal(body.stream, true);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"answer":"本地总结"}' } }] }) };
  };
  const result = await generateWithLocalModel('文字稿', schema, 'D:\\local', {
    env: { DOUYIN_LOCAL_LLM_URL: 'http://127.0.0.1:8080', DOUYIN_MODEL_API_KEY: 'ignored' }, request,
  });
  assert.equal(called, 1);
  assert.deepEqual(result, { answer: '本地总结' });
});

test('streaming model response is joined before JSON validation', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"{\\"answer\\":"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"\\"本地总结\\"}"}}]}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
  assert.equal(await readModelContent({ body }), '{"answer":"本地总结"}');
});

test('short planning calls can disable long reasoning and cap output', async () => {
  const request = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 384);
    assert.match(body.messages[1].content, /^\/no_think/);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"keywords":["MES"],"facets":["实施"]}' } }] }) };
  };
  const result = await generateWithLocalModel('生成关键词', {}, 'D:\\local', {
    env: { DOUYIN_LOCAL_LLM_URL: 'http://127.0.0.1:8080' }, request, maxTokens: 384, disableThinking: true,
  });
  assert.equal(result.keywords[0], 'MES');
});

test('missing local executable fails closed instead of contacting cloud', async () => {
  await assert.rejects(generateWithLocalModel('文字稿', {}, 'D:\\missing-local-runtime', { env: {} }), /缺少本地总结程序/);
});

test('unexpected local model exit has a Chinese actionable diagnosis', () => {
  const issue = explainModelConnectionFailure(new TypeError('fetch failed'), {
    child: { exitCode: 3 }, tail: 'fatal: insufficient memory', logPath: 'D:\\local\\tmp\\local-model-server.log',
  });
  assert.match(issue, /进程意外退出/);
  assert.match(issue, /可用内存不足/);
  assert.match(issue, /退出码 3/);
  assert.match(issue, /local-model-server\.log/);
});

test('desktop local model uses one inference slot to avoid fourfold memory allocation', () => {
  const args = localModelServerArgs({ model: 'model.gguf', modelName: 'local-knowledge' }, 8080);
  assert.deepEqual(args.slice(args.indexOf('--parallel'), args.indexOf('--parallel') + 2), ['--parallel', '1']);
  assert.deepEqual(args.slice(args.indexOf('--ctx-size'), args.indexOf('--ctx-size') + 2), ['--ctx-size', '6144']);
});
