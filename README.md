# 12306 自动订票脚本使用文档

## 文件说明

- `order.js`：入口文件，只负责启动 CLI，并重新导出常用模块函数。
- `constant/index.js`：接口域名、登录 appid、固定轮询间隔等全局常量。
- `util/http.js`：CookieJar、请求封装、表单提交、密码加密、通用工具函数。
- `util/cli.js`：命令行参数识别和分发，决定走查询、登录、短信登录或并发抢票。
- `flow/auth.js`：登录、短信验证码、登录态缓存和复用。
- `flow/tickets.js`：查所有可选票、车站转换、席别判断、可下单/候补候选分析。
- `flow/order.js`：提交订单、确认乘客、队列轮询、最终确认订单。
- `strategy/index.js`：并发抢票策略；每轮会同时尝试所有可直接购买组合。
- `12306-enums.js`：从 12306 官方前端资源生成的枚举，包含全量车站、席别、票种、证件类型等。
- `.12306-session.json`：登录态缓存文件，保存 cookie，不保存密码。

`.12306-session.json` 等同登录态凭证，不要提交到 Git，也不要发给别人。

## 基础用法

所有命令都使用：

```bash
node order.js <command> ...
```

站名可以直接写中文，比如 `上海虹桥`、`银川`，脚本会通过 `12306-enums.js` 转成电报码。

## 席别代码

| 代码 | 席别 |
| --- | --- |
| `SWZ` | 商务座 |
| `TZ` | 特等座 |
| `ZY` | 一等座 |
| `ZE` | 二等座 |
| `GG` | 优选一等座 |
| `GR` | 高级软卧 |
| `RW` | 软卧 |
| `YW` | 硬卧 |
| `RZ` | 软座 |
| `YZ` | 硬座 |
| `WZ` | 无座 |
| `QT` | 其他 |

## 多选规则

车次和席别支持多选，用英文逗号或中文逗号分隔：

```text
G1802,G3174
ZE,ZY,SWZ
```

脚本不会按顺序一个一个试。每轮会展开所有命中的组合，例如 `G1802,G3174` 和 `ZE,ZY` 会得到：

```text
G1802 + ZE
G1802 + ZY
G3174 + ZE
G3174 + ZY
```

这些组合只要可直接购买，就会在同一轮同时发起下单流水线；哪个最终出单成功就用哪个。

## 查询余票

```bash
node order.js query <from> <to> <YYYY-MM-DD>
```

示例：

```bash
node order.js query 上海 银川 2026-05-21
```

输出车次、出发到达时间、是否可预订、各席别余票。

## 发送短信验证码

```bash
node order.js send-sms <username> <id-card-last-4>
```

示例：

```bash
node order.js send-sms 13209628749 0519
```

这个命令只发送短信，不完成登录。

## 短信登录并缓存登录态

```bash
node order.js sms-login <username> <password> <id-card-last-4>
```

执行后终端会提示：

```text
SMS code:
```

输入短信验证码。登录成功后会写入 `.12306-session.json`。

## 登录态复用

以下命令都会先尝试复用 `.12306-session.json`：

```text
book-sms
race-grab-sms
```

脚本会调用 `/otn/login/checkUser` 判断登录态是否仍然有效。有效时会输出：

```json
{
  "stage": "reuse_login",
  "ok": true
}
```

无缓存或缓存过期时，才会重新发送短信并登录。

## 提交到确认乘客前

```bash
node order.js book-sms <username> <password> <id-card-last-4> <from> <to> <YYYY-MM-DD> <trainCodes>
```

示例：

```bash
node order.js book-sms 13209628749 '密码' 0519 上海 银川 2026-05-21 G1802,G3174
```

功能：

- 登录或复用登录态
- 查询余票
- 输出命中的可预订候选车次
- 不创建订单；创建订单请使用 `race-grab-sms`

## 并发抢票模式

```bash
node order.js race-grab-sms <username> <password> <id-card-last-4> <from> <to> <YYYY-MM-DD> <trainCodes> <passengerName> <seatTypes> [maxAttempts]
```

示例：

```bash
node order.js race-grab-sms 13209628749 '密码' 0519 上海 银川 2026-06-03 K360,G1802,G3174 马梓轩 ZE,ZY,YW,WZ 0
```

功能：

- 每轮查询会展开所有可直接购买的“车次+席别”组合
- 对所有可买组合同时发起下单流水线
- 所有进入队列的组合都会轮询队列结果
- 任意一个组合拿到订单并确认成功，整体立即返回成功
- 未进入队列或失败的组合不会阻塞下一轮抢票
- 如果本轮没有任何直购组合，但识别到可候补组合，会把所有可候补“车次+席别”一次性提交候补订单

