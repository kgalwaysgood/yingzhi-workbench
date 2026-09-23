"""The user should see an explanation, not a raw exception."""

import unittest

from errors import explain_error, job_failure_message


class ErrorMessagesTest(unittest.TestCase):
    def test_douyin_verification_is_actionable(self):
        issue = explain_error("弹出的抖音浏览器仍停在验证码页面")
        self.assertEqual(issue.code, "DOUYIN-003")
        self.assertIn("打开验证窗口并重试", issue.action)
        self.assertIn("不会自动", issue.action)

    def test_terminated_maintenance_task_is_explained(self):
        issue = explain_error("terminated")
        self.assertEqual(issue.code, "TASK-002")
        self.assertIn("高耗时", issue.title)

    def test_empty_or_expired_account_is_auth_not_input_error(self):
        for text in ("抖音登录信息为空，请先执行菜单 1", "抖音登录信息已失效或未在此浏览器生效，请先执行菜单 1"):
            self.assertEqual(explain_error(text).code, "AUTH-001")

    def test_empty_search_does_not_claim_login_failure(self):
        issue = explain_error("未取得可核对的抖音作品，未生成博主推荐。")
        self.assertEqual(issue.code, "DOUYIN-004")
        self.assertIn("目前不能确定原因", issue.cause)
        self.assertIn("不会自行弹出", issue.action)

    def test_screenshot_permission_error_is_actionable_chinese(self):
        issue = explain_error(
            "EPERM: operation not permitted, open 'D:\\YingzhiWorkbench\\private\\playwright-storage-state.json'"
        )
        self.assertEqual(issue.code, "ENV-001")
        self.assertIn("不需要删除登录信息", issue.action)
        self.assertNotIn("EPERM", issue.format())

    def test_expired_short_link_explains_full_profile_url(self):
        issue = explain_error("分享短链接跳转到了抖音首页，可能已过期或被重定向。")
        self.assertEqual(issue.code, "LINK-001")
        self.assertIn("www.douyin.com/user/", issue.action)

    def test_network_and_missing_runtime_have_distinct_actions(self):
        self.assertEqual(explain_error("ETIMEDOUT: connect failed").code, "NET-001")
        self.assertEqual(explain_error("Node runtime is missing from the application package").code, "ENV-004")
        self.assertEqual(explain_error("请求校验失败").code, "SESSION-001")
        self.assertEqual(explain_error("请选择博主主页").code, "INPUT-001")

    def test_subprocess_log_can_explain_generic_exit_code(self):
        job = {"error": "处理程序退出码 2，请查看任务日志", "logs": ["链接准备失败：登录信息可能过期\n"]}
        self.assertIn("登录信息可能过期", job_failure_message(job))
        self.assertEqual(explain_error(job_failure_message(job)).code, "DOUYIN-001")

    def test_unknown_error_still_has_chinese_reason_and_next_action(self):
        issue = explain_error("unexpected state")
        self.assertEqual(issue.code, "TASK-999")
        self.assertIn("可能原因", issue.format())
        self.assertIn("你可以这样做", issue.format())


if __name__ == "__main__":
    unittest.main()
