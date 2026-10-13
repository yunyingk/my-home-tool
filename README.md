# my-home-tool

用 Bun + TypeScript 封装个人智能家居工具，供 AI agent 调用。

当前状态：第一版 SDK 与 JSON CLI 已实现。只读查询通过当前账号的集成验证；空调控制通过请求组装测试和 dry-run，尚未进行实机控制验证。

运行时直接请求小度服务，使用自己的 BDUSS 会话；无需安卓、容器或浏览器常驻。

- [已确认的调查结果与 SDK 实施方案](docs/xiaodu-sdk-proposal.md)
- [第一版实施报告](docs/sdk-implementation.md)
- [只读 HTTP 验证记录](docs/evidence/http-verification.json)
- [脱敏请求样本](docs/evidence/observed-requests.json)
- [网页脚本证据](docs/evidence/source-notes.json)
- [SDK 和 CLI 的只读集成验证](docs/evidence/sdk-integration-2026-10-13.json)

安装依赖：

```bash
bun install
```

运行 CLI 帮助：

```bash
bun run cli --help
```

类型检查：

```bash
bun run typecheck
bun test
```

使用 Bun 管理依赖，锁文件为 `bun.lock`。
登录凭据和原始抓包只保存在被 Git 忽略的 `.local/` 或 `.env`，不写入源码、报告或提交。

## 认证

当前机器已经配置 `.local/session.json`，文件权限为 0600，已被 Git 忽略。迁移到其他机器时重新配置自己的会话。

CLI 按以下优先级读取 BDUSS：显式 `--session <file>`；否则读取 `XIAODU_BDUSS` 环境变量；最后读取本项目的 `.local/session.json`。

可以将 `.env.example` 复制为 `.env`，填入 `XIAODU_BDUSS` 的值；Bun 会加载 `.env`。值为 BDUSS 的 Cookie 值，不包含 `BDUSS=` 前缀，也不包含其他 Cookie。

本地会话 JSON 的结构为 `{ "bduss": "自己的 BDUSS 值" }`。SDK 不自动登录；会话失效时返回 `AUTHENTICATION_REQUIRED`，重新登录后更新凭据即可。

## CLI

在项目目录执行：

```bash
bun run --silent cli devices
bun run --silent cli speakers
bun run --silent cli appliances
bun run --silent cli rooms
bun run --silent cli houses
bun run --silent cli bindings "小度1s"
bun run --silent cli scenes
bun run --silent cli air "格力空调" mode COOL --dry-run
```

`--silent` 隐藏 Bun 脚本命令提示，便于 agent 直接解析 JSON。也可直接执行 `bun src/cli.ts <command>`。

成功时 stdout 返回 `{ "ok": true, "data": ... }`；失败时 stderr 返回 `{ "ok": false, "error": { "code": ..., "message": ... } }` 并退出 1。`--help` 输出文本帮助，不需要认证。

设备参数优先匹配 ID，其次匹配唯一名称；同名时返回 `AMBIGUOUS_DEVICE`，不会挑选第一台设备。

空调动作：`on`、`off`、`mode <MODE>`、`temp-up`、`temp-down`、`fan-up`、`fan-down`。模式必须在该设备的实际能力列表中。

`--dry-run` 会读取最新平台记录并返回拟发送的请求，不发送控制。去掉该参数会发送实机控制请求；本轮集成验证只使用 dry-run。

## TypeScript SDK

```ts
import { XiaoduClient } from "./src/index.ts";

const bduss = process.env.XIAODU_BDUSS;
if (!bduss) throw new Error("请配置 XIAODU_BDUSS");
const client = new XiaoduClient({ bduss });
const snapshot = await client.getSnapshot();
const air = client.airConditioner("格力空调");
const preview = await air.preview({ action: "turnOff" });
```

只读方法：`getSnapshot()`、`listSpeakers()`、`listAppliances()`、`listRooms()`、`listHouses()`、`getSpeakerBindings(clientIdOrName)`、`listScenes()`。

空调方法：`turnOn()`、`turnOff()`、`setMode(mode)`、`increaseTemperature()`、`decreaseTemperature()`、`increaseFanSpeed()`、`decreaseFanSpeed()`。目前只支持音箱红外空调，传输协议为当前网页面板使用的版本 1。

`preview(command)` 预览请求，`execute(command)` 发送同一组有限动作。它们不提供任意后台接口透传。默认总请求超时为 15 秒，可用 `timeoutMs` 调整。

## 状态与验证边界

- `state.source` 为 `platform-record`，属性携带平台采样时间；`physicalStateVerified` 为 `false`。红外下发成功不能证明空调已经接收或执行。
- 控制返回 `outcome: "accepted"` 表示服务端接受请求；可能附带 `serverStatus` 和 `taskId`，本版不轮询任务完成。
- 请求不自动重试。写入超时或网络错误的 `outcome: "unknown"` 表示结果未知；温度、风速增减不应盲目重复。
- 增减动作依据当前模式的真实能力范围及平台记录校验；模式或状态缺失时拒绝发送。平台记录可能滞后，该校验不是对物理状态的测量。
- `raw` 保留未映射的服务端字段，供协议变化排查；它可能包含账号下的设备标识等私人信息，不宜作为公开日志分享。
- 场景仅提供元数据查询；没有实现场景创建/执行、TTS、音量、音乐播放、绝对值温度/风速设置、多家庭切换或 MCP server。

测试样本根据已脱敏的真实抓包结构整理，设备标识替换为固定测试值。`bun test` 默认不联网、不控制设备。
