// The console: one command line for every function of every loaded system (opened with the ` key).
// Pure: it turns a typed line into a step for the screen to carry out, reading only the player's view.

import type { FnDef, ModuleDef, ParamSpec, PlayerView, SystemDef, SystemId } from '../engine';

export interface TermLine {
  cls: 'cmd' | 'ok' | 'bad' | 'row' | 'dim';
  text: string;
}

/** What a line asks for. The screen carries it out (only `execute` and `load` of an unknown address touch the game). */
export type TermStep =
  | { kind: 'print'; lines: TermLine[] }
  | { kind: 'clear' }
  | { kind: 'close' }
  | { kind: 'load'; ids: SystemId[]; unknown: string[] }
  | { kind: 'unload'; ids: SystemId[] | 'ALL' }
  | {
      kind: 'execute';
      system: SystemId;
      module: string;
      fn: string;
      params: Record<string, string>;
      code: string;
      encCodes: string[];
      /** The command as it is echoed: "[Payment Queue] > View queue (C3, yours)". */
      header: string;
    };

type Credential = PlayerView['me']['credentials'][number];

const BANK: SystemId[] = ['SECURITY', 'CLIENT_DATA', 'TRANSACTIONS'];
const SHORT: Partial<Record<SystemId, string>> = { SECURITY: 'security', CLIENT_DATA: 'client_data', TRANSACTIONS: 'transactions', HIDDEN_HOST: 'host' };

/** "view-queue", "View_Queue" -> "VIEW_QUEUE". */
const norm = (v: string): string => v.trim().toUpperCase().replace(/[-\s]+/g, '_');
/** For comparing parameter names: "make-primary", "makePrimary" -> "MAKEPRIMARY". */
const bare = (v: string): string => v.toUpperCase().replace(/[-_\s]/g, '');
const lower = (id: string): string => id.toLowerCase();
const print = (...lines: TermLine[]): TermStep => ({ kind: 'print', lines });
const bad = (text: string): TermStep => print({ cls: 'bad', text });

/** Splits a line into words; "double" or 'single' quotes keep spaces (name="a b" gives name=a b). */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** The prompt: what is loaded ("bank", "bank+host", "transactions"). */
export function promptText(loaded: SystemId[]): string {
  const bank = BANK.every((id) => loaded.includes(id));
  const parts = bank ? ['bank', ...loaded.filter((id) => !BANK.includes(id)).map((id) => SHORT[id] ?? lower(id))] : loaded.map((id) => SHORT[id] ?? lower(id));
  return `${parts.join('+') || 'no system'}>`;
}

/** The systems this player knows that are loaded, in catalog order. */
const loadedSystems = (v: PlayerView, loaded: SystemId[]): SystemDef[] => v.systems.filter((s) => loaded.includes(s.id));

interface Found {
  sys: SystemDef;
  mod: ModuleDef;
  def: FnDef;
}

/** Finds "[system] [module] function" at the start of the words; returns it and how many words it used. */
function findCommand(systems: SystemDef[], words: string[]): { found: Found; used: number } | null {
  let i = 0;
  let pool = systems;
  const sys = systems.find((s) => norm(s.id) === norm(words[0] ?? '') || SHORT[s.id] === lower(words[0] ?? ''));
  if (sys && words.length > 1) {
    pool = [sys];
    i = 1;
  }
  const modWord = norm(words[i] ?? '');
  for (const s of pool) {
    const mod = s.modules.find((m) => m.id === modWord);
    const def = mod?.fns.find((f) => f.id === norm(words[i + 1] ?? ''));
    if (mod && def) return { found: { sys: s, mod, def }, used: i + 2 };
  }
  const fnWord = norm(words[i] ?? '');
  for (const s of pool) {
    for (const mod of s.modules) {
      const def = mod.fns.find((f) => f.id === fnWord);
      if (def) return { found: { sys: s, mod, def }, used: i + 1 };
    }
  }
  return null;
}

