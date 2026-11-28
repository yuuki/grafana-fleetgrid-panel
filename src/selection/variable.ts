import { needsQuoteEscaping, toRegex } from './exportFormats';

/** What a dashboard variable holds, and what `var-<name>` is set to: one value or a list. */
export type VariableValue = string | string[];

/** The fields of Grafana's variable models (`getTemplateSrv().getVariables()`) that the sync reads. */
export interface VariableLike {
  name: string;
  type: string;
  multi?: boolean;
  current?: { value?: unknown };
}

/** The slice of the browser and of `@grafana/runtime` that the sync uses, so tests can stand in for it. */
export interface VariableRuntime {
  getVariables(): VariableLike[];
  /** `locationService.partial(query, true)`: the documented way for a plugin to set a variable. */
  setQuery(query: Record<string, VariableValue>): void;
  /** The path of the page without its query: the same for every view of one dashboard. */
  path(): string;
  /** Milliseconds, as `Date.now()`. */
  now(): number;
}

export type SyncStatus =
  | { state: 'off' }
  /** A variable is configured and this panel has nothing selected. */
  | { state: 'idle'; name: string }
  /** No hierarchy label is configured to sync by. */
  | { state: 'noLabel'; name: string }
  /** The value was written and Grafana has not been seen to hold it yet. */
  | { state: 'writing'; name: string }
  /** Read back: the variable holds the selection. `others` panels have a selection in it too. */
  | { state: 'synced'; name: string; others: number }
  /** The variable held the selection and now holds something else. */
  | { state: 'changed'; name: string }
  /** Grafana did not keep the value that was written. */
  | { state: 'rejected'; name: string }
  | { state: 'missing'; name: string }
  | { state: 'unsupported'; name: string; type: string }
  /** A custom or query variable that takes one value. */
  | { state: 'single'; name: string }
  /** The variable holds nothing that could be put back when the selection ends. */
  | { state: 'unrestorable'; name: string }
  /** A selected value is Grafana's own token for "All". */
  | { state: 'reserved'; name: string }
  /** A text box would get a regular expression that a quoted string reads differently. */
  | { state: 'unquotable'; name: string }
  | { state: 'tooLarge'; name: string; length: number }
  | { state: 'failed'; name: string };

/**
 * The longest `var-<name>=…` query the sync adds to the dashboard URL, in percent-encoded
 * characters. Reverse proxies commonly reject a request line above 8 KB, and the URL is sent to the
 * server whenever the dashboard is reloaded or shared; this leaves 2 KB for the rest of it.
 */
export const MAX_URL_CHARS = 6000;

/**
 * How long Grafana gets to show a written value before the write counts as not kept. Grafana applies
 * a URL change to its variables within a few milliseconds, also while the query of a query variable
 * is slow (measured with a 4 s variable query in Grafana 11.6.0 and 13.3.1). The margin is for a page
 * whose main thread is busy: a verdict that comes too early would take a good write back.
 */
export const CONFIRM_MS = 5000;

/** The value Grafana gives a variable that is set to "All". A label value equal to it cannot be synced. */
export const ALL_VALUE = '$__all';

/** The variable an option names: `host`, `$host` and `${host}` are the same variable. */
export function variableName(option: string | undefined): string {
  return (option ?? '')
    .trim()
    .replace(/^\$\{(.*)\}$/, '$1')
    .replace(/^\$/, '')
    .trim();
}

function asValue(value: unknown): VariableValue | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : undefined;
}

export type VariableTarget =
  | { status: 'missing' }
  | { status: 'unsupported'; type: string }
  | { status: 'single' }
  | { status: 'ok'; multi: boolean; value: VariableValue | undefined };

/**
 * Whether a variable can hold a selection, and what it holds now.
 *
 * - A custom or query variable with Multi-value holds the selected values themselves.
 * - A text box holds one regular expression.
 * - A custom or query variable that takes one value is refused. It could hold only a regular
 *   expression that is not one of its options, and Grafana does not keep such a value: it puts a
 *   query variable back to an option at the next refresh, and with "Include All option" its data
 *   sources escape the expression, so that it matches nothing.
 * - Every other type holds something else than label values (a constant, an interval, a data
 *   source, ad hoc filters).
 */
