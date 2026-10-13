# 场景与 TTS 扩展实施报告

日期：2026-10-13，Asia/Shanghai。
依据：继续实施用户已确认的原方案中场景执行与专用 TTS 场景部分；用户随后明确授权创建“my-home-tool播报”并在“小度1s”上测试指定文字，表示当前无人可听到。

## 调查证据

- 当前网页的场景页通过 `POST /saiya/smarthome/unified`、`generalScenes` 获取目录；当前账号的 `myScenes`、`thirdPartyScenes` 均为空，推荐场景为 23 个。
- 创建编辑页实际调用 `getRecommendScene`（`sceneType: CUSTOM`）和 `getSceneAppliances`。
- `getSceneAppliances` 明确返回“小度1s”的 `supportAbility.broadcastTTS: true`、`customQuery: true`，全局场景能力也开启这些功能。
- 回复语 textarea 的 `maxlength` 为 300；页面默认 `volume: -1` 为系统音量。
- 当前网页源码的 `completeScene` 将用户场景结构组合后提交 `createScene` 或 `updateScene`；回复语组件只先更新页面内的草稿，不调用创建接口。
- 调查阶段先准备了文字为“my-home-tool 播报测试成功。”的未保存页面草稿；取得明确授权后通过 SDK 创建专用场景、更新文字并触发。

公开源码：[场景编辑](https://duer.bdstatic.com/saiya/smarthome/js/40805.ba50057edfb31e5f.js)、[回复语与音量配置](https://duer.bdstatic.com/saiya/smarthome/js/25721.12c0f2b10fbe4976.js)。脱敏集成记录与创建预览见 [scenes-integration-2026-10-13.json](./evidence/scenes-integration-2026-10-13.json)。

## 实际修改与原因

- [scenes.ts](../src/xiaodu/scenes.ts)：保留原首页解析函数；新增完整目录、能力与详情查询；提供已保存场景执行、专用 TTS 场景创建、文本更新后触发及预览。按服务器提供的 triggerScene 协议执行，拒绝任意后台方法透传。
- [scene-lock.ts](../src/xiaodu/scene-lock.ts)：通过独占创建的私有锁文件保护跨 CLI 进程的更新/触发顺序；ID 与名称最终归一到同一 sceneId。锁占用时拒绝请求，不删除其他持有者的锁。
- [client.ts](../src/xiaodu/client.ts)、[types.ts](../src/xiaodu/types.ts)、[入口](../src/index.ts)：新增场景公共方法、预览与提交类型、锁目录配置；现有查询与空调方法保留。
- [normalize.ts](../src/xiaodu/normalize.ts)：兼容场景能力接口的 `onlineStatus` 字段，原设备列表的 `online_status` 保留。
- [transport.ts](../src/xiaodu/transport.ts)：增加固定的 unified 路径与场景错误码，错误可注明 update/trigger 阶段；仍不跟随重定向、不重试写入。
- [cli.ts](../src/cli.ts)：新增 `scene-catalog`、`scene-capabilities`、`scene-detail`、`scene-run`、`speech-scene`、`say`，所有写能力均提供 `--dry-run`。
- [场景测试](../tests/scenes.test.ts)：加入字段解析、文本限制、拒绝覆盖、协议组装、错误阶段、独立客户端共享锁等测试。
- 版本为 `0.2.0`；保留已发布的 `v0.1.0`、`v0.1.1` tag。

## 关键行为变化

- 原 `listScenes()` 仍返回首页场景，不改变已有调用方；`getSceneCatalog()` 新增完整目录，区分已保存、第三方与推荐场景。
- 创建方法只创建以 `my-home-tool` 开头的专用单 TTS 场景；同名存在时拒绝，不覆盖用户数据。
- 播报方法只更新目标匹配、仅一个 TTS 动作且无自动条件的专用场景；不会借播报修改空调或其他硬件动作。
- 预览仅调用只读接口并返回请求。实际 `speak` 顺序为更新场景、触发场景；更新失败时不触发，触发失败时不重试、不回滚已保存文本。
- 成功提交返回 `physicalStateVerified: false`，不宣称已听见播报或硬件完成执行。

## 验证结果

- 类型检查通过。
- 49 项测试通过，0 失败；全部使用 mock 或本地样本，新增真实响应缺少顶层 clientId 的回归用例。
- SDK 当前会话只读集成通过：完整目录、音箱能力、CUSTOM 模板读取和创建请求预览。
- CLI `speech-scene ... --dry-run` 返回成功 JSON。
- 前置 SDK 集成验证使用只读方法白名单阻止意外写入；这一阶段真实 create/update/trigger 请求发送数量为 0。
- 后续授权测试分别发送 1 次 createScene、updateScene、triggerScene；三个接口均 HTTP 200、业务 status 0，触发响应 desc 为“已执行”。
- 场景回读文字、目标音箱和单 TTS 动作匹配；实际声音尚未由人确认。证据见 [scenes-live-test-2026-10-13.json](./evidence/scenes-live-test-2026-10-13.json)。

## 尚未覆盖

实际场景创建、保存、sceneId/详情结构、更新受理、触发受理和回读均已验证；实际发声没有人在设备旁确认。首次读取真实详情时发现服务端省略顶层 clientId，初版保守校验拒绝了播报且未发送写请求；随后改为核对 TTS 块内显式的 cuid/clientId，并在更新负载中补回顶层字段。新增回归测试后，在同一场景上完成更新和一次触发，没有重复创建。

`customQuery` 目前仅完成能力确认，执行封装尚未加入；独立音量、音乐播放、绝对值温度/风速和跨家庭控制仍没有完整协议证据。跨进程锁保护提交阶段，音箱播放完成的确认仍需人听到或其他可观测反馈。

## 已授权并完成的服务端测试

在当前百度账号中新建专用场景 **my-home-tool播报**，目标为大卧室的 **小度1s**，正文 **my-home-tool 播报测试成功。**，音量沿用系统设置。创建后读取结果、执行一次，并读取可观察的受理结果；不触发空调、不修改其他场景、不自动删除场景。

用户已明确同意本次测试。账号中保留一个专用场景，未自动删除；仅提交了上述指定内容，未操作空调或其他场景。设备是否实际发声仍未确认。