/** Parameters in the order typed values fill them: required ones first, then optional ones. */
const fillOrder = (def: FnDef): ParamSpec[] => [...def.params.filter((p) => !p.optional), ...def.params.filter((p) => p.optional)];

function usage(def: FnDef): string {
  const part = (p: ParamSpec): string => {
    const body = p.kind === 'select' ? `${p.name}:${(p.options ?? []).map(lower).join('|')}` : p.name;
    return p.optional ? `[${body}]` : `<${body}>`;
  };
  return [lower(def.id), ...fillOrder(def).map(part)].join(' ');
}

/** The help page for one function. */
function fnHelp(f: Found): TermLine[] {
  const { sys, mod, def } = f;
  const lines: TermLine[] = [
    { cls: 'ok', text: `${def.label} (${def.permission}) on ${sys.label} / ${mod.label}` },
    { cls: 'row', text: def.description },
    { cls: 'row', text: `Usage: ${usage(def)}` },
  ];
  for (const p of def.params) {
    const hint = p.kind === 'select' ? `one of ${(p.options ?? []).map(lower).join(', ')} (or --${lower(p.options?.[0] ?? '')})` : p.placeholder ? `e.g. ${p.placeholder}` : '';
    lines.push({ cls: 'row', text: `  ${p.name}${p.optional ? ' (optional)' : ''}: ${p.label}${hint ? `, ${hint}` : ''}` });
  }
  if (def.params.length) lines.push({ cls: 'dim', text: '  Values fill these in order; name=value sets any of them. Add -c CODE to use a code of your choice.' });
  return lines;
}

const SESSION_HELP: TermLine[] = [
  { cls: 'ok', text: 'Console commands' },
  { cls: 'row', text: 'load all               load every bank system' },
  { cls: 'row', text: 'load <address>         load one system by its address (any system you can reach)' },
  { cls: 'row', text: 'unload [address|all]   unload a system, or all of them' },
  { cls: 'row', text: 'keys                   your keyring: the credentials the console uses for you' },
  { cls: 'row', text: 'help [command]         what is loaded, or how one command works' },
  { cls: 'row', text: 'clear, exit            clear the output, close the console (or press `)' },
  { cls: 'dim', text: 'Commands: [module] function [values] [--option] [name=value] [-c CODE]. Up and down arrows recall earlier lines.' },
];

function help(v: PlayerView, loaded: SystemId[], words: string[]): TermStep {
  const systems = loadedSystems(v, loaded);
  if (words.length === 0) {
    const lines = [...SESSION_HELP];
    if (!systems.length) lines.push({ cls: 'dim', text: 'Nothing is loaded yet: try "load all".' });
    for (const s of systems) {
      lines.push({ cls: 'ok', text: `${s.label} (${s.address})` });
      for (const m of s.modules) lines.push({ cls: 'row', text: `${lower(m.id).padEnd(18)} ${m.fns.map((f) => lower(f.id)).join(', ')}` });
    }
    if (systems.length) lines.push({ cls: 'dim', text: 'help <command> shows its values; the module name is optional.' });
    return { kind: 'print', lines };
  }
  const cmd = findCommand(systems, words);
  if (cmd) return print(...fnHelp(cmd.found));
  // A module or a system on its own: its functions.
  for (const s of systems) {
    if (words.length === 1 && (norm(s.id) === norm(words[0]) || SHORT[s.id] === lower(words[0]))) {
      return print({ cls: 'ok', text: `${s.label} (${s.address})` }, ...s.modules.map((m) => ({ cls: 'row' as const, text: `${lower(m.id).padEnd(18)} ${m.fns.map((f) => lower(f.id)).join(', ')}` })));
    }
    const mod = s.modules.find((m) => m.id === norm(words[words.length - 1]));
    if (mod) return print({ cls: 'ok', text: `${s.label} / ${mod.label}` }, ...mod.fns.map((f) => ({ cls: 'row' as const, text: `${lower(f.id).padEnd(22)} ${f.label} (${f.permission}): ${f.description}` })));
  }
  return notLoaded(v, loaded, words) ?? bad(`No command "${words.join(' ')}" on what is loaded. Type help for the list.`);
}

