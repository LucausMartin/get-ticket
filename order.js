import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './util/cli.js';

// 12306 自动订票入口。
// 业务实现已经拆到模块中：
// - flow/auth.js：登录、短信验证码、登录态缓存
// - flow/tickets.js：查票、席别判断、候选组合分析
// - flow/order.js：提交订单、确认乘客、队列轮询
// - strategy/index.js：并发抢票和候补策略
// - util/cli.js：命令参数识别和分发

export * from './flow/auth.js';
export * from './flow/tickets.js';
export * from './flow/order.js';
export * from './strategy/index.js';
export * from './util/http.js';
export * from './constant/index.js';
export * from './util/cli.js';

// 用 fileURLToPath 做入口判断，避免 Windows 下 file:// URL 的 / 与路径分隔符 \ 不一致。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}
