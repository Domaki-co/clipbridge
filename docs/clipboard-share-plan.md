# 剪贴板共享(常驻频道)方案 · ClipBridge 文桥

> 目标(用户原话):「新加一个粘贴板共享的功能是否可行,给出方案。不想每次手机 PC 输入码获取文件,原有功能保持不变。」
> 本文是可行性判断与方案设计的原始记录(写于实现之前)。
>
> **实现状态(2026-10-09)**:方案 A 已按本文落地并发布为 **v1.2.0** —— `/c` 配对页、`/c/:code` 房间、`/api/channel`(创建/发送)、`/api/channel/:code`(轮询/销毁)、`/c/:code/e/:id`(正文与文件);KV 键前缀 `c:`,原有 `t:` 取件码链路一行未改。测试见 `tests/channel.mjs`(25 项)与 README 的测试章节;方案 B/C/D 仍是可选的后续阶段。

## 0. 结论(先说能不能)

| 目标 | 可行性 | 原因 |
| --- | --- | --- |
| 配对一次后,**之后不再输任何码** | ✅ 完全可行 | 把「一次性取件码」换成「常驻频道码」,两端各存一次 localStorage |
| PC 发送后,**手机页面几秒内自动出现**新内容 | ✅ 可行 | 页面轮询(3~5s)即可;要「真秒级」需上 Durable Objects + WebSocket |
| 手机上**点一下**就把内容放进系统剪贴板 | ✅ 可行 | 必须有一次用户手势(Web 平台硬限制) |
| PC/手机**全自动、零点击**同步系统剪贴板 | ❌ Web 页面做不到 | 见 §2;只有「PC 装浏览器扩展」这一条路能做到 PC 侧全自动 |

一句话:**"不用输码"完全能做;"不用点任何东西的剪贴板同步"在纯网页上做不到**——差的就是那一次点击,不是设计问题,是浏览器安全模型。

## 1. 为什么现在每次都要输码

现有设计是"故意一次性"的,三条特性叠在一起必然要求每次重新输码:

- 取件码只有 4 位(`src/index.ts:37` `CODE_ALPHABET`,正则 `/^[A-HJKMNP-Z2-9]{4}$/`),TTL 仅 600 秒(`src/index.ts:33` `TRANSFER_TTL_SECONDS = 600`)。
- 文本取件**阅后即焚**:`src/index.ts:1344` `await env.TRANSFERS.delete('t:' + code)`,取一次就没了。
- Worker 无状态,浏览器侧也没存任何东西(全仓库 `localStorage` 零使用),所以"上次那台设备"不存在。

也就是说:每台设备的每次传输,都是"新码 → 新输入"。要免输入,就必须引入一个**两端都知道、且活得久**的标识;这是新增的东西,不会改变现有链路。

## 2. 平台硬限制(决定了方案上限,已核实)

