# 小度网页 SDK：调查结果与实施方案

日期：2026-10-13，Asia/Shanghai。
项目：`/Users/yingqing/Workspace/my-home-tool`，Bun + TypeScript。
目标：将自己账号下的官方网页操作封装为 AI agent 可调用的 SDK。
状态：用户已于 2026-10-13 明确确认实施；第一版完成情况见 [实施报告](./sdk-implementation.md)。以下正文保留方案交付时的调查结果与范围，历史的“待确认/未实施”表述按该时间点理解。

## 1. 结论与证据

**可以直接做 HTTP SDK。当前设备列表接口已由独立 Bun 进程实测成功，运行时不必依赖安卓、容器或浏览器。**

调查入口：[已登录的小度智能家居网页](https://xiaodu.baidu.com/saiya/smarthome/index.html#/)。使用 Kimi WebBridge 查看当前 Chrome 标签页、捕获请求、打开设备详情；Browser 插件在初始化时因本地原生模块签名错误不可用，未修改插件或系统设置。

独立请求结果见 [HTTP 验证记录](./evidence/http-verification.json)：

- 不带 Cookie：HTTP 200，业务 `status: 2`，`msg: "not login"`。
- 使用浏览器完整 Cookie：HTTP 200，业务 `status: 0`。
- Cookie 只保留 `BDUSS`：HTTP 200，业务 `status: 0`。
- 最小请求只保留 `Content-Type`、`Cookie: BDUSS=…` 和业务 JSON：HTTP 200，业务 `status: 0`；不发送 Origin、Referer、浏览器 User-Agent、`x_bd_logid` 或额外签名头，并移除前端的 `enableCancelToken` 字段。
- 成功返回 1 台音箱、1 台空调，以及房间、能力和场景数据。

以上证明只覆盖此次账号会话的设备列表读取；不证明控制接口具有相同认证要求，也未验证凭据长期有效性。

### 设备事实

- 音箱：`小度1s`，产品为“小度音箱1S遥控版”，在线。
- 空调：`格力空调`，接入类型为 `__speaker_ir__`，描述为“小度音箱红外遥控器”。它在此次小度接入中通过音箱发射红外命令。
- 服务端声明支持开关、设置/增减温度、模式、设置/增减风速和定时开关。
- 制冷/制热温度能力范围为 16–30℃，风速为 0–3；除湿风速限定为 1。SDK 必须从设备能力读取范围，不能使用通用状态结构中的 0–60 范围作为实际控制边界。
- 返回的房间 `sceneCount` 为 0，四个默认场景的 `isSet` 均为 0；目前没有可用于测试播报的已配置场景。

**红外状态需要标注可信程度。**网页代码在控制后会更新本地显示，红外命令成功下发不能证明空调接收或执行；应返回“命令已接受”和“平台记录状态”，避免将平台记录表述为物理设备确认。

## 2. 已观察到的 HTTP 接口

以下请求通过页面正常加载或打开详情产生，未执行设备控制。

### 2.1 设备列表：已独立复现

`POST https://xiaodu.baidu.com/saiya/smarthome/appliance`

```json
{
  "method": "GET_USER_ALL_APPLIANCES",
  "params": {
    "from": "h5_control",
    "withscene": 1,
    "generalscene": 3,
    "version": "2.0"
  }
}
```

响应为 `{ status, msg, data, logId }`。`data` 包含 `client`（音箱）、`appliances`（家电）、`sceneInfos`、`groupInfo` 等。

前端还保留 `GET /saiya/smarthome/devicelist?from=h5_control&withscene=1&generalscene=3`，设备详情加载时仍观察到该请求。第一版优先封装当前首页实际使用的 `appliance` 接口。

`reqSign` 在前端用于比较设备列表是否变化；它出现在响应里，不是这次设备列表请求必须发送的认证签名。

### 2.2 房间：已抓包，尚未独立复现

`GET /saiya/smarthome/groupsystem?from=H5&method=GROUP_INFO`

返回楼层与房间列表。SDK 可以先使用设备列表内的 `groupInfo`，需要完整楼层/房间信息时再调用该接口。

### 2.3 家庭：已抓包，尚未独立复现

`POST /saiya/smarthome/multihouse`

请求：`{ "method": "HOUSE_LIST", "params": { "entityId": "", "entityType": "" } }`。

### 2.4 音箱绑定设备：已抓包，尚未独立复现

`POST /saiya/smarthome/config`

请求：`{ "method": "GET_CLIENT_DETAILS", "params": { "clientId": "<音箱标识>", "version": 1, "from": "h5" } }`。

返回音箱绑定的红外家电及遥控能力；该接口不能据此推断为音箱播放或音量控制接口。

### 2.5 场景关联：只读请求已抓包

`POST /saiya/smarthome/unified`

请求方法为 `applianceRelateScenes`，参数包含 `applianceId`、`botId`、`h5TileFormate`。此次响应为 `status: 0`，`data: {}`。

## 3. 从当前网页代码找到的控制协议

证据见 [源代码摘录与 SHA-256](./evidence/source-notes.json)。摘录来自网页实际加载的公开脚本，不含账号凭据。

- [主脚本 app.486002113147c370.js](https://duer.bdstatic.com/saiya/smarthome/js/app.486002113147c370.js)
- [空调面板 5116.4492c33081c28474.js](https://duer.bdstatic.com/saiya/smarthome/js/5116.4492c33081c28474.js)
- [空调按键映射 87331.f6f3535f865528dd.js](https://duer.bdstatic.com/saiya/smarthome/js/87331.f6f3535f865528dd.js)

### 3.1 家电控制：协议位置已找到，尚未实机执行

发送目标为 `POST /saiya/smarthome/directivesend?from=h5_control`。

前端组装 `header.namespace = "DuerOS.ConnectedHome.Control"`、`header.name`、`header.payloadVersion` 和 `payload`。空调详情面板指定 `payloadVersion: 1`，最终负载包含设备标识和 `appliance.applianceId` 数组。

按键映射包含：

- 开/关：`TurnOnRequest` / `TurnOffRequest`。
- 模式：`SetModeRequest`，面板传入 `mode: { value: "COOL" }` 等。
- 温度增/减：`IncrementTemperatureRequest` / `DecrementTemperatureRequest`。
- 风速增/减：`IncrementFanSpeedRequest` / `DecrementFanSpeedRequest`。

服务端能力列表还声明 `setTemperature`、`setFanSpeed`，但本轮没有捕获其实际请求；不能把“能力被声明”写成“绝对值设置已验证”。第一版先实现能对应当前按键的操作，绝对值设置需补充证据。

### 3.2 场景与播报：代码支持，账号下尚无验证场景

主脚本仍包含 `/saiya/smarthome/unified` 的 `generalScenes`、`createScene`、`updateScene` 封装，并在执行场景时使用服务端提供的 `sceneParams.method` 与 `sceneId`。

代码定义 `broadcastTTS`（小度回复语）、`customQuery`（自定义指令）、`customAudio`（自定义录音）等场景块。

因此，TTS 可以作为后续验证方向：专用场景写入播报文本，再执行该场景。但当前账号没有已配置场景，创建场景、播报和指令执行均未测试。不能承诺当前账号已经具备可用的 `speak()`。

### 3.3 本页的能力边界

本页观察到的音箱详情主要展示位置、产品信息和绑定家电，未发现已验证的音乐播放、音量控制接口。第一版不会凭借其他设备或旧帖接口猜出这些方法。

## 4. 拟实施的 SDK 范围与文件

本节是待确认的核心开发方案；文件目前尚未创建。

基础配置对应已存在的 [package.json](../package.json)、[tsconfig.json](../tsconfig.json) 与 [项目说明](../README.md)。

拟新增：

- `src/xiaodu/transport.ts`：限定小度固定域名的 HTTP 传输；从显式配置读取 BDUSS；超时、禁止跟随跨域重定向；解析 HTTP 与业务状态；日志不输出 Cookie。
- `src/xiaodu/types.ts`：定义音箱、家电、房间、能力范围、平台记录状态和业务错误；保留未映射的原始字段用于追踪协议变化。
- `src/xiaodu/client.ts`：设备快照、音箱/家电/房间列表、音箱绑定设备读取；以稳定标识选择设备，名称只用于展示或唯一匹配。
- `src/xiaodu/air-conditioner.ts`：封装已找到的开关、模式、温度增减和风速增减；验证设备能力与参数；返回接受状态而非物理执行保证。
- `src/xiaodu/scenes.ts`：先读取场景；在拿到实际场景结构后实现执行。TTS 需单独创建并验证专用场景，避免修改用户现有场景。
- `src/index.ts`：SDK 导出。
- `src/cli.ts`：JSON 输出的 Bun CLI，便于 agent 调用；先提供只读命令，后按验证结果加入控制命令。
- `tests/xiaodu.test.ts`、`tests/fixtures/`：基于脱敏样本验证认证错误、协议解析、能力边界和控制请求组装；测试默认不访问设备。
- `.env.example`：只包含配置项名称及空值。
- `.local/session.json`：若确认后需要保存运行凭据，使用本地私有文件；已被 `.gitignore` 排除，权限为 0600。

建议公共方法按已验证能力逐步增加：

```ts
client.getSnapshot()
client.listSpeakers()
client.listAppliances()
client.listRooms()
client.getSpeakerBindings(clientId)
client.airConditioner(applianceId).turnOn()
client.airConditioner(applianceId).turnOff()
client.airConditioner(applianceId).setMode("COOL")
client.airConditioner(applianceId).increaseTemperature()
client.airConditioner(applianceId).decreaseTemperature()
client.airConditioner(applianceId).increaseFanSpeed()
client.airConditioner(applianceId).decreaseFanSpeed()
```

这是接口草案，不是已实现的调用示例。场景执行、TTS 和绝对值温度/风速设置将在补齐证据后加入。

## 5. 行为变化、取舍和影响

- 开发完成后，agent 可以调用 Bun CLI 或直接导入 TS SDK；正常查询不再需要浏览器运行。
- 使用自己的当前 BDUSS 会话，不自动处理百度密码、验证码或登录刷新；认证失效时返回明确错误，用户重新登录后更新凭据。
- 必须检查业务 `status`；HTTP 200 不代表成功，本轮未登录请求就是实例。
- 写请求不自动重试。超时后结果可能未知，自动重试温度/风速增减会造成重复操作。
- 优先单设备明确操作，暂不提供任意 URL、任意后台方法或场景脚本的透传入口。
- 红外平台状态附带来源与采样时间；不会显示成实测温度或确认接收状态。
- 多家庭列表可以读取，但切换家庭和跨家庭控制尚未验证，第一版不能声称全面支持。
- 先交付 SDK 和 JSON CLI。MCP server 是可选后续适配层，不属于本轮方案。

## 6. 验证顺序与实机边界

1. 本地类型检查和有意义的协议测试：业务未登录、异常响应、超时、能力范围、请求字段、写入不重试。
2. 使用当前会话进行只读集成验证：设备、音箱、房间、绑定设备读取；对照网页和已保存的脱敏样本。
3. 控制方法先使用 mock 检查准确请求体；实机控制需明确目标设备、操作与测试时机。
4. 场景执行和播报需要专用测试场景；仅在明确授权创建和执行后验证。
5. 每个方法在说明中标注“只读实测”“请求组装验证”或“实机验证”，不混淆验证层级。

## 7. 本轮已完成的修改和检查

- 初始化独立目录和 Git `main` 分支。
- Bun 1.3.14 初始化 TypeScript 工程，安装 `@types/bun`、TypeScript 并生成 `bun.lock`。
- 保留 Bun 生成的 TypeScript 配置注释；加入 `start`、`typecheck` 脚本。
- 删除本次初始化自动生成的 `.cursor/rules` 模板文件，避免保留额外规则体系；未改动工作区根规则。
- `.gitignore` 排除 `.env*`、`.local/`，允许未来的空值 `.env.example`。
- `index.ts` 明确输出“SDK 尚处于接口调查阶段”；README 记录当前状态。
- `bun run start`：通过。
- `bun run typecheck`：通过。
- 独立 Bun 只读请求验证：带 Cookie/BDUSS 的三种配置均成功，不带 Cookie 的负向用例正确返回未登录。

本轮没有开启/关闭空调，没有修改温度、模式或风速，没有执行/创建/修改场景，没有修改设备名称、绑定或定时任务。原始抓包含登录凭据，仅存放于被忽略的 `.local/` 私有目录；脱敏证据可纳入 Git。

核心 SDK 未实施。按用户提供的工作区约定第 5、6 条，需先审阅并明确确认本方案；确认实现代码不自动授权实机控制或创建场景。
