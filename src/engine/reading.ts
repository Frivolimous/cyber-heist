// Bot mode: reading a client request the way a banker does, from its words and Customer Records only
// (docs/BotMode.md). Never from the request's hidden fields: a bot sees what the Client Requests page shows.

import type { CustomerRow, RequestRow } from './perception';

export type AskKind = 'PAYMENT' | 'ADD_ACCOUNT' | 'ADD_AND_PRIMARY' | 'SET_PRIMARY' | 'REMOVE_ACCOUNT';

/** Where a payment request says to pay from. */
export type PayFrom = { form: 'MAIN' } | { form: 'NUMBER'; account: string } | { form: 'OTHER' };

export interface Ask {
  /** PHISH: the sender is not a customer of the bank. UNREADABLE: nothing this reader understands. */
  kind: AskKind | 'PHISH' | 'UNREADABLE';
  /** The customer it comes from (their tag), when the sender is one. */
  customerId: string | null;
  amount: number | null;
  /** The payee's tag: given in the request, or looked up by name. */
  payeeId: string | null;
  from: PayFrom | null;
  /** Account requests: the account (ACC-12345). */
  account: string | null;
  urgent: boolean;
}

const ACC = (digits: string): string => `ACC-${digits}`;

/** Which account change an account request asks for, from its wording. */
function accountKind(text: string): AskKind {
  if (/\b(remove|closed|no longer|delete|don't use|take it off)\b/i.test(text)) return 'REMOVE_ACCOUNT';
  const primaryWords = /\b(primary|main account|incoming|pay everything|payments to us should go|paid into)\b/i.test(text);
  const newWords = /\b(new|opened|set up|moved banks|consolidating)\b/i.test(text);
  if (primaryWords && newWords) return 'ADD_AND_PRIMARY';
  if (primaryWords) return 'SET_PRIMARY';
  return 'ADD_ACCOUNT';
}

/**
 * What a request asks for. `customers` is Customer Records (all customers) as last seen: the sender must be on it
 * by name, and a payee named without a tag is looked up there (the longest name found in the text, other than the
 * sender's, wins).
 */
export function readRequest(row: Pick<RequestRow, 'from' | 'text' | 'urgent'>, customers: CustomerRow[]): Ask {
  const ask: Ask = { kind: 'UNREADABLE', customerId: null, amount: null, payeeId: null, from: null, account: null, urgent: row.urgent };
  const sender = customers.find((c) => c.name === row.from);
  if (!sender) return { ...ask, kind: 'PHISH' };
  ask.customerId = sender.id;
  const text = row.text;
  const amt = /\$([\d,]+)/.exec(text);
  if (amt) {
    ask.kind = 'PAYMENT';
    ask.amount = Number(amt[1].replace(/,/g, ''));
    const tag = /\((CU\d+)\)/.exec(text);
    if (tag) ask.payeeId = tag[1];
    else {
      const named = customers.filter((c) => c.id !== sender.id && text.includes(c.name)).sort((a, b) => b.name.length - a.name.length);
      ask.payeeId = named[0]?.id ?? null;
    }
    let m = /from our main account, (\d{5})/.exec(text) ?? /from our account (\d{5})/.exec(text);
    if (m) ask.from = { form: 'NUMBER', account: ACC(m[1]) };
    else if (/from our main account/.test(text)) ask.from = { form: 'MAIN' };
    else if (/other accounts?/.test(text)) ask.from = { form: 'OTHER' };
    if (!ask.payeeId || !ask.from) ask.kind = 'UNREADABLE';
    return ask;
  }
  const acct = /\b(\d{5})\b/.exec(text);
  if (!acct) return ask;
  ask.account = ACC(acct[1]);
  ask.kind = accountKind(text);
  return ask;
}
