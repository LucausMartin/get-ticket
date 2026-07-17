import { BASE, LEFT_TICKET_REFERER, QUEUE_POLL_INTERVAL_MS } from '../constant/index.js';
import { nowText, postForm, request, sleep } from '../util/http.js';
import { SEAT_CODES } from '../12306-enums.js';
import { stationCode, stationName } from './tickets.js';

function extractJsValue(html, name) {
  const patterns = [
    new RegExp(`var\\s+${name}\\s*=\\s*'([^']*)'`),
    new RegExp(`var\\s+${name}\\s*=\\s*"([^"]*)"`),
    new RegExp(`${name}\\s*=\\s*'([^']*)'`),
    new RegExp(`${name}\\s*=\\s*"([^"]*)"`),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }

  return '';
}

function parseJsObjectLiteral(html, name) {
  const marker = `var ${name}`;
  let index = html.indexOf(marker);
  if (index < 0) index = html.indexOf(`${name} =`);
  if (index < 0) return null;

  const start = html.indexOf('{', index);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const literal = html.slice(start, i + 1);
        return Function(`"use strict"; return (${literal});`)();
      }
    }
  }

  return null;
}

export function parseConfirmPassengerPage(html) {
  const ticketInfo = parseJsObjectLiteral(html, 'ticketInfoForPassengerForm');
  const orderRequest = parseJsObjectLiteral(html, 'orderRequestDTO');

  return {
    repeatSubmitToken:
      extractJsValue(html, 'globalRepeatSubmitToken') ||
      extractJsValue(html, 'REPEAT_SUBMIT_TOKEN'),
    keyCheckIsChange: extractJsValue(html, 'key_check_isChange') || ticketInfo?.key_check_isChange || '',
    leftTicketStr: extractJsValue(html, 'leftTicketStr') || ticketInfo?.leftTicketStr || '',
    trainLocation: extractJsValue(html, 'train_location') || ticketInfo?.train_location || '',
    purposeCodes: extractJsValue(html, 'purpose_codes') || ticketInfo?.purpose_codes || 'ADULT',
    ticketInfo,
    orderRequest,
  };
}

function passengerTicketString(passenger, seatType) {
  const seatCode = SEAT_CODES[seatType] || seatType;
  const ticketType = passenger.passenger_type || passenger.passenger_type_code || '1';
  const idType = passenger.passenger_id_type_code || '1';
  const phone = passenger.mobile_no || passenger.phone_no || '';
  const enc = passenger.allEncStr || '';

  return [
    seatCode,
    '0',
    ticketType,
    passenger.passenger_name,
    idType,
    passenger.passenger_id_no,
    phone,
    'N',
    enc,
  ].join(',');
}

function oldPassengerString(passenger) {
  return [
    passenger.passenger_name,
    passenger.passenger_id_type_code || '1',
    passenger.passenger_id_no,
    passenger.passenger_type || passenger.passenger_type_code || '1',
  ].join(',') + '_';
}

function trainDateForQueue(date) {
  const [year, month, day] = date.split('-').map(Number);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const value = new Date(year, month - 1, day);
  return `${dayNames[value.getDay()]} ${monthNames[month - 1]} ${String(day).padStart(2, '0')} ${year} 00:00:00 GMT+0800 (中国标准时间)`;
}

function splitCheckOrderResult(checkOrder) {
  const result = checkOrder?.data?.result;
  if (typeof result !== 'string' || !result.includes('#')) return {};

  const [trainLocation, keyCheckIsChange, leftTicketStr, isAsync] = result.split('#');
  return { trainLocation, keyCheckIsChange, leftTicketStr, isAsync };
}

export async function submitOrderRequest(session, { ticket, date, from, to, purpose = 'ADULT' }) {
  if (!ticket || !date || !from || !to) {
    throw new Error('ticket, date, from and to are required for submitOrderRequest');
  }

  const checkUser = await postForm(session.jar, `${BASE}/otn/login/checkUser`, {}, {
    Referer: LEFT_TICKET_REFERER,
  });

  if (!checkUser.data?.flag) {
    return {
      ok: false,
      stage: 'check_user',
      checkUser,
      message: '当前会话未登录，不能提交订单。',
    };
  }

  const jsonAtt = checkUser.attributes ? { _json_att: checkUser.attributes } : {};
  const submit = await postForm(session.jar, `${BASE}/otn/leftTicket/submitOrderRequest`, {
    secretStr: ticket.secretStr,
    train_date: date,
    back_train_date: date,
    tour_flag: 'dc',
    purpose_codes: purpose,
    query_from_station_name: stationName(stationCode(from)),
    query_to_station_name: stationName(stationCode(to)),
    bed_level_info: ticket.bedLevelInfo || '',
    seat_discount_info: ticket.seatDiscountInfo || '',
    ...jsonAtt,
  }, {
    Referer: LEFT_TICKET_REFERER,
  });

  return {
    ok: Boolean(submit.status),
    stage: 'submit_order_request',
    checkUser,
    submit,
  };
}

