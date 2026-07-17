import { BASE, LEFT_TICKET_REFERER } from '../constant/index.js';
import { CookieJar, nowText, request, sleep } from '../util/http.js';
import { submitFinalOrder, submitOrderRequest } from '../flow/order.js';
import { submitStandbyOrder } from '../flow/standby.js';
import {
  findBookableTargets,
  findStandbyTargets,
  nextGrabDelay,
  queryTickets,
  targetStatus,
  targetSummary,
  ticketSummary,
  unsupportedSeatSelection,
} from '../flow/tickets.js';
import { createTicketSession } from '../flow/auth.js';

const NON_RETRYABLE_STAGES = new Set([
  'unsupported_seat_type',
  'select_passenger',
  'standby_select_passenger',
  'standby_slide_required',
  'queue_cancelled',
  'order_cancelled',
  'race_candidate_cancelled',
]);

function shouldRetryFailure(result) {
  if (!result) return true;
  if (result.fatal) return false;
  if (result.needsQr) return false;
  if (NON_RETRYABLE_STAGES.has(result.stage)) return false;
  if (NON_RETRYABLE_STAGES.has(result.finalSubmit?.stage)) return false;
  if (NON_RETRYABLE_STAGES.has(result.standby?.stage)) return false;
  if (result.standby?.needsQr) return false;

  const message = String(result.message || result.finalSubmit?.message || result.standby?.message || '');
  return !/未找到乘车人|不支持指定席别|人证核验|扫码|滑块/.test(message);
}

async function forkOrderSession(baseSession) {
  const jar = CookieJar.fromJSON(baseSession.jar.toJSON());
  jar.delete('JSESSIONID');
  await request(jar, LEFT_TICKET_REFERER, {
    headers: {
      Referer: `${BASE}/otn/index/initMy12306`,
    },
  });
  return { jar };
}

async function attemptDirectOrderCandidate(baseSession, { target, date, from, to, passengerName, stopSignal = null }) {
  const context = {
    trainCode: target.trainCode,
    seatType: target.seatType,
    seatAvailability: target.seatAvailability,
  };

  if (stopSignal?.()) {
    return { ok: false, stage: 'race_candidate_cancelled', context, message: '已有其他候选组合成功出单，跳过当前候选。' };
  }

  const session = await forkOrderSession(baseSession);
  const submit = await submitOrderRequest(session, { ticket: target.ticket, date, from, to });
  console.log(JSON.stringify({
    stage: 'race_submit_order_request',
    ok: submit.ok,
    context,
    submit: submit.submit,
  }, null, 2));

  if (!submit.ok || stopSignal?.()) {
    return {
      ok: false,
      stage: submit.ok ? 'race_candidate_cancelled' : 'submit_order_request',
      context,
      submit,
    };
  }

  const finalSubmit = await submitFinalOrder(session, {
    ticket: target.ticket,
    date,
    passengerName,
    seatType: target.seatType,
    confirmOrder: true,
    stopSignal,
    context,
  });

  return {
    ok: finalSubmit.ok,
    stage: 'race_candidate_result',
    context,
    submit,
    finalSubmit,
  };
}

export async function raceGrabTickets({ session, from, to, date, trainCodes, seatTypes, passengerName, maxAttempts = 0 }) {
  let attempt = 0;
  const raceState = { done: false, winner: null };

  while (!raceState.done && (maxAttempts <= 0 || attempt < maxAttempts)) {
    attempt += 1;
    const query = await queryTickets({ from, to, date, session, createTicketSession });
    const unsupported = unsupportedSeatSelection(query, trainCodes, seatTypes);
    const targets = findBookableTargets(query, trainCodes, seatTypes);
    const standbyTargets = findStandbyTargets(query, trainCodes, seatTypes);
    const delay = targets.length ? null : nextGrabDelay({ query, trainCodes });

    console.log(JSON.stringify({
      stage: 'race_wait_ticket',
      ok: targets.length > 0,
      attempt,
      time: nowText(),
      targets: targetStatus(query, trainCodes, seatTypes),
      directTargets: targets.map(targetSummary),
      standbyTargets: standbyTargets.map(targetSummary),
      nextDelay: delay,
    }, null, 2));

    if (unsupported) return { ok: false, fatal: unsupported };

    if (!targets.length) {
      if (standbyTargets.length) {
        const standby = await submitStandbyOrder(session, {
          targets: standbyTargets,
          passengerName,
        });

        console.log(JSON.stringify({
          ok: standby.ok,
          stage: 'standby_order_result',
          attempt,
          standbyTargets: standbyTargets.map(targetSummary),
          standby,
        }, null, 2));

        if (standby.ok) return standby;
        if (!shouldRetryFailure(standby)) {
          return { ok: false, stage: 'standby_order_failed', attempt, standby };
        }

        console.log(JSON.stringify({
          ok: false,
          stage: 'standby_order_retry',
          attempt,
          nextDelay: delay,
          message: '候补提交或候补排队失败，属于可重试失败，继续下一轮刷票。',
        }, null, 2));
      }

      await sleep(delay.delayMs);
      continue;
    }

    const attempts = targets.map((target) =>
      attemptDirectOrderCandidate(session, {
        target,
        date,
        from,
        to,
        passengerName,
        stopSignal: () => raceState.done,
      }).then((result) => {
        console.log(JSON.stringify({
          stage: 'race_candidate_done',
          ok: result.ok,
          context: result.context,
          result,
        }, null, 2));

        if (result.ok && !raceState.done) {
          raceState.done = true;
          raceState.winner = result;
        }

        return result;
      }).catch((error) => ({
        ok: false,
        stage: 'race_candidate_error',
        context: {
          trainCode: target.trainCode,
          seatType: target.seatType,
          seatAvailability: target.seatAvailability,
        },
        message: error.message,
      })));

    const winner = await Promise.any(attempts.map((attemptPromise) =>
      attemptPromise.then((result) => {
        if (result.ok) return result;
        throw result;
      }))).catch((error) => {
      if (error instanceof AggregateError) return null;
      throw error;
    });

    if (winner || raceState.winner) {
      raceState.done = true;
      raceState.winner = winner || raceState.winner;
      return {
        ok: true,
        stage: 'race_grab_success',
        attempt,
        winner: raceState.winner,
      };
    }

    await sleep(nextGrabDelay({ query, trainCodes }).delayMs);
  }

  return {
    ok: false,
    stage: 'race_grab_no_order',
    message: `达到最大尝试次数，仍未成功出单：${trainCodes.join(',')} / ${seatTypes.join(',')}`,
  };
}

export { targetStatus, ticketSummary };
