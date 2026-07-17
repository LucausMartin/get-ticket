import { BASE, STANDBY_QUEUE_POLL_INTERVAL_MS, STANDBY_REFERER } from '../constant/index.js';
import { SEAT_CODES } from '../12306-enums.js';
import { nowText, postForm, sleep } from '../util/http.js';

// 候补入口页使用的格式：每个候补需求都是 secretStr#seatCode|。
// seatCode 是接口席别编码，比如 ZE -> O、ZY -> M、YW -> 3。
export function standbySecretList(targets) {
  return targets
    .map((target) => `${target.ticket.secretStr}#${SEAT_CODES[target.seatType] || target.seatType}|`)
    .join('');
}

function standbyPassengerInfo(passenger, oldSleeperFlag = 0) {
  const ticketType = passenger.passenger_type || passenger.passenger_type_code || '1';
  const idType = passenger.passenger_id_type_code || '1';
  const enc = passenger.allEncStr || '';

  // 官网 confirmHB 前会把乘车人数组压缩成：
  // 票种#姓名#证件类型#证件号#加密串#老年卧铺标记;
  return [
    ticketType,
    passenger.passenger_name,
    idType,
    passenger.passenger_id_no,
    enc,
    oldSleeperFlag,
  ].join('#') + ';';
}

function standbyTrainList(trainList = []) {
  // confirmHB 的 hbTrain 参数只需要把页面初始化返回的候补车次 train_no 串起来。
  return trainList.map((item) => item.train_no || item.trainNo).filter(Boolean).join('#') + '#';
}

export async function checkStandbyFace(session, targets) {
  const secretList = standbySecretList(targets);
  const response = await postForm(session.jar, `${BASE}/otn/afterNate/chechFace`, {
    secretList,
  }, {
    Referer: STANDBY_REFERER,
  });

  const data = response.data || {};
  const needsQr =
    data.face_flag === false ||
    ['04', '14'].includes(String(data.face_check_code || data.faceCheck || ''));

  return {
    ok: Boolean(response.status && data.login_flag !== false && !needsQr),
    stage: 'standby_check_face',
    secretList,
    needsQr,
    response,
    message: needsQr ? '候补下单触发人证核验，需要 12306 App 扫码后再继续。' : undefined,
  };
}

export async function submitStandbyRequest(session, targets) {
  const secretList = standbySecretList(targets);
  const response = await postForm(session.jar, `${BASE}/otn/afterNate/submitOrderRequest`, {
    secretList,
  }, {
    Referer: STANDBY_REFERER,
  });

  const data = response.data || {};
  const needsQr =
    data.flag === false &&
    ['04', '14'].includes(String(data.faceCheck || data.face_check_code || ''));

  return {
    ok: Boolean(response.status && data && (data.flag === true || data.isAsync)),
    stage: 'standby_submit_order_request',
    secretList,
    needsQr,
    response,
    message: needsQr ? '候补提交触发人证核验，需要 12306 App 扫码后再继续。' : undefined,
  };
}

export async function initStandbyPassenger(session) {
  const response = await postForm(session.jar, `${BASE}/otn/afterNate/passengerInitApi`, {}, {
    Referer: STANDBY_REFERER,
  });

  return {
    ok: Boolean(response.status && response.data?.hbTrainList?.length),
    stage: 'standby_passenger_init',
    response,
    page: response.data || {},
  };
}

export async function getStandbyPassengers(session) {
  const response = await postForm(session.jar, `${BASE}/otn/confirmPassenger/getPassengerDTOs`, {}, {
    Referer: STANDBY_REFERER,
  });

  return {
    ok: Boolean(response.status),
    stage: 'standby_get_passengers',
    passengers: response.data?.normal_passengers || [],
    response,
  };
}

export async function queryStandbyQueue(session) {
  return postForm(session.jar, `${BASE}/otn/afterNate/queryQueue`, {}, {
    Referer: STANDBY_REFERER,
  });
}

