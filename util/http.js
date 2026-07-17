import crypto from 'node:crypto';
import { BASE, SM4_KEY, USER_AGENT } from '../constant/index.js';

// 轻量 Cookie 容器。Node fetch 不会像浏览器一样维护 Cookie，所以脚本必须自己保存和回传。
export class CookieJar {
  #cookies = new Map();

  addFrom(headers) {
    const setCookies =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : splitSetCookie(headers.get('set-cookie'));

    for (const setCookie of setCookies) {
      const firstPart = setCookie.split(';', 1)[0];
      const eq = firstPart.indexOf('=');
      if (eq > 0) {
        this.#cookies.set(firstPart.slice(0, eq), firstPart.slice(eq + 1));
      }
    }
  }

  header() {
    return Array.from(this.#cookies, ([key, value]) => `${key}=${value}`).join('; ');
  }

  names() {
    return Array.from(this.#cookies.keys());
  }

  delete(name) {
    this.#cookies.delete(name);
  }

  toJSON() {
    return Object.fromEntries(this.#cookies);
  }

  static fromJSON(cookies = {}) {
    const jar = new CookieJar();
    for (const [key, value] of Object.entries(cookies)) {
      if (value != null) jar.#cookies.set(key, String(value));
    }
    return jar;
  }
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g).map((item) => item.trim());
}

export function encryptPassword(plaintext) {
  const cipher = crypto.createCipheriv('sm4-ecb', Buffer.from(SM4_KEY, 'utf8'), null);
  cipher.setAutoPadding(true);
  return `@${Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]).toString('base64')}`;
}

export function parseJsonish(value) {
  if (typeof value !== 'string') return value;

  const text = value.trim();
  if (text.startsWith('{')) return JSON.parse(text);

  const match = text.match(/^[^(]+\((.*)\);?$/s);
  if (match) return JSON.parse(match[1]);

  return value;
}

export function form(data) {
  return new URLSearchParams(data);
}

// 所有 HTTP 请求的统一入口：补浏览器头、带 Cookie、保存响应 Cookie、解析 JSON/文本。
export async function request(jar, url, options = {}) {
  const headers = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Origin: BASE,
    Referer: `${BASE}/otn/resources/login.html`,
    'User-Agent': USER_AGENT,
    ...options.headers,
  };

  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;

  const response = await fetch(url, {
    redirect: 'manual',
    ...options,
    headers,
  });

  jar.addFrom(response.headers);
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';

  if (!response.ok && !(response.status >= 300 && response.status < 400)) {
    throw new Error(`${options.method || 'GET'} ${url} failed: ${response.status} ${text.slice(0, 200)}`);
  }

  if (contentType.includes('json') || text.trim().startsWith('{')) {
    return JSON.parse(text);
  }

  return text;
}

export async function postForm(jar, url, data, extraHeaders = {}) {
  return request(jar, url, {
    method: 'POST',
    body: form(data),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      ...extraHeaders,
    },
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

export function parseList(value) {
  return String(value || '')
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
