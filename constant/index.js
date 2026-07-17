// 12306 脚本全局常量。
// 只放不会产生副作用的配置，方便登录、查票、下单模块共同复用。

export const BASE = 'https://kyfw.12306.cn';
export const PASSPORT = `${BASE}/passport`;
export const APP_ID = 'otn';
export const SM4_KEY = 'tiekeyuankp12306';
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
export const LEFT_TICKET_REFERER = `${BASE}/otn/leftTicket/init?linktypeid=dc`;
export const STANDBY_REFERER = `${BASE}/otn/view/lineUp_toPay.html`;
export const SESSION_CACHE_FILE = new URL('../.12306-session.json', import.meta.url);

// 进入最终排队队列后的固定轮询间隔。
export const QUEUE_POLL_INTERVAL_MS = 1000;
export const STANDBY_QUEUE_POLL_INTERVAL_MS = 1000;
