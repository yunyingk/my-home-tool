# 第一版 SDK 实施报告

日期：2026-10-13，Asia/Shanghai。
依据：用户已明确确认 [实施方案](./xiaodu-sdk-proposal.md)。

## 交付结果

已实现 Bun + TypeScript SDK 和 JSON CLI。只读查询通过当前会话实测；空调按键封装完成协议测试和 dry-run，尚未进行实机控制。

开发前只有输出初始化状态的项目骨架。现在可以通过 `bun run --silent cli devices` 获取真实设备列表，或在 TypeScript 中导入 `XiaoduClient`；控制请求预览可用 `air <设备> <动作> --dry-run`。

## 实际文件与修改原因

- [transport.ts](../src/xiaodu/transport.ts)：固定小度域名和有限接口；BDUSS 认证；HTTP/业务错误区分；请求和响应读取共享总超时；不跟随重定向；不重试；凭据不进入错误消息。
- [types.ts](../src/xiaodu/types.ts)：音箱、家电、房间、家庭、场景元数据、模式能力、平台状态及控制提交结果的公共类型。
- [normalize.ts](../src/xiaodu/normalize.ts)：统一处理设备列表和绑定设备接口的 camelCase/snake_case 差异；保留原始字段；解析真实能力和采样时间；按 ID 或唯一名称选择设备。
- [client.ts](../src/xiaodu/client.ts)：设备快照、音箱/家电列表、房间、家庭、音箱绑定设备和场景元数据查询。
- [scenes.ts](../src/xiaodu/scenes.ts)：解析已有场景数据，区分默认未配置场景；不猜测场景执行负载。
- [air-conditioner.ts](../src/xiaodu/air-conditioner.ts)：开关、模式、温度增减、风速增减；发送前获取最新设备数据；校验连接类型、能力、在线状态与范围；提供不发送控制的请求预览。
- [src/index.ts](../src/index.ts) 与 [根 index.ts](../index.ts)：SDK 导出；根入口兼容直接运行 CLI。
- [cli.ts](../src/cli.ts)：解析有限命令和认证来源，输出 JSON，错误退出 1；名称歧义直接报错；支持 `--dry-run`。
- [package.json](../package.json)：增加 SDK 导出和 `cli`、`test` 脚本，启动入口改为 CLI；无新增运行时依赖。
- [.env.example](../.env.example)：空值配置项。现有 `.gitignore` 已排除实际 `.env` 和 `.local/`，未扩大规则改动。
- [tests/xiaodu.test.ts](../tests/xiaodu.test.ts) 与 [测试样本](../tests/fixtures/snapshot.json)：协议解析、认证与错误、超时、设备选择、控制组装、能力边界和 CLI 进程契约。
- [README](../README.md)：真实使用方式、会话来源、错误行为和验证边界；保留原调查证据链接。

本机已从上轮私有抓包中提取当前 BDUSS，配置到被忽略的 `.local/session.json`，文件权限为 0600；未将凭据写入源码、报告或提交。

## 关键行为

- HTTP 200 但业务 `status: 2` 会返回 `AUTHENTICATION_REQUIRED`，而不会被当成成功。
- 读取结果同时提供规范化字段与 `raw`，未知字段不会丢失。
- “格力空调”的通用状态范围虽为 0–60，本版增减温度使用实际模式能力的 16–30℃；平台记录已为 30℃ 时，温度增加返回 `OUT_OF_RANGE`。
- 除湿模式风速能力固定为 1 时，增减风速均被拒绝；能力或当前值缺失时返回 `UNAVAILABLE_STATE`。
- 同名设备会返回 `AMBIGUOUS_DEVICE`；不会静默选择第一台。
- 控制请求包含当前网页面板的 namespace、指令名称、`payloadVersion: 1`、设备 ID 和 `appliance.applianceId` 数组。
- `status: 0` 但 `data.status: "FAILED"` 的控制响应仍会报 `COMMAND_REJECTED`。
- 服务端接受的控制返回 `outcome: "accepted"` 和 `physicalStateVerified: false`；网络失败或超时返回结果未知，不自动重试。

## 已执行验证

- `bun run typecheck`：通过。
- `bun test`：33 项通过、0 项失败，100 次断言；全部使用本地样本或 mock，无设备控制。
- `bun run cli --help`：成功，不依赖认证。
- `bun run --silent cli --session tests/fixtures/invalid-session.json devices`：预期退出 1，stderr 返回结构化 `INVALID_CONFIGURATION`。
- 当前会话 SDK 集成验证：设备快照、房间、家庭、音箱绑定设备均成功；读到 1 台音箱、1 台空调、3 个房间、1 个家庭、1 个绑定设备。
- 当前会话 CLI 集成验证：`devices` 返回成功 JSON；`air <设备ID> mode COOL --dry-run` 返回请求预览。
- SDK 集成验证使用只读操作白名单阻断意外写入；控制请求发送数量为 0。CLI dry-run 的不写入行为另由 mock 测试覆盖。

可复查的脱敏结果：[sdk-integration-2026-10-13.json](./evidence/sdk-integration-2026-10-13.json)。

## 与已确认方案的差异

- 增加内部 `normalize.ts`，集中处理两种字段命名；这是方案中类型解析的实现拆分，未扩大业务范围。
- 为控制方法增加 `preview()` 和 CLI `--dry-run`，用于在没有实机动作授权时验证请求。
- 场景模块目前只查询元数据。当前 4 个默认场景均未配置，未补齐执行与 TTS 的实机证据；保持原方案“补齐证据后加入”的边界。
- 家庭列表读取已实现并实测，但不切换家庭或进行跨家庭控制。

## 未覆盖与复查重点

1. **空调控制尚未实机验证**：请求结构依据当前公开网页代码，实际服务端接受及空调响应仍需在指定动作和时机下测试。
2. **平台记录不等于设备反馈**：SDK 的范围校验依赖平台记录，其采样时间可能较旧；红外控制结果不可表述为设备确认。
3. **只支持音箱红外空调**：其他协议、绝对值温度/风速设置、场景执行、TTS、音量和音乐播放均未实现。
4. **会话长期有效性未验证**：认证过期需用户重新登录并更新 BDUSS，无自动登录刷新。
5. **未轮询控制任务完成**：保留 taskId/serverStatus，但提交成功不表示最终执行完成。
6. **没有新增 MCP server**：agent 当前可通过 JSON CLI 或 SDK 调用。

本轮没有开启/关闭空调、修改温度/模式/风速，也没有创建或执行场景、修改设备绑定或定时任务。
