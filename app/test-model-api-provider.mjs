import assert from 'node:assert/strict';
import test from 'node:test';
import { generateWithModelApi, modelSettings } from './model-api-provider.mjs';

const env = { DOUYIN_MODEL_PROVIDER: 'qwen', DOUYIN_MODEL_NAME: 'qwen-plus', DOUYIN_MODEL_API_KEY: 'test-secret' };

test('only known HTTPS provider endpoints are accepted', () => {
  assert.equal(modelSettings(env).endpoint, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.throws(() => modelSettings({ ...env, DOUYIN_MODEL_PROVIDER: 'other' }), /仅支持/);
  assert.throws(() => modelSettings({ ...env, DOUYIN_MODEL_API_KEY: '' }), /API Key/);
});

test('calls selected provider without persisting or returning the API key', async () => {
  let requestBody;
  const result = await generateWithModelApi('主题', { type: 'object' }, '', {
    env,
    request: async (url, options) => {
      assert.equal(url, modelSettings(env).endpoint);
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"keywords":["ERP订单"]}' } }] }) };
    },
  });
  assert.deepEqual(result, { keywords: ['ERP订单'] });
  assert.equal(JSON.stringify(requestBody).includes('test-secret'), false);
});

test('does not expose provider error bodies and rejects invalid JSON', async () => {
  await assert.rejects(generateWithModelApi('x', {}, '', { env, request: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
  await assert.rejects(generateWithModelApi('x', {}, '', { env, request: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) }) }), /有效 JSON/);
});
