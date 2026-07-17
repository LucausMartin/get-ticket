import { readFile, writeFile } from 'node:fs/promises';
import { APP_ID, BASE, LEFT_TICKET_REFERER, PASSPORT, SESSION_CACHE_FILE } from '../constant/index.js';
import { CookieJar, encryptPassword, parseJsonish, postForm, request } from '../util/http.js';

// 初始化登录会话：拿基础 Cookie，并判断账号需要短信、滑块还是无需额外核验。
export async function createLoginSession(username) {
  const jar = new CookieJar();

  await request(jar, `${BASE}/otn/resources/login.html`);
  await postForm(jar, `${BASE}/otn/login/conf`, {});

  const verify = await postForm(jar, `${PASSPORT}/web/checkLoginVerify`, {
    username,
    appid: APP_ID,
  });

  return { jar, verify };
}

// 初始化普通查票会话。未登录也能查余票，但仍需要先访问 leftTicket 页面拿路由 Cookie。
export async function createTicketSession() {
  const jar = new CookieJar();
  await request(jar, LEFT_TICKET_REFERER, {
    headers: {
      Referer: `${BASE}/otn/index/initMy12306`,
    },
  });
  return { jar };
}

async function readSessionCache() {
  try {
    return JSON.parse(await readFile(SESSION_CACHE_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeSessionCache(cache) {
  await writeFile(SESSION_CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

export async function saveCachedSession(username, session, meta = {}) {
  const cache = await readSessionCache();
  cache[username] = {
    username,
    savedAt: new Date().toISOString(),
    cookies: session.jar.toJSON(),
    meta,
  };
  await writeSessionCache(cache);
}

export async function loadCachedSession(username) {
  const cache = await readSessionCache();
  const record = cache[username];
  if (!record?.cookies) return null;
  return {
    jar: CookieJar.fromJSON(record.cookies),
    cached: {
      savedAt: record.savedAt,
      meta: record.meta || {},
    },
  };
}

export async function checkLoginSession(session) {
  try {
    const checkUser = await postForm(session.jar, `${BASE}/otn/login/checkUser`, {}, {
      Referer: `${BASE}/otn/index/initMy12306`,
    });
    return {
      ok: Boolean(checkUser.data?.flag),
      stage: 'check_cached_session',
      checkUser,
    };
  } catch (error) {
    return {
      ok: false,
      stage: 'check_cached_session',
      message: error.message,
    };
  }
}

export async function getUsableSession(username) {
  const session = await loadCachedSession(username);
  if (!session) {
    return {
      ok: false,
      stage: 'load_cached_session',
      message: '没有可用的登录缓存。',
    };
  }

  const check = await checkLoginSession(session);
  return {
    ...check,
    session: check.ok ? session : null,
    cached: session.cached,
  };
}

export async function requestSmsCode({ username, castNum }) {
  const { jar, verify } = await createLoginSession(username);
  const sms = await sendSmsCodeInSession({ jar }, { username, castNum });

  return {
    ok: String(sms.result_code) === '0',
    stage: 'send_sms',
    verify,
    sms,
    cookies: jar.names(),
  };
}

export async function sendSmsCodeInSession(session, { username, castNum }) {
  return postForm(session.jar, `${PASSPORT}/web/getMessageCode`, {
    appid: APP_ID,
    username,
    castNum,
  });
}

export async function login12306({ username, password, smsCode = '', slide = null, session = null }) {
  const { jar, verify } = session || (await createLoginSession(username));
  const loginCheckCode = String(verify.login_check_code ?? '');

  const payload = {
    username,
    password: encryptPassword(password),
    appid: APP_ID,
  };

  if (loginCheckCode === '0') {
    Object.assign(payload, {
      sessionId: '',
      sig: '',
      if_check_slide_passcode_token: '',
      scene: '',
      checkMode: '',
      randCode: '',
    });
  } else if (loginCheckCode === '3' || smsCode) {
    Object.assign(payload, {
      sessionId: '',
      sig: '',
      if_check_slide_passcode_token: '',
      scene: '',
      checkMode: '0',
      randCode: smsCode,
    });
  } else if (loginCheckCode === '1' || loginCheckCode === '2') {
    if (!slide) {
      return {
        ok: false,
        stage: 'need_slide',
        verify,
        message: '当前账号需要滑块核验。先调用 /passport/web/slide-passcode 获取 token，再由浏览器 noCaptcha 得到 sessionId/sig。',
      };
    }
    Object.assign(payload, {
      sessionId: slide.sessionId,
      sig: slide.sig,
      if_check_slide_passcode_token: slide.token,
      scene: slide.scene || 'nc_login',
      checkMode: '1',
    });
  } else {
    return {
      ok: false,
      stage: 'unknown_verify_mode',
      verify,
      message: `未知登录核验方式：${loginCheckCode}`,
    };
  }

  const login = await postForm(jar, `${PASSPORT}/web/login`, payload, {
    appFlag: '',
    isPasswordCopy: 'N',
  });
  const result = {
    ok: String(login.result_code) === '0',
    stage: 'login',
    verify,
    login,
    cookies: jar.names(),
  };

  if (result.ok) {
    const uamtk = parseJsonish(await postForm(jar, `${PASSPORT}/web/auth/uamtk`, {
      appid: APP_ID,
    }));
    const tk = uamtk.newapptk || uamtk.apptk;
    const authClient = tk
      ? await postForm(jar, `${BASE}/otn/uamauthclient`, { tk })
      : null;

    result.uamtk = uamtk;
    result.authClient = authClient;
    result.cookies = jar.names();
  }

  return result;
}

export async function promptSmsCode() {
  const { createInterface } = await import('node:readline/promises');
  const { stdin: input, stdout: output } = await import('node:process');
  const rl = createInterface({ input, output });
  const smsCode = (await rl.question('SMS code: ')).trim();
  rl.close();
  return smsCode;
}

// 所有需要登录的命令统一走这里：先复用缓存，失效后短信登录并刷新缓存。
export async function loginWithSmsAndCache({ username, password, castNum }) {
  const cached = await getUsableSession(username);
  if (cached.ok) {
    console.log(JSON.stringify({
      stage: 'reuse_login',
      ok: true,
      cached: cached.cached,
      checkUser: cached.checkUser,
      cookies: cached.session.jar.names(),
    }, null, 2));
    return cached.session;
  }

  console.log(JSON.stringify({
    stage: 'reuse_login',
    ok: false,
    cached: cached.cached,
    message: cached.message || '登录缓存已失效，重新短信登录。',
  }, null, 2));

  const session = await createLoginSession(username);
  const sms = await sendSmsCodeInSession(session, { username, castNum });
  console.log(JSON.stringify({ stage: 'send_sms', verify: session.verify, sms }, null, 2));

  if (String(sms.result_code) !== '0') return null;

  const smsCode = await promptSmsCode();
  const login = await login12306({ username, password, smsCode, session });
  console.log(JSON.stringify({
    stage: login.stage,
    ok: login.ok,
    verify: login.verify,
    login: login.login,
    authClient: login.authClient,
  }, null, 2));

  if (!login.ok) return null;

  await saveCachedSession(username, session, {
    authClient: login.authClient
      ? {
          result_code: login.authClient.result_code,
          username: login.authClient.username,
        }
      : null,
  });

  return session;
}
