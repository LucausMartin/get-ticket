import { BASE, LEFT_TICKET_REFERER } from '../constant/index.js';
import { request } from '../util/http.js';
import { SEAT_CODES, SEAT_NAMES, STATION_CODE_BY_NAME, STATION_NAME_BY_CODE } from '../12306-enums.js';
import { createTicketSession as defaultCreateTicketSession } from './auth.js';

export function stationCode(station) {
  return STATION_CODE_BY_NAME[station] || station;
}

export function stationName(stationOrCode) {
  return STATION_NAME_BY_CODE[stationOrCode] || stationOrCode;
}

// 解析 leftTicket/queryG 返回的管道分隔字符串。
export function parseTicket(raw, stationMap = {}) {
  const fields = raw.split('|');
  const fromCode = fields[6];
  const toCode = fields[7];

  return {
    secretStr: decodeURIComponent(fields[0] || ''),
    buttonTextInfo: fields[1],
    trainNo: fields[2],
    trainCode: fields[3],
    startStationCode: fields[4],
    endStationCode: fields[5],
    fromStationCode: fromCode,
    toStationCode: toCode,
    fromStationName: stationMap[fromCode] || stationName(fromCode),
    toStationName: stationMap[toCode] || stationName(toCode),
    startTime: fields[8],
    arriveTime: fields[9],
    duration: fields[10],
    canWebBuy: fields[11],
    ypInfo: fields[12],
    startTrainDate: fields[13],
    trainSeatFeature: fields[14],
    locationCode: fields[15],
    fromStationNo: fields[16],
    toStationNo: fields[17],
    isSupportCard: fields[18],
    controlledTrainFlag: fields[19],
    seats: {
      gg: fields[20],
      gr: fields[21],
      qt: fields[22],
      rw: fields[23],
      rz: fields[24],
      tz: fields[25],
      wz: fields[26],
      yb: fields[27],
      yw: fields[28],
      yz: fields[29],
      ze: fields[30],
      zy: fields[31],
      swz: fields[32],
      srrb: fields[33],
    },
    ypEx: fields[34],
    seatTypes: fields[35],
    exchangeTrainFlag: fields[36],
    houbuTrainFlag: fields[37],
    houbuSeatLimit: fields[38],
    ypInfoNew: fields[39],
    dwFlag: fields[46] || '',
    stopcheckTime: fields[48] || '',
    countryFlag: fields[49] || '',
    localArriveTime: fields[50] || '',
    localStartTime: fields[51] || '',
    bedLevelInfo: fields[53] || '',
    seatDiscountInfo: fields[54] || '',
    saleTime: fields[55] || '',
    raw,
  };
}

export function ticketSummary(ticket) {
  return {
    trainCode: ticket.trainCode,
    from: ticket.fromStationName,
    to: ticket.toStationName,
    startTime: ticket.startTime,
    arriveTime: ticket.arriveTime,
    duration: ticket.duration,
    canWebBuy: ticket.canWebBuy,
    buttonTextInfo: ticket.buttonTextInfo,
    seats: ticket.seats,
  };
}

export function targetSummary(target) {
  return {
    trainCode: target.trainCode,
    seatType: target.seatType,
    seatAvailability: target.seatAvailability,
    ticket: ticketSummary(target.ticket),
  };
}

export function findTicket(query, trainCode) {
  return query.tickets.find((item) => item.trainCode.toUpperCase() === trainCode.toUpperCase());
}

export function ticketCanSubmit(ticket) {
  return Boolean(ticket && ticket.canWebBuy === 'Y' && ticket.secretStr);
}

export function seatAvailabilityValue(ticket, seatType) {
  return ticket?.seats?.[seatType.toLowerCase()] ?? '';
}

export function seatIsSupported(ticket, seatType) {
  return String(seatAvailabilityValue(ticket, seatType)).trim() !== '';
}

export function seatCanSubmit(ticket, seatType) {
  const value = String(seatAvailabilityValue(ticket, seatType)).trim();
  return Boolean(value && value !== '--' && value !== '无' && value !== '*' && value !== '候补');
}

export function seatLabel(seatType) {
  return `${seatType}${SEAT_NAMES[seatType] ? `(${SEAT_NAMES[seatType]})` : ''}`;
}

export function unsupportedSeatSelection(query, trainCodes, seatTypes) {
  const foundTargets = trainCodes
    .map((trainCode) => findTicket(query, trainCode))
    .filter(Boolean);

  if (!foundTargets.length) return null;

  const hasSupportedSeat = foundTargets.some((ticket) =>
    seatTypes.some((seatType) => seatIsSupported(ticket, seatType)));

  if (hasSupportedSeat) return null;

  return {
    ok: false,
    stage: 'unsupported_seat_type',
    message: `目标车次不支持指定席别：${trainCodes.join(',')} / ${seatTypes.map(seatLabel).join(',')}`,
    targets: targetStatus(query, trainCodes, seatTypes),
  };
}