export function describeVariable(variables: VariableLike[], name: string): VariableTarget {
  const variable = variables.find((candidate) => candidate.name === name);
  if (!variable) {
    return { status: 'missing' };
  }
  if (variable.type === 'textbox') {
    return { status: 'ok', multi: false, value: asValue(variable.current?.value) };
  }
  if (variable.type !== 'custom' && variable.type !== 'query') {
    return { status: 'unsupported', type: variable.type };
  }
  if (variable.multi !== true) {
    return { status: 'single' };
  }
  return { status: 'ok', multi: true, value: asValue(variable.current?.value) };
}

/**
 * The value a variable gets for the selected label values. A multi-value variable gets the values
 * themselves: Grafana formats and escapes them for each query that uses the variable. A text box
 * gets one regular expression that matches exactly these values. Grafana puts it into a query as
 * text, and whether a backslash in it is escaped on the way depends on the data source, so the sync
 * writes only an expression that a quoted string reads as it is (`needsQuoteEscaping`).
 */
export function variableValueFor(values: string[], multi: boolean): VariableValue {
  return multi ? values : toRegex(values);
}

/** The percent-encoded length of the `var-<name>=value` pairs. Infinity when a value cannot be encoded. */
export function urlLength(name: string, value: VariableValue): number {
  try {
    const key = encodeURIComponent(`var-${name}`).length;
    return (Array.isArray(value) ? value : [value]).reduce(
      (total, item) => total + key + 1 + encodeURIComponent(item).length + 1,
      0
    );
  } catch {
    // A lone surrogate has no percent-encoding.
    return Infinity;
  }
}

