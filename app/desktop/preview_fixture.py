"""Isolated native layout fixture. No network, credentials or user files."""
from unittest import mock
from app import WorkbenchApp
from test_app import FakeClient


if __name__ == "__main__":
    def immediate(app, operation, done=None):
        result = operation()
        if done:
            done(result)
    with mock.patch.object(WorkbenchApp, "_async", immediate):
        window = WorkbenchApp(FakeClient())
    window.title("影知工坊 · UI 隔离核验（示例数据）")
    titles = ["ERP 订单到交付：先理清哪些数据？", "工厂上 MES 前，先梳理这三个流程", "为什么排产总在变？理解计划与现场反馈", "完工报工、入库和交付，应该如何衔接"]
    for index, row in enumerate(window.state_data["prepared"]["works"]):
        row["title"] = "制造数字化：" + titles[index % len(titles)] + " #MES #ERP #制造业 #工厂管理"
    window.show_step(2)
    window.after(300000, window.destroy)
    window.mainloop()