// 展开本轮所有可直接购买组合。
export function findBookableTargets(query, trainCodes, seatTypes) {
  const targets = [];

  for (const trainCode of trainCodes) {
    const ticket = findTicket(query, trainCode);
    if (!ticketCanSubmit(ticket)) continue;

    for (const seatType of seatTypes) {
      if (seatCanSubmit(ticket, seatType)) {
        targets.push({
          ticket,
          trainCode: ticket.trainCode,
          seatType,
          seatAvailability: seatAvailabilityValue(ticket, seatType),
        });
      }
    }
  }

  return targets;
}

export function findStandbyTargets(query, trainCodes, seatTypes) {
  const targets = [];

  for (const trainCode of trainCodes) {
    const ticket = findTicket(query, trainCode);
    if (!ticket?.secretStr || ticket.houbuTrainFlag !== '1') continue;

    for (const seatType of seatTypes) {
      const value = String(seatAvailabilityValue(ticket, seatType)).trim();
      const seatCode = SEAT_CODES[seatType] || seatType;
      if (!seatIsSupported(ticket, seatType)) continue;
      if (seatCanSubmit(ticket, seatType)) continue;
      if (seatType === 'WZ' || seatType === 'QT') continue;
      if (ticket.houbuSeatLimit?.includes(seatCode)) continue;
      if (value !== '无' && value !== '候补') continue;

      targets.push({
        ticket,
        trainCode: ticket.trainCode,
        seatType,
        seatCode,
        seatAvailability: value,
      });
    }
  }

  return targets;
}

export function targetStatus(query, trainCodes, seatTypes) {
  return trainCodes.map((trainCode) => {
    const ticket = findTicket(query, trainCode);
    return {
      trainCode,
      found: Boolean(ticket),
      bookable: ticketCanSubmit(ticket),
      ticket: ticket ? ticketSummary(ticket) : null,
      seats: ticket
        ? Object.fromEntries(seatTypes.map((seatType) => [seatType, seatAvailabilityValue(ticket, seatType)]))
        : {},
      supportedSeats: ticket
        ? seatTypes.filter((seatType) => seatIsSupported(ticket, seatType))
        : [],
    };
  });
}

export function parseSaleTime(ticket, now = new Date()) {
  const text = ticket?.buttonTextInfo || '';
  const match = text.match(/(\d{1,2})点(\d{1,2})分起售/) || text.match(/(\d{1,2}):(\d{1,2})起售/);
  if (!match) return null;

  const saleTime = new Date(now);
  saleTime.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return saleTime;
}

export function nextGrabDelay({ query, trainCodes, now = new Date() }) {
  const saleTimes = trainCodes
    .map((trainCode) => parseSaleTime(findTicket(query, trainCode), now))
    .filter(Boolean)
    .sort((left, right) => left - right);
  const saleTime = saleTimes[0] || null;
  if (!saleTime) return { delayMs: 1000, reason: 'no_sale_time' };

  const diffMs = saleTime.getTime() - now.getTime();
  if (diffMs > 90_000) return { delayMs: 60_000, reason: 'sale_time_far', saleTime: saleTime.toISOString(), diffMs };
  if (diffMs > 0) return { delayMs: 1000, reason: 'sale_time_near', saleTime: saleTime.toISOString(), diffMs };
  if (diffMs >= -120_000) return { delayMs: 500, reason: 'just_after_sale_time', saleTime: saleTime.toISOString(), diffMs };
  return { delayMs: 1000, reason: 'after_sale_window', saleTime: saleTime.toISOString(), diffMs };
}

export async function queryTickets({ from, to, date, purpose = 'ADULT', session = null, createTicketSession = defaultCreateTicketSession }) {
  if (!from || !to || !date) {
    throw new Error('from, to and date are required, e.g. queryTickets({ from: "<from>", to: "<to>", date: "YYYY-MM-DD" })');
  }

  const activeSession = session || (await createTicketSession());
  const fromCode = stationCode(from);
  const toCode = stationCode(to);
  const url = new URL(`${BASE}/otn/leftTicket/queryG`);

  url.searchParams.set('leftTicketDTO.train_date', date);
  url.searchParams.set('leftTicketDTO.from_station', fromCode);
  url.searchParams.set('leftTicketDTO.to_station', toCode);
  url.searchParams.set('purpose_codes', purpose);

  const response = await request(activeSession.jar, url.toString(), {
    headers: {
      Referer: LEFT_TICKET_REFERER,
    },
  });

  const result = response.data?.result || [];
  const stationMap = response.data?.map || {};
  const tickets = result.map((item) => parseTicket(item, stationMap));

  return {
    ok: Boolean(response.status),
    stage: 'query_tickets',
    query: { date, from, fromCode, to, toCode, purpose },
    count: tickets.length,
    tickets,
  };
}