export async function initConfirmPassenger(session) {
  const html = await postForm(session.jar, `${BASE}/otn/confirmPassenger/initDc`, {}, {
    Referer: LEFT_TICKET_REFERER,
  });
  const page = parseConfirmPassengerPage(html);

  return {
    ok: Boolean(page.repeatSubmitToken),
    stage: 'init_confirm_passenger',
    page,
  };
}

export async function getPassengers(session, token) {
  const response = await postForm(session.jar, `${BASE}/otn/confirmPassenger/getPassengerDTOs`, {
    REPEAT_SUBMIT_TOKEN: token,
    _json_att: '',
  }, {
    Referer: `${BASE}/otn/confirmPassenger/initDc`,
  });

  const normal = response.data?.normal_passengers || [];
  const dj = response.data?.dj_passengers || [];
  return {
    ok: Boolean(response.status),
    stage: 'get_passengers',
    passengers: [...normal, ...dj],
    response,
  };
}

export async function queryOrderWaitTime(session, token, tourFlag = 'dc') {
  const url = new URL(`${BASE}/otn/confirmPassenger/queryOrderWaitTime`);
  url.searchParams.set('random', String(Date.now()));
  url.searchParams.set('tourFlag', tourFlag);
  url.searchParams.set('_json_att', '');
  url.searchParams.set('REPEAT_SUBMIT_TOKEN', token);

  return request(session.jar, url.toString(), {
    headers: {
      Referer: `${BASE}/otn/confirmPassenger/initDc`,
    },
  });
}

export async function resultOrderForDcQueue(session, token, orderId) {
  return postForm(session.jar, `${BASE}/otn/confirmPassenger/resultOrderForDcQueue`, {
    orderSequence_no: orderId,
    REPEAT_SUBMIT_TOKEN: token,
    _json_att: '',
  }, {
    Referer: `${BASE}/otn/confirmPassenger/initDc`,
  });
}

export async function waitForQueueResult(session, token, { tourFlag = 'dc', maxWaitMs = 30 * 60 * 1000, stopSignal = null, context = null } = {}) {
  const startedAt = Date.now();
  let attempt = 0;
  let lastWait = null;

  while (Date.now() - startedAt <= maxWaitMs) {
    if (stopSignal?.()) {
      return { ok: false, stage: 'queue_cancelled', context, message: '已有其他候选组合成功出单，停止监听当前队列。' };
    }

    attempt += 1;
    const wait = await queryOrderWaitTime(session, token, tourFlag);
    const data = wait.data || {};
    const waitTime = Number(data.waitTime);

    console.log(JSON.stringify({
      stage: 'query_order_wait_time',
      ok: Boolean(wait.status && data.queryOrderWaitTimeStatus !== false),
      attempt,
      time: nowText(),
      waitTime,
      waitCount: data.waitCount,
      orderId: data.orderId,
      msg: data.msg,
      context,
      response: wait,
    }, null, 2));

    lastWait = wait;

    if (!wait.status || data.queryOrderWaitTimeStatus === false) {
      return { ok: false, stage: 'query_order_wait_time', wait, message: '排队状态查询失败或登录态失效。' };
    }

    if ((waitTime === -1 || waitTime === -100) && data.orderId) {
      const result = await resultOrderForDcQueue(session, token, data.orderId);
      return {
        ok: Boolean(result.status && result.data?.submitStatus),
        stage: 'result_order_for_dc_queue',
        orderId: data.orderId,
        wait,
        result,
      };
    }

    if (waitTime === -2 || waitTime === -3) {
      return { ok: false, stage: 'query_order_wait_time', wait, message: data.msg || '排队失败，订单未成功。' };
    }

    await sleep(QUEUE_POLL_INTERVAL_MS);
  }

  return {
    ok: false,
    stage: 'query_order_wait_time_timeout',
    wait: lastWait,
    message: `排队超过 ${Math.round(maxWaitMs / 1000)} 秒仍未得到最终结果。`,
  };
}

