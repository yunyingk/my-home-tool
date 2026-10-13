# my-home-tool

用 Bun + TypeScript 封装个人智能家居工具，供 AI agent 调用。

当前状态：Git 和项目骨架已初始化；小度网页接口正在进行只读调查，尚未实现 SDK。

调查结论：独立 Bun 进程已使用当前账号的 BDUSS 成功读取设备列表。控制接口仅完成网页代码定位，尚未发送实机控制请求。

- [调查结果与待确认的 SDK 实施方案](docs/xiaodu-sdk-proposal.md)
- [只读 HTTP 验证记录](docs/evidence/http-verification.json)
- [脱敏请求样本](docs/evidence/observed-requests.json)
- [网页脚本证据](docs/evidence/source-notes.json)

安装依赖：

```bash
bun install
```

运行骨架：

```bash
bun run start
```

类型检查：

```bash
bun run typecheck
```

使用 Bun 管理依赖，锁文件为 `bun.lock`。
登录凭据和原始抓包只保存在被 Git 忽略的 `.local/` 或 `.env`，不写入源码、报告或提交。