注意：

- 这个模式会尝试为每个候选组合创建独立服务端会话，避免同一个 `JSESSIONID` 下 `submitOrderRequest/initDc` 上下文互相覆盖。
- 候补订单会进入候补排队和待支付流程；如果 12306 返回人证核验或滑块校验，脚本会停止并输出对应阶段，避免重复提交。

## 自动刷票间隔

`maxAttempts` 可选：

- 不传或传 `0`：无限尝试
- 传具体数字：最多尝试指定次数

抢票动态间隔：

| 场景 | 查询间隔 |
| --- | --- |
| 距离起售时间大于 90 秒 | 60 秒后再查 |
| 距离起售时间 0 到 90 秒 | 1 秒查一次 |
| 超过起售时间且不超过 2 分钟 | 0.5 秒查一次 |
| 其他情况 | 1 秒查一次 |

如果目标车次已经查到，但所有目标车次都不支持指定席别，脚本会直接停止并输出 `unsupported_seat_type`。例如 K 字头列车通常没有 `ZE` 二等座、`ZY` 一等座，这种参数不会进入无限刷票。

每轮输出会包含 `nextDelay`：

```json
{
  "delayMs": 60000,
  "reason": "sale_time_far"
}
```

`race-grab-sms` 会真正创建订单。

## 排队阶段确认

12306 的最终提交接口返回 `submitStatus: true` 时，只代表请求已经进入队列，不一定代表订单最终成功。

脚本现在会继续执行：

```text
confirmSingleForQueue
queryOrderWaitTime
resultOrderForDcQueue
```

排队期间会反复输出：

```json
{
  "stage": "query_order_wait_time",
  "waitTime": 10,
  "waitCount": 2,
  "orderId": null
}
```

队列轮询间隔是固定的 `1000ms`，对应 `order.js` 里的 `QUEUE_POLL_INTERVAL_MS`。如果要调慢或调快，只改这个常量即可。

当 `queryOrderWaitTime` 返回 `waitTime = -1` 或 `waitTime = -100` 且包含 `orderId` 时，脚本会调用 `resultOrderForDcQueue` 获取最终结果。

最终 `ok` 以排队确认结果为准：

- `resultOrderForDcQueue.data.submitStatus === true`：订单确认成功
- 排队失败、登录态失效、超时、或最终结果失败：`ok` 为 `false`

抢票模式里会区分失败类型：

- 可重试失败：提交订单失败、系统繁忙、直购队列失败、候补队列失败、队列超时等，会回到下一轮继续刷票。
- 不可重试失败：乘车人不存在、席别不支持、人证核验、扫码、滑块等，会立即停止并输出对应原因。

## 常见输出阶段

| stage | 含义 |
| --- | --- |
| `reuse_login` | 正在复用或检查缓存登录态 |
| `send_sms` | 已发送短信验证码 |
| `login` | 正在登录或登录完成 |
| `query_tickets` | 查询余票 |
| `race_wait_ticket` | 并发抢票模式中，等待并展开所有可买组合 |
| `race_submit_order_request` | 并发抢票模式中，某个候选组合已提交订单请求 |
| `race_grab_success` | 并发抢票模式中，已有候选组合最终出单成功 |
| `race_grab_no_order` | 达到最大尝试次数仍未成功出单 |
| `standby_check_face` | 候补提交前检查人证核验状态 |
| `standby_submit_order_request` | 已提交候补需求 `secretList` |
| `standby_passenger_init` | 候补确认页初始化，获取候补车次和截止兑现时间 |
| `standby_confirm_hb` | 已提交候补订单确认 |
| `standby_query_queue` | 正在轮询候补排队状态 |
| `standby_order_retry` | 候补提交或候补队列失败，准备下一轮重试 |
| `standby_order_failed` | 候补订单未创建成功，通常需要查看返回消息或人工核验 |
| `submit_order_request` | 已提交订单请求，进入确认乘客流程 |
| `ready_to_confirm_order` | 已完成预检查，但未最终下单 |
| `confirm_single_for_queue` | 已调用最终下单接口 |
| `query_order_wait_time` | 正在查询排队状态 |
| `result_order_for_dc_queue` | 已拿到订单号并确认排队最终结果 |
| `query_order_wait_time_timeout` | 排队等待超时 |

## 注意事项

- `race-grab-sms` 会真正创建订单。
- `book-sms` 只查找候选车次，不创建订单。
- `.12306-session.json` 包含 cookie，注意保管。
- 密码不会写入 `.12306-session.json`。
- 多选车次和席别时，脚本会同时尝试所有可买组合。