/** A command that exists on a known system that is not loaded: say where it is. */
function notLoaded(v: PlayerView, loaded: SystemId[], words: string[]): TermStep | null {
  const elsewhere = findCommand(v.systems.filter((s) => !loaded.includes(s.id)), words);
  if (!elsewhere) return null;
  const s = elsewhere.found.sys;
  return bad(s.hidden ? `${lower(elsewhere.found.def.id)} is on the unregistered host: load it by its address first.` : `${lower(elsewhere.found.def.id)} is on ${s.label}: load ${s.address} (or load all) first.`);
}

/** "400k", "$1,500,000", "1.5m" -> "400000", "1500000", "1500000". Anything else is passed on as typed. */
export function amountOf(v: string): string {
  const m = v.trim().replace(/[$,_]/g, '').match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (!m) return v;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? '').toLowerCase() as 'k' | 'm' | 'b'] ?? 1;
  return String(Math.round(Number(m[1]) * mult));
}

/** A typed value as the function takes it, or an error. */
function valueFor(v: PlayerView, p: ParamSpec, raw: string): { value: string } | { error: string } {
  switch (p.kind) {
    case 'select': {
      const n = norm(raw);
      return p.options?.includes(n) ? { value: n } : { error: `${p.name} must be one of ${(p.options ?? []).map(lower).join(', ')}.` };
    }
    case 'player': {
      const name = raw.trim().replace(/\s+/g, ' ').toLowerCase();
      const exact = v.players.find((x) => x.id === raw.trim() || x.name.toLowerCase() === name);
      const first = v.players.filter((x) => x.name.toLowerCase().split(' ')[0] === name);
      const who = exact ?? (first.length === 1 ? first[0] : undefined);
      return who ? { value: who.id } : { error: first.length > 1 ? `More than one employee is called ${raw}: type the full name.` : `No employee named ${raw}.` };
    }
    case 'module': {
      const ref = moduleRef(v, raw);
      return ref ? { value: ref } : { error: `No module "${raw}". Type it as system.module (transactions.settlement) or just the module (settlement).` };
    }
    case 'scope': {
      const n = norm(raw);
      const sys = v.systems.find((s) => !s.hidden && (s.id === n || SHORT[s.id] === lower(raw.trim()) || norm(s.label) === n));
      if (sys || /\.\*$/.test(n)) return { value: sys ? `${sys.id}.*` : n };
      const ref = moduleRef(v, raw);
      return ref ? { value: ref } : { error: `No scope "${raw}". Type a system (client_data) or a module (client_data.verification).` };
    }
    case 'number':
      return { value: amountOf(raw) };
    default:
      return { value: /^(amount|maxAmount)$/.test(p.name) ? amountOf(raw) : raw };
  }
}