export async function submitFinalOrder(session, { ticket, date, passengerName, seatType, purpose = 'ADULT', confirmOrder = true, stopSignal = null, context = null }) {
  if (!ticket || !date || !passengerName || !seatType) {
    throw new Error('ticket, date, passengerName and seatType are required for submitFinalOrder');
  }

  if (stopSignal?.()) return { ok: false, stage: 'order_cancelled', context, message: '已有其他候选组合成功出单，跳过当前候选。' };

  const init = await initConfirmPassenger(session);
  if (!init.ok) return init;
  if (stopSignal?.()) return { ok: false, stage: 'order_cancelled', context, init, message: '已有其他候选组合成功出单，停止当前候选。' };

  const token = init.page.repeatSubmitToken;
  const passengers = await getPassengers(session, token);
  if (!passengers.ok) return passengers;
  if (stopSignal?.()) return { ok: false, stage: 'order_cancelled', context, init, passengers, message: '已有其他候选组合成功出单，停止当前候选。' };

  const passenger = passengers.passengers.find((item) => item.passenger_name === passengerName);
  if (!passenger) {
    return {
      ok: false,
      stage: 'select_passenger',
      message: `未找到乘车人：${passengerName}`,
      passengers: passengers.passengers.map((item) => item.passenger_name),
    };
  }

  const passengerTicketStr = passengerTicketString(passenger, seatType);
  const oldPassengerStr = oldPassengerString(passenger);
  let keyCheckIsChange = init.page.keyCheckIsChange;
  let leftTicketStr = init.page.leftTicketStr;
  let trainLocation = init.page.trainLocation;
  const finalPurpose = init.page.purposeCodes || purpose;
  const commonToken = { REPEAT_SUBMIT_TOKEN: token, _json_att: '' };

  const checkOrder = await postForm(session.jar, `${BASE}/otn/confirmPassenger/checkOrderInfo`, {
    cancel_flag: '2',
    bed_level_order_num: '000000000000000000000000000000',
    passengerTicketStr,
    oldPassengerStr,
    tour_flag: 'dc',
    randCode: '',
    whatsSelect: '1',
    sessionId: '',
    sig: '',
    scene: 'nc_login',
    ...commonToken,
  }, {
    Referer: `${BASE}/otn/confirmPassenger/initDc`,
  });

  if (!checkOrder.status || checkOrder.data?.submitStatus === false) {
    return { ok: false, stage: 'check_order_info', init, passengers, checkOrder };
  }

  const checkOrderTokens = splitCheckOrderResult(checkOrder);
  keyCheckIsChange = checkOrderTokens.keyCheckIsChange || keyCheckIsChange;
  leftTicketStr = checkOrderTokens.leftTicketStr || leftTicketStr;
  trainLocation = checkOrderTokens.trainLocation || trainLocation;
  if (stopSignal?.()) return { ok: false, stage: 'order_cancelled', context, init, passengers, checkOrder, message: '已有其他候选组合成功出单，停止当前候选。' };

  const queuePayload = {
    train_date: trainDateForQueue(date),
    train_no: init.page.orderRequest?.train_no || ticket.trainNo,
    stationTrainCode: init.page.orderRequest?.station_train_code || ticket.trainCode,
    seatType: SEAT_CODES[seatType] || seatType,
    fromStationTelecode: init.page.orderRequest?.from_station_telecode || ticket.fromStationCode,
    toStationTelecode: init.page.orderRequest?.to_station_telecode || ticket.toStationCode,
    leftTicket: init.page.ticketInfo?.queryLeftTicketRequestDTO?.ypInfoDetail || leftTicketStr,
    purpose_codes: finalPurpose,
    train_location: trainLocation,
    isCheckOrderInfo: checkOrder.data?.isCheckOrderInfo ?? '',
    ...commonToken,
  };
  const queue = await postForm(session.jar, `${BASE}/otn/confirmPassenger/getQueueCount`, queuePayload, {
    Referer: `${BASE}/otn/confirmPassenger/initDc`,
  });

  if (!queue.status) return { ok: false, stage: 'get_queue_count', init, checkOrder, queuePayload, queue };

  if (!confirmOrder) {
    return {
      ok: true,
      stage: 'ready_to_confirm_order',
      passenger: { name: passenger.passenger_name, idType: passenger.passenger_id_type_name, passengerType: passenger.passenger_type_name },
      seatType,
      init,
      checkOrder,
      queuePayload,
      queue,
      message: '已完成提交订单前的乘车人校验和排队校验，未调用最终确认下单接口。',
    };
  }

  if (stopSignal?.()) return { ok: false, stage: 'order_cancelled', context, init, checkOrder, queue, message: '已有其他候选组合成功出单，停止当前候选。' };

  const confirm = await postForm(session.jar, `${BASE}/otn/confirmPassenger/confirmSingleForQueue`, {
    passengerTicketStr,
    oldPassengerStr,
    randCode: '',
    purpose_codes: finalPurpose,
    key_check_isChange: keyCheckIsChange,
    leftTicketStr,
    train_location: trainLocation,
    choose_seats: '',
    seatDetailType: '000',
    is_jy: 'N',
    is_cj: 'N',
    encryptedData: '',
    whatsSelect: '1',
    roomType: '00',
    dwAll: 'N',
    ...commonToken,
  }, {
    Referer: `${BASE}/otn/confirmPassenger/initDc`,
  });

  const confirmOk = Boolean(confirm.status && confirm.data?.submitStatus);
  const queueResult = confirmOk && confirm.data?.isAsync === '1'
    ? await waitForQueueResult(session, token, { tourFlag: 'dc', stopSignal, context })
    : null;

  return {
    ok: Boolean(confirmOk && (!queueResult || queueResult.ok)),
    stage: 'confirm_single_for_queue',
    passenger: { name: passenger.passenger_name, idType: passenger.passenger_id_type_name, passengerType: passenger.passenger_type_name },
    seatType,
    context,
    init,
    checkOrder,
    queue,
    confirm,
    queueResult,
  };
}