export async function waitForStandbyQueue(session, { maxWaitMs = 10 * 60 * 1000 } = {}) {
  const startedAt = Date.now();
  let attempt = 0;
  let lastQueue = null;

  while (Date.now() - startedAt <= maxWaitMs) {
    attempt += 1;
    const queue = await queryStandbyQueue(session);
    const data = queue.data || {};

    console.log(JSON.stringify({
      stage: 'standby_query_queue',
      ok: Boolean(queue.status && data.flag !== false),
      attempt,
      time: nowText(),
      status: data.status,
      waitTime: data.waitTime,
      msg: data.msg,
      response: queue,
    }, null, 2));

    lastQueue = queue;

    if (!queue.status) {
      return { ok: false, stage: 'standby_query_queue', queue, message: '候补排队状态查询失败。' };
    }

    if (data.isAsync) {
      if (data.flag && String(data.status) === '1') {
        return { ok: true, stage: 'standby_queue_success', queue };
      }

      if (String(data.status) === '-1') {
        return { ok: false, stage: 'standby_queue_failed', queue, message: data.msg || '候补排队失败。' };
      }
    } else if (data.flag) {
      return { ok: true, stage: 'standby_queue_success', queue };
    } else if (data.msg) {
      return { ok: false, stage: 'standby_queue_failed', queue, message: data.msg };
    }

    await sleep(STANDBY_QUEUE_POLL_INTERVAL_MS);
  }

  return {
    ok: false,
    stage: 'standby_query_queue_timeout',
    queue: lastQueue,
    message: `候补排队超过 ${Math.round(maxWaitMs / 1000)} 秒仍未得到最终结果。`,
  };
}

export async function confirmStandbyOrder(session, { passengerName, targets, receiveNoSeat = 'N' }) {
  if (!passengerName || !targets?.length) {
    throw new Error('passengerName and targets are required for confirmStandbyOrder');
  }

  const init = await initStandbyPassenger(session);
  if (!init.ok) return init;

  if (init.page.if_check_slide_passcode === '1') {
    return {
      ok: false,
      stage: 'standby_slide_required',
      init,
      message: '候补确认触发滑块校验，当前脚本未自动处理滑块。',
    };
  }

  const passengers = await getStandbyPassengers(session);
  if (!passengers.ok) return passengers;

  const passenger = passengers.passengers.find((item) => item.passenger_name === passengerName);
  if (!passenger) {
    return {
      ok: false,
      stage: 'standby_select_passenger',
      init,
      passengers,
      message: `未找到乘车人：${passengerName}`,
    };
  }

  const passengerInfo = standbyPassengerInfo(passenger);
  const hbTrain = standbyTrainList(init.page.hbTrainList);
  const confirm = await postForm(session.jar, `${BASE}/otn/afterNate/confirmHB`, {
    passengerInfo,
    jzParam: '',
    hbTrain,
    lkParam: '',
    sessionId: '',
    sig: '',
    scene: 'nc_login',
    encryptedData: '',
    if_receive_wseat: receiveNoSeat,
    realize_limit_time_diff: '360',
    plans: '',
    tmp_train_date: '',
    tmp_train_time: '',
    add_train_flag: 'N',
    add_train_seat_type_code: '',
  }, {
    Referer: STANDBY_REFERER,
  });

  if (!confirm.status || confirm.data?.flag === false || confirm.data?.msg) {
    return {
      ok: false,
      stage: 'standby_confirm_hb',
      init,
      passengers,
      passenger: { name: passenger.passenger_name },
      confirm,
      message: confirm.data?.msg || confirm.messages?.[0] || '候补订单确认失败。',
    };
  }

  const queueResult = await waitForStandbyQueue(session);

  return {
    ok: Boolean(queueResult.ok),
    stage: 'standby_confirm_hb',
    init,
    passengers,
    passenger: { name: passenger.passenger_name },
    confirm,
    queueResult,
  };
}

export async function submitStandbyOrder(session, { targets, passengerName }) {
  const face = await checkStandbyFace(session, targets);
  console.log(JSON.stringify({
    stage: face.stage,
    ok: face.ok,
    needsQr: face.needsQr,
    response: face.response,
  }, null, 2));

  if (!face.ok) return face;

  const submit = await submitStandbyRequest(session, targets);
  console.log(JSON.stringify({
    stage: submit.stage,
    ok: submit.ok,
    needsQr: submit.needsQr,
    response: submit.response,
  }, null, 2));

  if (!submit.ok) return submit;

  return confirmStandbyOrder(session, { passengerName, targets });
}