/** "transactions.settlement", "TRANSACTIONS.SETTLEMENT", "settlement" or "Payment Queue" -> "TRANSACTIONS.SETTLEMENT". */
function moduleRef(v: PlayerView, raw: string): string | null {
  const [a, b] = raw.trim().split('.');
  if (b !== undefined) {
    const sys = v.systems.find((s) => s.id === norm(a) || SHORT[s.id] === lower(a.trim()));
    const mod = sys?.modules.find((m) => m.id === norm(b));
    return sys && mod ? `${sys.id}.${mod.id}` : null;
  }
  const hits = v.systems.flatMap((s) => s.modules.filter((m) => m.id === norm(a) || norm(m.label) === norm(a)).map((m) => `${s.id}.${m.id}`));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The credential the console uses for a function: the narrowest active one of your own that covers it.
 * Credentials you hold that are someone else's are only ever used when you type their code (-c).
 */
export function keyFor(v: PlayerView, system: SystemId, module: string, def: FnDef): Credential | undefined {
  const covers = (c: Credential): boolean =>
    c.status === 'ACTIVE' && c.system === system && (c.module === null || c.module === module) && (c.fn === null || c.fn === def.id) && (c.permission === 'WRITE' || def.permission === 'READ');
  const width = (c: Credential): number => (c.fn ? 0 : c.module ? 1 : 2) * 2 + (c.permission === def.permission ? 0 : 1);
  return v.me.credentials.filter((c) => c.own && covers(c)).sort((a, b) => width(a) - width(b))[0];
}

/** A function command: its values, then which code it runs with. */
function command(v: PlayerView, loaded: SystemId[], words: string[]): TermStep {
  const cmd = findCommand(loadedSystems(v, loaded), words);
  if (!cmd) return notLoaded(v, loaded, words) ?? bad(`Unknown command "${words[0]}". Type help for the list.`);
  const { sys, mod, def } = cmd.found;
  const rest = words.slice(cmd.used);
  const params: Record<string, string> = {};
  const positional: string[] = [];
  let code: string | null = null;
  let enc: string[] = [];

  const set = (p: ParamSpec, raw: string): string | null => {
    const r = valueFor(v, p, raw);
    if ('error' in r) return r.error;
    params[p.name] = r.value;
    return null;
  };

  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    const flag = /^(-c|--code|--enc)(?:=(.*))?$/i.exec(w);
    if (flag) {
      const value = flag[2] ?? rest[++i];
      if (value === undefined) return bad(`${flag[1]} needs a value.`);
      if (flag[1].toLowerCase() === '--enc') enc = value.split(/[\s,]+/).filter(Boolean);
      else code = value.trim();
      continue;
    }
    if (/^--[a-z]/i.test(w)) {
      const f = norm(w.slice(2));
      const open = def.params.filter((p) => p.kind === 'select' && !(p.name in params));
      const byName = open.find((p) => bare(p.name) === bare(f) && p.options?.includes('YES'));
      const byOption = open.filter((p) => p.options?.includes(f));
      if (byName) params[byName.name] = 'YES';
      else if (byOption.length === 1) params[byOption[0].name] = f;
      else if (byOption.length > 1) return bad(`--${lower(f)} fits more than one value (${byOption.map((p) => p.name).join(', ')}): use name=${lower(f)}.`);
      else return bad(`${lower(def.id)} has no option --${lower(f)}. Type help ${lower(def.id)}.`);
      continue;
    }
    const named = /^([a-z][\w-]*)=(.*)$/is.exec(w);
    const param = named ? def.params.find((p) => bare(p.name) === bare(named[1])) : undefined;
    if (named && param) {
      const err = set(param, named[2]);
      if (err) return bad(err);
      continue;
    }
    if (named && !param && def.params.every((p) => p.kind === 'select' || p.kind === 'number')) {
      return bad(`${lower(def.id)} has no value called ${named[1]}. Type help ${lower(def.id)}.`);
    }
    positional.push(w);
  }

  // Typed values fill the rest in order; extra words run on into the last text value (a reason, a message).
  const slots = fillOrder(def).filter((p) => !(p.name in params));
  let last: ParamSpec | null = null;
  for (const raw of positional) {
    const p = slots.shift();
    if (!p) {
      if (last && last.kind === 'text') {
        params[last.name] += ` ${raw}`;
        continue;
      }
      return bad(`Too many values. Usage: ${usage(def)}`);
    }
    const err = set(p, raw);
    if (err) return bad(err);
    last = p;
  }
  const missing = def.params.filter((p) => !p.optional && !(p.name in params));
  if (missing.length) return bad(`Missing ${missing.map((p) => p.name).join(', ')}. Usage: ${usage(def)}`);

  // Which code: one typed with -c, none on a module whose security is off, else your own keyring.
  let who: string;
  let useCode: string;
  if (code !== null) {
    useCode = code;
    who = 'code typed';
  } else if (v.openModules.includes(`${sys.id}.${mod.id}`)) {
    useCode = '';
    who = 'security off: anonymous';
  } else {
    const key = keyFor(v, sys.id, mod.id, def);
    if (!key) {
      const theirs = v.me.credentials.find((c) => !c.own && c.status === 'ACTIVE' && c.system === sys.id && (c.module === null || c.module === mod.id));
      return bad(
        theirs
          ? `None of your own credentials covers ${def.label}. ${theirs.id} (${theirs.ownerName}'s) might: the console only uses someone else's code if you type it, with -c.`
          : `No credential of yours covers ${def.label} on ${mod.label}. Add -c CODE to use a code you know.`,
      );
    }
    useCode = key.code;
    who = `${key.id}, yours`;
  }
  return { kind: 'execute', system: sys.id, module: mod.id, fn: def.id, params, code: useCode, encCodes: enc, header: `[${mod.label}] > ${def.label} (${who})` };
}

