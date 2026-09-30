// Custom settings: every tunable DEFAULT_CONFIG value as a form, behind a "Custom settings" button, for the
// sandbox's New game and a real game's lobby. Only values that differ from the defaults are passed to
// createGame, and the four values derived from the table size (targets, arrival rates) are not offered, so
// a custom game still scales with its table. The last settings used are remembered in this browser.

import './settings.css';
import { DEFAULT_CONFIG } from '../engine';
import type { Automation, GameConfig } from '../engine';

interface Field {
  key: string; // a GameConfig key, or automation.<key>
  label: string;
  select?: string[];
  int?: boolean; // whole numbers only
  min?: number; // default 0
  blank?: boolean; // may be left empty (null: the engine decides)
}
const GROUPS: { title: string; note?: string; fields: Field[] }[] = [
  { title: 'Game', fields: [{ key: 'durationSec', label: 'Game length (s)', int: true, min: 60 }] },
  {
    title: 'Targets',
    note: 'The test scenarios ignore the Black Hat count.',
    fields: [
      { key: 'whiteTargetPerPlayer', label: 'Bank target per player ($)' },
      { key: 'blackTargetPerHacker', label: 'Heist goal per Black Hat ($)', min: 1 },
      { key: 'blackHatCount', label: 'Black Hats (blank: a third of the table)', int: true, min: 1, blank: true },
    ],
  },
  {
    title: 'Volume',
    fields: [
      { key: 'volumePerPlayer', label: 'Payment volume per player ($)' },
      { key: 'requestEverySecPerBanker', label: 'Average seconds between requests, per banker', min: 1 },
      { key: 'customersPerBanker', label: 'Customers per banker', int: true, min: 1 },
      { key: 'requestChangeShare', label: 'Share of requests that change accounts (0-1)' },
      { key: 'urgentShare', label: 'Share of payment requests that are urgent (0-1)' },
    ],
  },
  {
    title: 'Amounts ($)',
    fields: [
      { key: 'npcMinAmount', label: 'Automatic payment, min' },
      { key: 'npcMaxAmount', label: 'Automatic payment, max' },
      { key: 'requestMinAmount', label: 'Requested payment, min (before multiplier)' },
      { key: 'requestMaxAmount', label: 'Requested payment, max (before multiplier)' },
      { key: 'requestAmountFactor', label: 'Requested amount multiplier' },
      { key: 'maxManualAmount', label: 'Largest manual payment' },
      { key: 'largeAmount', label: 'Risk check flags payments above' },
    ],
  },
  {
    title: 'Customers',
    fields: [
      { key: 'requestDeadlineSec', label: 'Request deadline (s)', min: 1 },
      { key: 'urgentDeadlineSec', label: 'Urgent request deadline (s)', min: 1 },
      { key: 'strikesToSuspend', label: 'Missed requests before a customer leaves', int: true, min: 1 },
      { key: 'phishPerBankerMin', label: 'Phishing messages per banker, min', int: true },
      { key: 'phishPerBankerMax', label: 'Phishing messages per banker, max', int: true },
    ],
  },
  {
    title: 'Security timing',
    fields: [
      { key: 'traceCooldownSec', label: 'Trace cooldown (s)' },
      { key: 'traceMaxAgeSec', label: 'Trace age limit (s)' },
      { key: 'lockoutAfterFails', label: 'Wrong codes before a lockout', int: true, min: 1 },
      { key: 'lockoutSec', label: 'Lockout length (s)' },
      { key: 'blockSec', label: 'Firewall block length (s)' },
      { key: 'revokeCountdownSec', label: 'Revoke countdown (s)' },
      { key: 'unlockSec', label: 'Unlock workstation time (s)' },
      { key: 'crackRevealSec', label: 'Code crack: seconds per digit' },
      { key: 'reversalWindowSec', label: 'Reversal window (s)' },
      { key: 'recentModifySec', label: 'A changed primary counts as recent for (s)' },
    ],
  },
  {
    title: 'Automation at the start',
    fields: [
      { key: 'automation.scoreMax', label: 'Risk Check: auto-score up to ($, 0 = off)' },
      { key: 'automation.scoreSource', label: 'Risk Check: payments', select: ['AUTOMATIC', 'ALL'] },
      { key: 'automation.scoreOrigin', label: 'Risk Check: paid from', select: ['CUSTOMER', 'ANY'] },
      { key: 'automation.scorePayee', label: 'Risk Check: payee primary', select: ['VERIFIED', 'ANY'] },
      { key: 'automation.approveUpTo', label: 'Authorization: auto-approve up to', select: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
      { key: 'automation.settleMax', label: 'Settlement: auto-settle up to ($, 0 = off)' },
    ],
  },
];
const FIELDS = GROUPS.flatMap((g) => g.fields);
/** Pairs that must not cross. */
const MIN_MAX: [string, string][] = [
  ['npcMinAmount', 'npcMaxAmount'],
  ['requestMinAmount', 'requestMaxAmount'],
  ['phishPerBankerMin', 'phishPerBankerMax'],
];

type Values = Record<string, string>;

const defaultOf = (key: string): unknown =>
  key.startsWith('automation.') ? DEFAULT_CONFIG.automation[key.slice(11) as keyof Automation] : DEFAULT_CONFIG[key as keyof GameConfig];
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const esc = (v: string): string => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const STORE = 'cyberheist.customSettings';
/** The settings last used in this browser (only the changed ones). */
export function loadSettings(): Values {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Values;
    return Object.fromEntries(Object.entries(v).filter(([k, x]) => FIELDS.some((f) => f.key === k) && typeof x === 'string'));
  } catch {
    return {};
  }
}
function saveSettings(v: Values): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(v));
  } catch {
    /* private window or storage blocked: settings just aren't remembered */
  }
}

