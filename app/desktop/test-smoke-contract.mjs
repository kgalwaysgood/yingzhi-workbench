import assert from 'node:assert/strict';
import test from 'node:test';
import { assertWorkbenchSmokeIntegrity } from './smoke-contract.mjs';

test('accepts an unchanged credential set with released task lock', () => {
  assert.doesNotThrow(() => assertWorkbenchSmokeIntegrity({
    credentialsUnchanged: true,
    taskLockReleased: true,
  }));
});

test('rejects changed credentials instead of printing a false PASS', () => {
  assert.throws(
    () => assertWorkbenchSmokeIntegrity({ credentialsUnchanged: false, taskLockReleased: true }),
    /修改了登录凭据/,
  );
});

test('rejects an unreleased task lock instead of printing a false PASS', () => {
  assert.throws(
    () => assertWorkbenchSmokeIntegrity({ credentialsUnchanged: true, taskLockReleased: false }),
    /任务锁未释放/,
  );
});
