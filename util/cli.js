import { BASE, LEFT_TICKET_REFERER } from '../constant/index.js';
import {
  createLoginSession,
  createTicketSession,
  login12306,
  loginWithSmsAndCache,
  promptSmsCode,
  requestSmsCode,
  saveCachedSession,
  sendSmsCodeInSession,
} from '../flow/auth.js';
import { parseList, request } from './http.js';
import { findTicket, queryTickets } from '../flow/tickets.js';
import { raceGrabTickets, targetStatus, ticketSummary } from '../strategy/index.js';

function usage() {
  console.error('Usage: node order.js <username> <password> [smsCode]');
  console.error('       node order.js query <from> <to> <YYYY-MM-DD>');
  console.error('       node order.js send-sms <username> <id-card-last-4>');
  console.error('       node order.js sms-login <username> <password> <id-card-last-4>');
  console.error('       node order.js book-sms <username> <password> <id-card-last-4> <from> <to> <YYYY-MM-DD> <trainCodes>');
  console.error('       node order.js race-grab-sms <username> <password> <id-card-last-4> <from> <to> <YYYY-MM-DD> <trainCodes> <passengerName> <seatTypes> [maxAttempts]');
}

function ticketCanSubmit(ticket) {
  return Boolean(ticket && ticket.canWebBuy === 'Y' && ticket.secretStr);
}

export async function runCli(args) {
  if (args[0] === 'send-sms') {
    const [, username, castNum] = args;
    if (!username || !castNum) {
      console.error('Usage: node order.js send-sms <username> <id-card-last-4>');
      return 1;
    }

    const result = await requestSmsCode({ username, castNum });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 2;
  }

  if (args[0] === 'query') {
    const [, from, to, date] = args;
    if (!from || !to || !date) {
      console.error('Usage: node order.js query <from> <to> <YYYY-MM-DD>');
      return 1;
    }

    const result = await queryTickets({ from, to, date, createTicketSession });
    console.log(JSON.stringify({
      ...result,
      tickets: result.tickets.map(ticketSummary),
    }, null, 2));
    return result.ok ? 0 : 2;
  }

  if (args[0] === 'sms-login') {
    const [, username, password, castNum] = args;
    if (!username || !password || !castNum) {
      console.error('Usage: node order.js sms-login <username> <password> <id-card-last-4>');
      return 1;
    }

    const session = await createLoginSession(username);
    const sms = await sendSmsCodeInSession(session, { username, castNum });
    console.log(JSON.stringify({ stage: 'send_sms', verify: session.verify, sms }, null, 2));

    if (String(sms.result_code) !== '0') return 2;

    const smsCode = await promptSmsCode();
    const result = await login12306({ username, password, smsCode, session });
    if (result.ok) {
      await saveCachedSession(username, session, {
        authClient: result.authClient
          ? { result_code: result.authClient.result_code, username: result.authClient.username }
          : null,
      });
    }
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 2;
  }

  if (args[0] === 'book-sms') {
    const [, username, password, castNum, from, to, date, trainCodesArg] = args;
    if (!username || !password || !castNum || !from || !to || !date || !trainCodesArg) {
      console.error('Usage: node order.js book-sms <username> <password> <id-card-last-4> <from> <to> <YYYY-MM-DD> <trainCodes>');
      return 1;
    }

    const session = await loginWithSmsAndCache({ username, password, castNum });
    if (!session) return 2;

    await request(session.jar, LEFT_TICKET_REFERER, {
      headers: {
        Referer: `${BASE}/otn/index/initMy12306`,
      },
    });
    const query = await queryTickets({ from, to, date, session, createTicketSession });
    const trainCodes = parseList(trainCodesArg);
    const ticket = trainCodes.map((trainCode) => findTicket(query, trainCode)).find(ticketCanSubmit);

    if (!ticket) {
      console.log(JSON.stringify({
        ok: false,
        stage: 'select_ticket',
        message: `未找到可预订车次：${trainCodes.join(',')}`,
        targets: targetStatus(query, trainCodes, []),
      }, null, 2));
      return 2;
    }

    await saveCachedSession(username, session);
    console.log(JSON.stringify({
      ok: true,
      stage: 'book_candidate',
      ticket: ticketSummary(ticket),
      message: 'book-sms 仅保留查找候选车次功能；创建订单请使用 race-grab-sms。',
    }, null, 2));
    return 0;
  }

  if (args[0] === 'submit-sms' || args[0] === 'prepare-sms' || args[0] === 'grab-sms') {
    console.error(`${args[0]} 已移除：脚本现在只保留并发抢票入口 race-grab-sms。`);
    return 1;
  }

  if (args[0] === 'race-grab-sms') {
    const [, username, password, castNum, from, to, date, trainCodesArg, passengerName, seatTypesArg, maxAttemptsArg = '0'] = args;
    if (!username || !password || !castNum || !from || !to || !date || !trainCodesArg || !passengerName || !seatTypesArg) {
      console.error('Usage: node order.js race-grab-sms <username> <password> <id-card-last-4> <from> <to> <YYYY-MM-DD> <trainCodes> <passengerName> <seatTypes> [maxAttempts]');
      return 1;
    }

    const session = await loginWithSmsAndCache({ username, password, castNum });
    if (!session) return 2;

    await request(session.jar, LEFT_TICKET_REFERER, {
      headers: {
        Referer: `${BASE}/otn/index/initMy12306`,
      },
    });

    const maxAttempts = Math.max(0, Number(maxAttemptsArg) || 0);
    const trainCodes = parseList(trainCodesArg);
    const seatTypes = parseList(seatTypesArg).map((item) => item.toUpperCase());

    const result = await raceGrabTickets({ session, from, to, date, trainCodes, seatTypes, passengerName, maxAttempts });
    await saveCachedSession(username, session);
    console.log(JSON.stringify(result.fatal || result, null, 2));
    return result.ok ? 0 : 2;
  }

  const [username, password, smsCode] = args;
  if (!username || !password) {
    usage();
    return 1;
  }

  const result = await login12306({ username, password, smsCode });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 2;
}
