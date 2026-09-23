export function assertWorkbenchSmokeIntegrity({ credentialsUnchanged, taskLockReleased }) {
  if (!credentialsUnchanged) {
    throw new Error('真实工作台冒烟测试失败：后台任务修改了登录凭据。');
  }
  if (!taskLockReleased) {
    throw new Error('真实工作台冒烟测试失败：任务锁未释放。');
  }
}