/** Reads one typed line. */
export function interpret(v: PlayerView, loaded: SystemId[], line: string): TermStep {
  const words = tokenize(line);
  if (!words.length) return print();
  const head = words[0].toLowerCase();
  const args = words.slice(1);
  switch (head) {
    case 'help':
    case '?':
      return help(v, loaded, args);
    case 'clear':
    case 'cls':
      return { kind: 'clear' };
    case 'exit':
    case 'quit':
    case 'close':
      return { kind: 'close' };
    case 'keys':
    case 'login':
    case 'whoami':
      return print(...keyring(v));
    case 'load': {
      if (!args.length) {
        const ls = loadedSystems(v, loaded);
        return ls.length ? print(...ls.map((s) => ({ cls: 'row' as const, text: `${s.address.padEnd(12)} ${s.label}` }))) : print({ cls: 'dim', text: 'Nothing is loaded. load all, or load <address>.' });
      }
      const ids: SystemId[] = [];
      const unknown: string[] = [];
      for (const a of args) {
        if (a.toLowerCase() === 'all') ids.push(...v.systems.filter((s) => !s.hidden).map((s) => s.id));
        else {
          const sys = v.systems.find((s) => s.address === a.trim());
          if (sys) ids.push(sys.id);
          else unknown.push(a.trim());
        }
      }
      return { kind: 'load', ids: [...new Set(ids)], unknown };
    }
    case 'unload': {
      if (!args.length || args.some((a) => a.toLowerCase() === 'all')) return { kind: 'unload', ids: 'ALL' };
      const ids = args.map((a) => v.systems.find((s) => s.address === a.trim() || SHORT[s.id] === a.toLowerCase())?.id);
      if (ids.some((id) => !id)) return bad('Unload what? Type a loaded system\'s address.');
      return { kind: 'unload', ids: ids as SystemId[] };
    }
    default:
      return command(v, loaded, words);
  }
}

/** The keyring, as "keys" prints it. */
export function keyring(v: PlayerView): TermLine[] {
  const creds = v.me.credentials.filter((c) => c.status === 'ACTIVE');
  if (!creds.length) return [{ cls: 'dim', text: 'Your keyring is empty.' }];
  const own = creds.filter((c) => c.own);
  return [
    { cls: 'ok', text: `Keyring: ${own.length} credential${own.length === 1 ? '' : 's'} of your own, used for you` },
    ...creds.map((c) => ({ cls: (c.own ? 'row' : 'dim') as TermLine['cls'], text: `${c.id.padEnd(5)} ${c.scope.padEnd(40)} ${c.own ? 'yours' : `${c.ownerName}'s: only with -c`}` })),
  ];
}

/** History keeps what was typed, without codes: a recalled line needs its code typed again. */
export const forHistory = (line: string): string => line.replace(/(^|\s)(-c|--code)(=|\s+)\S+/gi, '$1$2$3').trimEnd();
