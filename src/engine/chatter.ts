// Bot mode: what bots say to each other and to suspects (docs/BotMode.md, Telegraphing). Plain private messages
// a person can read; bots also read the ones in these exact forms. Anyone can write in these forms too, so a
// Social / Spoofed message in a colleague's name can fake a report: that is a fair attack on bots.

import type { ChangeWhat } from './botkit';

export type Heard =
  | { kind: 'REPORT'; customerId: string; account: string; what: ChangeWhat; by: string | null; stolen: boolean }
  | { kind: 'REPORT_LOG'; logId: string; message: string }
  | { kind: 'HOLD'; requestId: string; logId: string }
  | { kind: 'TRACE_ASK'; logId: string; requestId: string; banker: string }
  | { kind: 'TRACE_RESULT'; logId: string; requestId: string; clue: string }
  | { kind: 'UNDOING'; customerId: string; account: string }
  | { kind: 'QUESTION'; customerId: string; account: string; what: ChangeWhat }
  | { kind: 'NOT_ME'; customerId: string; account: string };

const change = (customerId: string, account: string, what: ChangeWhat): string => `${customerId}'s accounts were changed with no request (${account} ${what})`;

/** A tampering report to security. `by`: the name on the records, "ME" when it is the writer's own (their code was used), null if unknown. */
export function reportText(customerId: string, account: string, what: ChangeWhat, by: string | 'ME' | null, putBack: boolean): string {
  const who = by === 'ME' ? ' under my name. It wasn\'t me: my code was used.' : by ? ` under ${by}'s name.` : '. I don\'t know who did it.';
  return `Report: ${change(customerId, account, what)}${who}${putBack ? " I've put it back." : ''}`;
}

/** Asking whoever the records name (the warning a suspect gets at the gentler levels). */
export const questionText = (customerId: string, account: string, what: ChangeWhat): string =>
  `Did you change ${customerId}'s accounts (${account} ${what})? Nobody asked for that.`;

/** The answer from a colleague who did not do it. */
export const notMeText = (customerId: string, account: string): string =>
  `Not me: I didn't change ${customerId}'s accounts (${account}). Someone used my code.`;

export const revokingText = (ip: string, name: string, sec: number, why: string): string =>
  `I'm revoking all access for ${ip} (${name}) in ${sec}s: ${why}.`;

export const newCodeText = (credentialId: string): string =>
  `Someone used your code ${credentialId}, so I've revoked it and issued you a new one.`;

/** Something done under the writer's name that it did not do (any logged action). */
export const reportLogText = (logId: string, message: string): string => `Report: ${logId} ("${message}") was done under my name. It wasn't me: my code was used.`;

/** The Bank Manager to a banker: a request that arrived with a server alert. */
export const holdText = (requestId: string, logId: string): string => `Hold ${requestId}: it came in with a server alert (${logId}). I've asked for a trace.`;
export const traceAskText = (logId: string, requestId: string, banker: string): string => `Please trace ${logId}: it came in with ${requestId} (${banker}'s).`;
export const traceResultText = (logId: string, requestId: string, clue: string): string => `Trace of ${logId} for ${requestId}: ${clue}`;
/** A banker undoing what it did for a request it now thinks is a scam (so Verification does not take it for tampering). */
export const undoingText = (customerId: string, account: string, requestId: string): string =>
  `Undoing ${customerId}'s change (${account}) for ${requestId}: it looks like a scam.`;
export const scamText = (requestId: string, why: string): string => `Archived ${requestId} as a scam: ${why}.`;

const WHAT = '(made primary|added|removed)';

/** Reads a message in one of the forms above (null for anything else). */
export function hear(text: string): Heard | null {
  let m = new RegExp(`^Report: (CU\\d+)'s accounts were changed with no request \\((ACC-\\d{5}) ${WHAT}\\)( under my name\\. It wasn't me| under (.+?)'s name\\.|\\. I don't know who did it\\.)`).exec(text);
  if (m) {
    const stolen = m[4].startsWith(' under my name');
    return { kind: 'REPORT', customerId: m[1], account: m[2], what: m[3] as ChangeWhat, by: stolen ? null : (m[5] ?? null), stolen };
  }
  m = new RegExp(`^Did you change (CU\\d+)'s accounts \\((ACC-\\d{5}) ${WHAT}\\)\\?`).exec(text);
  if (m) return { kind: 'QUESTION', customerId: m[1], account: m[2], what: m[3] as ChangeWhat };
  m = /^Not me: I didn't change (CU\d+)'s accounts \((ACC-\d{5})\)\./.exec(text);
  if (m) return { kind: 'NOT_ME', customerId: m[1], account: m[2] };
  m = /^Report: (L\d+) \("([\s\S]*)"\) was done under my name\./.exec(text);
  if (m) return { kind: 'REPORT_LOG', logId: m[1], message: m[2] };
  m = /^Hold (REQ-\d+): it came in with a server alert \((L\d+)\)/.exec(text);
  if (m) return { kind: 'HOLD', requestId: m[1], logId: m[2] };
  m = /^Please trace (L\d+): it came in with (REQ-\d+) \((.+)'s\)\./.exec(text);
  if (m) return { kind: 'TRACE_ASK', logId: m[1], requestId: m[2], banker: m[3] };
  m = /^Trace of (L\d+) for (REQ-\d+): ([\s\S]*)$/.exec(text);
  if (m) return { kind: 'TRACE_RESULT', logId: m[1], requestId: m[2], clue: m[3] };
  m = /^Undoing (CU\d+)'s change \((ACC-\d{5})\)/.exec(text);
  if (m) return { kind: 'UNDOING', customerId: m[1], account: m[2] };
  return null;
}
