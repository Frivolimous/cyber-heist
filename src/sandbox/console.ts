// The console: a command line over the player's screen, opened and closed with the ` key.
// It reads only the player's view and plays EXECUTE / CONNECT actions like any page does (terminal.ts parses).

import type { Action, ActionResult, PlayerId, PlayerView, SystemId } from '../engine';
import { forHistory, interpret, keyring, promptText } from './terminal';
import type { TermLine } from './terminal';

export interface ConsoleDeps {
  host: HTMLElement;
  view: () => PlayerView;
  seat: () => PlayerId;
  act: (action: Action) => Promise<ActionResult>;
  /** After an action: redraw what the game changed. */
  refresh: () => void;
}

interface SeatConsole {
  started: boolean;
  loaded: SystemId[];
  out: TermLine[];
  history: string[];
  /** Up/down position in the history (history.length = the line being typed). */
  at: number;
  draft: string;
}

const LINES = 300;
const esc = (v: string): string => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const typing = (el: Element | null): boolean => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);

export function mountConsole(d: ConsoleDeps): { render: () => void; printJob: (text: string, ok: boolean) => void } {
  const seats: Record<PlayerId, SeatConsole> = {};
  let open = false;
  let busy = false;
  const st = (): SeatConsole => (seats[d.seat()] ??= { started: false, loaded: [], out: [], history: [], at: 0, draft: '' });

  d.host.innerHTML = `
    <div class="console-head"><b>Console</b><span>help for commands · \` to close</span></div>
    <div class="console-out out" aria-live="polite"></div>
    <label class="console-line"><span class="console-prompt"></span><input class="console-in" spellcheck="false" autocomplete="off" aria-label="Console command"></label>`;
  const outEl = d.host.querySelector<HTMLElement>('.console-out')!;
  const promptEl = d.host.querySelector<HTMLElement>('.console-prompt')!;
  const input = d.host.querySelector<HTMLInputElement>('.console-in')!;

  const push = (...lines: TermLine[]): void => {
    const s = st();
    s.out.push(...lines);
    if (s.out.length > LINES) s.out.splice(0, s.out.length - LINES);
  };

  function render(): void {
    d.host.classList.toggle('open', open);
    d.host.setAttribute('aria-hidden', String(!open));
    if (!open) {
      input.blur(); // keys go back to the page while it slides away
      return;
    }
    const s = st();
    outEl.innerHTML = s.out.map((l) => `<div class="${l.cls}">${esc(l.text)}</div>`).join('');
    outEl.scrollTop = outEl.scrollHeight;
    promptEl.textContent = promptText(s.loaded);
  }

  function load(ids: SystemId[]): void {
    const s = st();
    for (const sys of d.view().systems.filter((x) => ids.includes(x.id))) {
      if (!s.loaded.includes(sys.id)) s.loaded.push(sys.id);
      push({ cls: 'ok', text: `Loaded ${sys.label} (${sys.address})` });
    }
    s.loaded.sort((a, b) => d.view().systems.findIndex((x) => x.id === a) - d.view().systems.findIndex((x) => x.id === b));
  }

  /** Runs one line, as typed or as the opening sequence types it. */
  async function run(line: string): Promise<void> {
    const s = st();
    push({ cls: 'cmd', text: `${promptText(s.loaded)} ${line}` });
    const step = interpret(d.view(), s.loaded, line);
    switch (step.kind) {
      case 'print':
        push(...step.lines);
        break;
      case 'clear':
        s.out = [];
        break;
      case 'close':
        open = false;
        break;
      case 'unload':
        s.loaded = step.ids === 'ALL' ? [] : s.loaded.filter((id) => !(step.ids as SystemId[]).includes(id));
        push({ cls: 'dim', text: s.loaded.length ? `Still loaded: ${promptText(s.loaded).slice(0, -1)}` : 'Nothing is loaded.' });
        break;
      case 'load': {
        load(step.ids);
        // An address the screen does not know yet: ask the network, as the address bar does.
        for (const address of step.unknown) {
          const r = await d.act({ type: 'CONNECT', playerId: d.seat(), address });
          d.refresh();
          const sys = d.view().systems.find((x) => x.address === address);
          if (!r.ok) push({ cls: 'bad', text: `${address}: ${r.message}` });
          else if (sys) load([sys.id]);
          else push({ cls: 'bad', text: `${address}: ${r.workstation ? 'that is a workstation' : r.proxy ? 'that is a proxy relay' : 'nothing to load there'}, not a system.` });
        }
        break;
      }
      case 'execute': {
        push({ cls: 'dim', text: step.header });
        const r = await d.act({ type: 'EXECUTE', playerId: d.seat(), code: step.code, system: step.system, module: step.module, fn: step.fn, params: step.params, encCodes: step.encCodes });
        push({ cls: r.ok ? 'ok' : 'bad', text: r.message }, ...(r.lines ?? []).map((text) => ({ cls: 'row' as const, text })));
        d.refresh();
        break;
      }
    }
  }

  async function submit(line: string): Promise<void> {
    const s = st();
    if (line.trim()) {
      const kept = forHistory(line.trim());
      if (s.history[s.history.length - 1] !== kept) s.history.push(kept);
    }
    s.at = s.history.length;
    s.draft = '';
    busy = true;
    try {
      await run(line.trim());
    } finally {
      busy = false;
    }
    render();
  }

  async function show(): Promise<void> {
    open = true;
    const s = st();
    input.value = s.draft;
    render();
    input.focus();
    if (s.started) return;
    // The first time: log in with the keyring and load the whole bank.
    s.started = true;
    push({ cls: 'cmd', text: `${promptText(s.loaded)} login` }, ...keyring(d.view()));
    await run('load all');
    push({ cls: 'dim', text: 'Type help for what you can run here.' });
    render();
  }

  function hide(): void {
    st().draft = input.value;
    open = false;
    render();
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== '`' || e.ctrlKey || e.metaKey || e.altKey) return;
    const inConsole = document.activeElement === input;
    if (!inConsole && typing(document.activeElement)) return; // a backtick typed into a page's field
    e.preventDefault();
    if (open) hide();
    else void show();
  });

  input.addEventListener('keydown', (e) => {
    const s = st();
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (busy) return;
      const line = input.value;
      input.value = '';
      void submit(line);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (s.at === s.history.length) s.draft = input.value;
      s.at = Math.max(0, Math.min(s.history.length, s.at + (e.key === 'ArrowUp' ? -1 : 1)));
      input.value = s.at === s.history.length ? s.draft : s.history[s.at];
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
  // Clicking the output keeps the focus on the command line (unless text is being selected).
  outEl.addEventListener('mouseup', () => {
    if (!window.getSelection()?.toString()) input.focus();
  });

  return {
    render,
    /** A timed action of this seat finished: say so here too, once the console has been opened. */
    printJob: (text, ok) => {
      if (!st().started) return;
      push({ cls: ok ? 'ok' : 'bad', text });
      render();
    },
  };
}