/** The form's changed values -> config overrides, or the problems to fix. */
export function toConfig(v: Values): { config: Partial<GameConfig>; errors: string[] } {
  const errors: string[] = [];
  const out: Record<string, unknown> = {};
  const auto: Partial<Automation> = {};
  const num = (f: Field): number | null | undefined => {
    const raw = (v[f.key] ?? '').trim().replace(/[$,_\s]/g, '');
    if (raw === '') {
      if (f.blank) return null;
      errors.push(`${f.label}: type a number.`);
      return undefined;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) errors.push(`${f.label}: "${v[f.key]}" is not a number.`);
    else if (f.int && !Number.isInteger(n)) errors.push(`${f.label}: a whole number.`);
    else if (n < (f.min ?? 0)) errors.push(`${f.label}: at least ${f.min ?? 0}.`);
    else if (f.key.endsWith('Share') && n > 1) errors.push(`${f.label}: between 0 and 1.`);
    else return n;
    return undefined;
  };
  for (const f of FIELDS) {
    if (!(f.key in v)) continue;
    const value = f.select ? v[f.key] : num(f);
    if (value === undefined) continue;
    if (f.key.startsWith('automation.')) (auto as Record<string, unknown>)[f.key.slice(11)] = value;
    else out[f.key] = value;
  }
  for (const [lo, hi] of MIN_MAX) {
    const a = (out[lo] ?? defaultOf(lo)) as number;
    const b = (out[hi] ?? defaultOf(hi)) as number;
    if (a > b) errors.push(`${FIELDS.find((f) => f.key === lo)!.label} is above the max.`);
  }
  if (Object.keys(auto).length) out.automation = { ...DEFAULT_CONFIG.automation, ...auto };
  return { config: out as Partial<GameConfig>, errors };
}

/**
 * Mounts the "Custom settings" button and its form into `el`. `onChange` gets the overrides whenever the form
 * changes (only valid ones; `errors` lists the rest). Returns the current overrides.
 */
export function mountSettings(el: HTMLElement, onChange?: (config: Partial<GameConfig>, errors: string[]) => void): () => { config: Partial<GameConfig>; errors: string[] } {
  let values = loadSettings();
  let open = false;
  const current = (): { config: Partial<GameConfig>; errors: string[] } => toConfig(values);
  const render = (): void => {
    const changed = Object.keys(values).length;
    const { errors } = current();
    el.innerHTML = `<div class="cfg">
      <button type="button" class="cfg-toggle ${changed ? 'on' : ''}" data-cfg="toggle" aria-expanded="${open}">Custom settings${changed ? ` (${changed} changed)` : ''}</button>
      ${open
        ? `<div class="cfg-panel">
          <p class="cfg-note">Applies to the next game. Blank a field or press Reset for the default. Targets and arrival rates still scale with the table.</p>
          ${GROUPS.map(
            (g) => `<fieldset><legend>${g.title}</legend>${g.note ? `<p class="cfg-note">${g.note}</p>` : ''}${g.fields
              .map((f) => {
                const def = text(defaultOf(f.key));
                const val = f.key in values ? values[f.key] : def;
                const mark = f.key in values ? 'changed' : '';
                const input = f.select
                  ? `<select data-cfg-key="${f.key}">${f.select.map((o) => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select>`
                  : `<input data-cfg-key="${f.key}" value="${esc(val)}" placeholder="${esc(def)}" inputmode="decimal" autocomplete="off">`;
                return `<label class="${mark}"><span>${f.label}</span>${input}</label>`;
              })
              .join('')}</fieldset>`,
          ).join('')}
          ${errors.length ? `<ul class="cfg-errors">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
          <button type="button" data-cfg="reset">Reset to defaults</button>
        </div>`
        : ''}
    </div>`;
  };
  const changed = (): void => {
    saveSettings(values);
    const c = current();
    onChange?.(c.config, c.errors);
  };
  el.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-cfg]')?.dataset.cfg;
    if (act === 'toggle') open = !open;
    else if (act === 'reset') {
      values = {};
      changed();
    } else return;
    render();
  });
  el.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement | HTMLSelectElement;
    const key = input.dataset.cfgKey;
    if (!key) return;
    const f = FIELDS.find((x) => x.key === key)!;
    const def = text(defaultOf(key));
    const typed = input.value.trim();
    // Blank means the default (except a field whose default is blank), and so does typing the default back.
    if ((typed === '' && !f.blank) || typed === def) delete values[key];
    else values[key] = typed;
    changed();
    render();
  });
  render();
  return current;
}
