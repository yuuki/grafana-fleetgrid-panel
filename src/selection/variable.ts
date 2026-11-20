import { toRegex } from './exportFormats';

/** What a dashboard variable holds, and what `var-<name>` is set to: one value or a list. */
export type VariableValue = string | string[];

/** The fields of Grafana's variable models (`getTemplateSrv().getVariables()`) that the sync reads. */
export interface VariableLike {
  name: string;
  type: string;
  multi?: boolean;
  current?: { value?: unknown };
}

/** The slice of `@grafana/runtime` that the sync uses, so tests can stand in for it. */
export interface VariableRuntime {
  getVariables(): VariableLike[];
  /** `locationService.partial(query, true)`: the documented way for a plugin to set a variable. */
  setQuery(query: Record<string, VariableValue>): void;
}

/** What the sync wrote to a variable, and the value to put back when the selection ends. */
export interface SyncOwnership {
  name: string;
  written: VariableValue;
  previous: VariableValue | undefined;
}

export type SyncStatus =
  | { state: 'off' }
  /** A variable is configured and nothing is selected. */
  | { state: 'idle'; name: string }
  | { state: 'synced'; name: string }
  | { state: 'missing'; name: string }
  | { state: 'unsupported'; name: string; type: string }
  | { state: 'tooLarge'; name: string; length: number }
  | { state: 'failed'; name: string };

/**
 * The longest `var-<name>=…` query the sync adds to the dashboard URL, in percent-encoded
 * characters. Reverse proxies commonly reject a request line above 8 KB, and the URL is sent to the
 * server whenever the dashboard is reloaded or shared; this leaves 2 KB for the rest of it.
 */
export const MAX_URL_CHARS = 6000;

// Types whose value the URL can set to arbitrary text. A constant ignores the URL, and the other types
// hold something else than label values (a data source, an interval, ad hoc filters).
const SUPPORTED_TYPES = ['custom', 'query', 'textbox'];

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
  | { status: 'ok'; multi: boolean; value: VariableValue | undefined };

export function describeVariable(variables: VariableLike[], name: string): VariableTarget {
  const variable = variables.find((candidate) => candidate.name === name);
  if (!variable) {
    return { status: 'missing' };
  }
  if (!SUPPORTED_TYPES.includes(variable.type)) {
    return { status: 'unsupported', type: variable.type };
  }
  return { status: 'ok', multi: variable.multi === true, value: asValue(variable.current?.value) };
}

/**
 * The value a variable gets for the selected label values. A multi-value variable gets the values
 * themselves: Grafana formats and escapes them for each query that uses the variable. A single-value
 * variable gets one regular expression that matches exactly these values.
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

// Puts back the value the variable had before the selection, but only while the variable still holds
// what the sync wrote: a value that somebody changed since then is theirs.
function release(runtime: VariableRuntime, owned: SyncOwnership): void {
  const target = describeVariable(runtime.getVariables(), owned.name);
  // An empty list cannot be written: Grafana drops the URL parameter and keeps the variable's value.
  const restorable = owned.previous !== undefined && !(Array.isArray(owned.previous) && owned.previous.length === 0);
  if (target.status === 'ok' && restorable && sameVariableValue(target.value, owned.written)) {
    runtime.setQuery({ [`var-${owned.name}`]: owned.previous! });
  }
}

/**
 * One step of the selection → variable sync: decides what the variable `name` must hold for the
 * selected label values and writes it when that differs from the last write.
 *
 * - Values to sync: write them, and remember the value the variable had before the first write.
 * - Nothing selected, or a selection too large for the URL: put the remembered value back.
 * - The same values as the last write: nothing, so a data refresh never touches the URL.
 */
export function syncVariable(
  runtime: VariableRuntime,
  name: string,
  values: string[],
  owned: SyncOwnership | null
): { status: SyncStatus; owned: SyncOwnership | null } {
  if (owned && owned.name !== name) {
    release(runtime, owned);
    owned = null;
  }
  if (name === '') {
    return { status: { state: 'off' }, owned: null };
  }
  const target = describeVariable(runtime.getVariables(), name);
  if (target.status === 'missing') {
    return { status: { state: 'missing', name }, owned: null };
  }
  if (target.status === 'unsupported') {
    return { status: { state: 'unsupported', name, type: target.type }, owned: null };
  }
  if (values.length === 0) {
    if (owned) {
      release(runtime, owned);
    }
    return { status: { state: 'idle', name }, owned: null };
  }
  const next = variableValueFor(values, target.multi);
  const length = urlLength(name, next);
  if (length > MAX_URL_CHARS) {
    if (owned) {
      release(runtime, owned);
    }
    return { status: { state: 'tooLarge', name, length }, owned: null };
  }
  if (owned && sameVariableValue(owned.written, next)) {
    return { status: { state: 'synced', name }, owned };
  }
  runtime.setQuery({ [`var-${name}`]: next });
  return {
    status: { state: 'synced', name },
    owned: { name, written: next, previous: owned?.previous ?? target.value },
  };
}

/** A sentence for the selection bar, or undefined when there is nothing to say. */
export function syncMessage(status: SyncStatus): { text: string; problem: boolean } | undefined {
  switch (status.state) {
    case 'synced':
      return { text: `→ $${status.name}`, problem: false };
    case 'missing':
      return { text: `Variable "${status.name}" is not in this dashboard`, problem: true };
    case 'unsupported':
      return {
        text: `Variable "${status.name}" has the type ${status.type}, which cannot hold a selection`,
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