- **写剪贴板必须有用户手势**:Safari/iOS 严格执行 transient user activation,`navigator.clipboard.writeText()` 必须在 click/pointerup 处理函数里**同步**调用,一遇到 `await`/`fetch`/`setTimeout` 激活即失效,报 `NotAllowedError`。([WebKit 文档](https://developer.apple.com/documentation/webkit)、[Clipboard API spec](https://www.w3.org/TR/clipboard-apis/))
- **后台/Service Worker 没有剪贴板权限**:`ServiceWorkerGlobalScope` 无 DOM、无焦点,不能读写剪贴板;后台静默改剪贴板被浏览器明确禁止。([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Share_Target_API)、[Chrome Offscreen 文档](https://developer.chrome.com/docs/extensions/mv3/offscreen_documents/))
- **读剪贴板也要手势**:iOS 上 `readText()` 需手势且会弹系统「允许粘贴」;推送/静默唤醒不能代替。([WebKit Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/))
- **Web Push 仅限已装到主屏的 PWA**(iOS 16.4+),且仍唤不起剪贴板写入。
- **Web Share Target**(手机分享菜单直接「分享到文桥」):Android Chrome 支持;**iOS Safari 不支持**,iOS 侧要用快捷指令替代。([MDN 兼容表](https://developer.mozilla.org/en-US/docs/Web/Manifest/share_target#browser_compatibility))
- **KV 是最终一致**:同区域写入立即可见,跨区域最长约 60 秒才传播到位;免费额度 100k 读 / 1,000 写 / 1,000 list / 天,同一 key 写速率上限 1 次/秒。([KV 一致性](https://developers.cloudflare.com/kv/concepts/how-kv-works/)、[KV 限额](https://developers.cloudflare.com/kv/platform/limits/))
- **Durable Objects 免费版可用**(SQLite 后端 + WebSocket Hibernation):100k 请求/天、13,000 GB-s/天、5 GB 存储,建连接后休眠不计费。([DO 限额](https://developers.cloudflare.com/durable-objects/platform/limits/)、[Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets-hibernation/))

## 3. 四个方案

### 方案 A|常驻频道(推荐第一步,纯 KV,不动机器架构)

新增一条**不走焚毁逻辑**的平行链路:一个「频道」= 一个可反复读写的共享条目。

- 路由:`/c`(频道页)、`/c/:code`(带频道码直接进入)、`POST /api/channel`(发)、`GET /api/channel/:code?since=seq`(收)。
- KV:同命名空间 `TRANSFERS`,新前缀 `c:`(现有 `t:` 一个字节都不动);值形如 `{ seq, updatedAt, items: [{id, from, kind, name, type, text?, size?, at}] }`,保留**最近 20 条**;TTL 24 小时,每次写入续期。
- 配对:PC 打开 `/c` → 生成 6~8 位频道码 + 二维码;手机扫**一次** → 两端把 code 写进 `localStorage`;以后打开 `/c` 自动进入,**零输入**。
- 收:页面可见时每 3~5 秒 `GET ...?since=seq`,有新条目就渲染 + 大号「📋 复制」按钮(写剪贴板仍需这一次点击,符合 §2)。
- 发:粘贴 → 发送;文件走同一个 `POST`(复用 `MAX_FILE_BYTES` / `TRANSFER_MAX_BYTES` 校验逻辑)。
- 额度:5 秒轮询 = 720 读/小时/端;页面前台才轮询,两端重度使用 ≈ 1.5k~2 万读/天,远低于 100k;**list 操作为 0**(整条频道是单 key,避免吃 1,000 list/天 的额度)。写 = 每次发送 1~2 次,人类手速无压力。
- 局限:跨区域 KV 延迟最小 1~3 秒、最长可到 60 秒(实测同城通常 1~2 秒),且两端同时写是"读-改-写",有极小竞态(缓解:每端带 `clientId`,合并按 `id` 去重,单用户双设备场景影响可忽略)。
- 改动量:约 250~350 行(1 个页面模板 + 2 个 API + 公共校验抽函数),`/r/*`、`/api/transfer`、`/t`、`/qr` 行为零变化。

### 方案 B|实时房间(Durable Object + WebSocket,秒级)

- 新增 `ChannelDO` 类 + `/c/:code/ws`,写即广播;客户端在线时**带内即时到达**,断线(或 DO 不可用)回落方案 A 的轮询。
- 强一致、无轮询、KV 读额度压力归零;免费额度足够(WS 消息计入 100k 请求/天)。
- 代价:`wrangler.jsonc` 增加 `durable_objects` + `migrations`(仍是同一个 Worker、一次 `wrangler deploy`),代码 +200~300 行。离线补投仍可用 KV 落一份。

### 方案 C|零后端小改(只减轻,不解决)

- 发送后把 `url` 存 localStorage,首页显示「最近取件码」;加 PWA manifest 快捷方式;Android 加 Web Share Target;iOS 用快捷指令。
- 改动 < 60 行,但每次仍是**一次性短命码**,手机侧仍要打开一次——只省了"记码",没省"输码/扫码"。

### 方案 D|PC 浏览器扩展 + 网页(唯一能实现"真剪贴板同步"的路)

- Chrome/Edge 扩展(MV3 + offscreen document)可**常驻**监听/读写剪贴板:PC 复制 → 自动 POST 进频道;PC 侧还能自动把新内容写回系统剪贴板。
- 手机侧受系统限制,永远需要那一次点击(Android 可加 Web Share Target,iOS 用快捷指令)。
- 代价:要做、要装、要维护一个扩展(自打包/开发者模式加载),这是把"网页服务"扩成"双端产品"。

### 对比

| | 免输码 | 实时性 | 手机需点击 | 新增依赖 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| A 常驻频道 | ✅ | 1~3s(最坏 60s) | 是 | 无(纯 KV) | 0.5~1 天 |
| B 实时房间 | ✅ | 秒级/即时 | 是 | Durable Objects | +1~2 天 |
| C 小改 | ❌(仍要开一次) | — | 是 | 无 | 1~2 小时 |
| D 扩展 | ✅ | 秒级 | 是(iOS/Android) | 浏览器扩展 | 3~5 天 |

## 4. 推荐路线(分阶段,原有功能零改动)

**Phase 1 —— 方案 A(建议先做这个)**
1. 抽公共校验:`isValidCode` / 文本与文件体校验复用,保证 `/r/*` 行为不变。
2. 新增 `/c`、`/c/:code`、`POST /api/channel`、`GET /api/channel/:code`。
3. 频道页:未配对 → 显示生成/扫码配对;已配对 → 发送框 + 时间线 + 每条的「复制」按钮 + 「销毁频道」。
4. localStorage 记住频道码;二维码复用现有 `uqr` 依赖,不新增包。
5. 测试:新增 `tests/channel.mjs`(配对、发、收、TTL 续期、非法码拒绝、`since` 增量、频道码不焚毁),并跑现有三套回归;`npm test` 串上第四套。
6. 文档:README.md / README.zh-CN.md 加特性与版本 **v1.2.0**;首页加一个入口卡片(默认流程仍是现有一次性取件码)。
7. 验收:两台设备(或浏览器两个 profile)配对一次后,反复收发**不再输入任何码**;手机端每条内容一次点击进剪贴板;现有 `/r/:code` 焚毁语义与全部测试不变。

**Phase 2 —— 升级到方案 B**(可选):`/c` 路由与 UI 完全不变,只把传输层换成 WebSocket + 轮询兜底。

**Phase 3 —— 体验加成**(可选):PWA(manifest + standalone,手机可加主屏)、Android Web Share Target、iOS 快捷指令(读剪贴板 → POST `/api/channel`)、PC 书签/桌面快捷方式。

## 5. 安全与隐私取舍(必须明确)

- 频道码就是**长期凭证**:拿到就能读、能写。6 位(字母表 31 字符,31⁶ ≈ 8.9 亿)可枚举,建议**默认 7~8 位**(31⁸ ≈ 8.5e11),或 6 位 + 失败限速(KV 计数,如 10 次/10 分钟锁定)。
- 留存时间从 10 分钟变成 24 小时,这是语义变化:频道页要写明「内容保留 24 小时」,并提供「立即销毁频道」(删除 `c:` 键)。
- 文件在频道里同样按 25MB 上限,且 24 小时内可被反复下载(现有文件语义本来就是 TTL 兜底、不焚毁,一致性较好)。
- 两条链路并存:一次性取件码(10 分钟、焚毁)保持现在的隐私强度,不想留痕时继续用它;频道是明确"我要方便"的选项。

## 6. 需要你拍板的三点

1. **留存策略**:频道保留「最近 N 条 + 24 小时」?还是改成"取走即删(阅后即焚)",只保一条最新?
2. **实时性**:接受"A 方案轮询,1~3 秒(最坏 60 秒)",还是一步到位上 "B 方案 Durable Objects 秒级"?
3. **PC 侧要不要自动**:只做网页(PC 也要手动粘贴/点击),还是做一个浏览器扩展实现"PC 复制即上传"?手机侧无论如何都需要一次点击。