/** Whether two variable values hold the same values. Grafana reports "All" as `$__all` or `[$__all]`. */
export function sameVariableValue(a: VariableValue | undefined, b: VariableValue | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  const left = [...new Set(Array.isArray(a) ? a : [a])].sort();
  const right = [...new Set(Array.isArray(b) ? b : [b])].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Whether a value can be written back later. Grafana drops an empty list from the URL and keeps what
// the variable holds, so a multi-value variable without a value cannot be restored. A text box can
// be empty.
function restorable(value: VariableValue | undefined, multi: boolean): value is VariableValue {
  if (value === undefined) {
    return false;
  }
  return multi ? value.length > 0 : typeof value === 'string';
}

// The variable while it is the sync's: what it held before the first write, and what was written.
interface Hold {
  original: VariableValue;
  written: VariableValue;
  /** The page the write was made on. The sync never writes to another page. */
  path: string;
  writtenAt: number;
  /** Grafana has been seen to hold `written`. */
  confirmed: boolean;
}

interface Entry {
  /** The values each panel wants in the variable. A panel without a selection has no claim. */
  claims: Map<object, string[]>;
  hold?: Hold;
  /**
   * What was written last. It stays after the variable is lost, so that the same values are not
   * written again: only a change of the selection writes.
   */
  attempted?: VariableValue;
  status: SyncStatus;
}

/**
 * Keeps dashboard variables equal to the cell selections of the panels that sync to them.
 *
 * One instance serves every FleetGrid panel of the page, because a variable belongs to the
 * dashboard, not to a panel. Per variable it knows which panels have a selection (their claims), the
 * value the variable had before the first write, and what was written.
 *
 * - The variable gets the union of the claims. Two panels, or the copies of a repeated panel, add
 *   their selections up; when one is cleared the others remain; when the last one is cleared the
 *   variable gets its original value back.
 * - A status is "synced" only after the variable has been read back and holds what was written.
 *   `verify()` reads it back again and again, because Grafana can change a variable at any time: a
 *   refresh re-validates a query variable against its options, and a user can pick another value.
 * - A variable that holds something else than what was written is no longer the sync's. It is not
 *   written again until a selection changes, and it is not "restored" when the selections end.
 * - A write happens only when the union of the claims differs from the last write. The claims hold
 *   the values remembered when the cells were selected, so no data update changes them, including
 *   the update that the panel's own write causes when its query uses the variable.
 */
export class VariableSync {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly runtime: VariableRuntime) {}

  /** Calls `listener` whenever a status may have changed. Returns the function that stops it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** States the values `owner` (a panel) wants `name` to hold. An empty list withdraws its claim. */
  claim(name: string, owner: object, values: string[]): void {
    let entry = this.entries.get(name);
    if (!entry) {
      if (values.length === 0) {
        return;
      }
      entry = { claims: new Map(), status: { state: 'writing', name } };
      this.entries.set(name, entry);
    }
    if (values.length === 0) {
      entry.claims.delete(owner);
    } else {
      entry.claims.set(owner, values);
    }
    try {
      this.apply(name, entry);
    } catch {
      // Grafana could not take the write (a value that has no URL encoding, a missing service).
      entry.hold = undefined;
      entry.status = { state: 'failed', name };
    }
    if (entry.claims.size === 0) {
      this.entries.delete(name);
    }
    this.notify();
  }

  /** Reads every synced variable back. Statuses follow what the variables hold now. */
  verify(): void {
    const variables = this.runtime.getVariables();
    let changed = false;
    for (const [name, entry] of this.entries) {
      const before = JSON.stringify(entry.status);
      this.check(name, entry, describeVariable(variables, name));
      changed = changed || JSON.stringify(entry.status) !== before;
    }
    if (changed) {
      this.notify();
    }
  }

  /** The state of the sync of `name` as `owner` must show it. */
  status(name: string, owner: object): SyncStatus {
    const entry = this.entries.get(name);
    if (!entry?.claims.has(owner)) {
      return { state: 'idle', name };
    }
    return entry.status.state === 'synced' ? { ...entry.status, others: entry.claims.size - 1 } : entry.status;
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  // The distinct values of all claims, in a stable order.
  private union(entry: Entry): string[] {
    return [...new Set([...entry.claims.values()].flat())].sort();
  }

  // Decides what the variable must hold after the claims changed, and writes it when that is new.
  private apply(name: string, entry: Entry): void {
    const values = this.union(entry);
    const target = describeVariable(this.runtime.getVariables(), name);
    if (values.length === 0) {
      this.giveBack(name, entry, target);
      return;
    }
    if (target.status !== 'ok') {
      entry.hold = undefined;
      entry.attempted = undefined;
      entry.status =
        target.status === 'unsupported'
          ? { state: 'unsupported', name, type: target.type }
          : { state: target.status, name };
      return;
    }
    const next = variableValueFor(values, target.multi);
    const refusal = this.refuse(name, values, next, target.multi);
    if (refusal) {
      this.giveBack(name, entry, target);
      entry.attempted = undefined;
      entry.status = refusal;
      return;
    }
    if (entry.attempted !== undefined && sameVariableValue(entry.attempted, next)) {
      // Nothing new to write. Whether the variable still holds it is for check() to say.
      this.check(name, entry, target);
      return;
    }
    // The value to put back later is the one from before the first write, as long as the variable is
    // still the sync's. If somebody changed it since, their value is the one to put back.
    const original = entry.hold && this.holds(entry.hold, target) ? entry.hold.original : target.value;
    if (!restorable(original, target.multi)) {
      entry.hold = undefined;
      entry.status = { state: 'unrestorable', name };
      return;
    }
    this.runtime.setQuery({ [`var-${name}`]: next });
    entry.hold = {
      original,
      written: next,
      path: this.runtime.path(),
      writtenAt: this.runtime.now(),
      confirmed: false,
    };
    entry.attempted = next;
    entry.status = { state: 'writing', name };
  }

  // Values that must not be written, whatever the variable holds.
  private refuse(name: string, values: string[], next: VariableValue, multi: boolean): SyncStatus | undefined {
    if (multi && values.includes(ALL_VALUE)) {
      return { state: 'reserved', name };
    }
    if (!multi && values.some(needsQuoteEscaping)) {
      return { state: 'unquotable', name };
    }
    const length = urlLength(name, next);
    return length > MAX_URL_CHARS ? { state: 'tooLarge', name, length } : undefined;
  }

  // Whether the variable is still the sync's: it holds what was written, or the write is so recent
  // that Grafana may not have applied it yet.
  private holds(hold: Hold, target: VariableTarget): boolean {
    if (hold.path !== this.runtime.path() || target.status !== 'ok') {
      return false;
    }
    const pending = !hold.confirmed && this.runtime.now() - hold.writtenAt < CONFIRM_MS;
    return pending || sameVariableValue(target.value, hold.written);
  }

  // Ends the hold on the variable and puts its original value back if the variable is still the sync's.
  private giveBack(name: string, entry: Entry, target: VariableTarget): void {
    const hold = entry.hold;
    entry.hold = undefined;
    if (hold && this.holds(hold, target)) {
      this.runtime.setQuery({ [`var-${name}`]: hold.original });
    }
  }

  // Compares what the variable holds with what was written, and sets the status accordingly.
  private check(name: string, entry: Entry, target: VariableTarget): void {
    const hold = entry.hold;
    if (!hold || hold.path !== this.runtime.path()) {
      // Not the sync's variable (the status says why), or another page: the panel is on its way out.
      return;
    }
    if (target.status !== 'ok') {
      entry.hold = undefined;
      entry.status =
        target.status === 'unsupported'
          ? { state: 'unsupported', name, type: target.type }
          : { state: target.status, name };
      return;
    }
    if (sameVariableValue(target.value, hold.written)) {
      hold.confirmed = true;
      entry.status = { state: 'synced', name, others: 0 };
      return;
    }
    if (!hold.confirmed && this.runtime.now() - hold.writtenAt < CONFIRM_MS) {
      return;
    }
    entry.hold = undefined;
    if (hold.confirmed) {
      // It held the selection and somebody, or Grafana, changed it. It is theirs now.
      entry.status = { state: 'changed', name };
      return;
    }
    // Grafana never showed the written value. What it made of the write is neither the selection nor
    // what the user had before, so the original value goes back.
    if (!sameVariableValue(target.value, hold.original)) {
      this.runtime.setQuery({ [`var-${name}`]: hold.original });
    }
    entry.status = { state: 'rejected', name };
  }
}

/** A sentence for the selection bar, or undefined when there is nothing to say. */
export function syncMessage(status: SyncStatus): { text: string; problem: boolean } | undefined {
  switch (status.state) {
    case 'writing':
      return { text: `Writing $${status.name}…`, problem: false };
    case 'synced': {
      const others = status.others === 1 ? ' (with 1 other panel)' : ` (with ${status.others} other panels)`;
      return { text: `→ $${status.name}${status.others > 0 ? others : ''}`, problem: false };
    }
    case 'changed':
      return { text: `$${status.name} was changed and no longer holds the selection`, problem: true };
    case 'rejected':
      return { text: `Grafana did not keep the selection in $${status.name}`, problem: true };
    case 'noLabel':
      return { text: `Set "Selection label" to sync to $${status.name}`, problem: true };
    case 'missing':
      return { text: `Variable "${status.name}" is not in this dashboard`, problem: true };
    case 'unsupported':
      return {
        text: `Variable "${status.name}" has the type ${status.type}, which cannot hold a selection`,
        problem: true,
      };
    case 'single':
      return {
        text: `Variable "${status.name}" takes one value: sync to a multi-value variable or a text box`,
        problem: true,
      };
    case 'unrestorable':
      return { text: `Variable "${status.name}" has no value to put back later: not synced`, problem: true };
    case 'reserved':
      return { text: `A selected value is ${ALL_VALUE}, which Grafana reads as All: not synced`, problem: true };
    case 'unquotable':
      return {
        text: `A selected value contains \\ ^ or ", which the text box $${status.name} cannot pass to a query safely: not synced`,
        problem: true,
      };
    case 'tooLarge':
      return {
        text: `Selection too large for $${status.name} (${status.length} of ${MAX_URL_CHARS} URL characters)`,
        problem: true,
      };
    case 'failed':
      return { text: `Could not set $${status.name}`, problem: true };
    default:
      return undefined;
  }
}
