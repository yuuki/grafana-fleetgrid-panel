import { useEffect, useMemo, useRef, useState } from 'react';
import { getTemplateSrv, locationService } from '@grafana/runtime';
import { SyncStatus, VariableRuntime, VariableSync, variableName } from '../selection/variable';

/**
 * How long the selected values must stay unchanged before they are written to the variable. Grafana
 * re-runs every query that uses a variable when it changes, so a run of Shift+clicks writes once.
 */
export const SYNC_DELAY_MS = 400;

/**
 * How often a variable that holds a selection is read back. Grafana gives a plugin no event for
 * "a variable changed" in every supported version, so the status is checked on a timer, and at once
 * when the URL changes (Grafana mirrors variables in the URL).
 */
export const VERIFY_INTERVAL_MS = 1000;

// One object for "no variable configured", so the status keeps its identity from render to render.
const OFF: SyncStatus = { state: 'off' };

const runtime: VariableRuntime = {
  getVariables: () => getTemplateSrv()?.getVariables?.() ?? [],
  // `replace: true` updates the URL in place instead of adding a browser history entry per selection.
  setQuery: (query) => locationService.partial(query, true),
  path: () => window.location.pathname,
  now: () => Date.now(),
};

// One sync for the page: a variable belongs to the dashboard, and several panels may sync to it.
const sync = new VariableSync(runtime);

const sameStatus = (a: SyncStatus, b: SyncStatus): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Keeps a dashboard variable equal to the selected label values (see `VariableSync`).
 *
 * `option` is the panel option that names the variable; empty turns the sync off. `label` is the
 * configured selection label; without one nothing is written. `values` are the selected values of
 * that label. A new `values` array restarts the delay and nothing more: the variable is written only
 * when the values differ from the last write.
 *
 * The selection lives in the panel, so it ends when the panel unmounts, for example when Grafana
 * opens the panel view or the panel editor. The panel's claim on the variable ends with it, as if
 * the selection had been cleared.
 */
export function useVariableSync(option: string | undefined, label: string | undefined, values: string[]): SyncStatus {
  const name = variableName(option);
  // This panel, as the sync knows it.
  const [owner] = useState(() => ({}));
  // The variable this panel has a claim on.
  const claimed = useRef<string | undefined>(undefined);
  const [status, setStatus] = useState<SyncStatus>(OFF);
  const wanted = name !== '' && values.length > 0;
  const blocked = wanted && label === undefined;

  // Follow the shared status: another panel's selection, or a read-back, can change it.
  useEffect(() => {
    if (name === '') {
      return undefined;
    }
    const update = () => {
      const next = sync.status(name, owner);
      setStatus((previous) => (sameStatus(previous, next) ? previous : next));
    };
    update();
    return sync.subscribe(update);
  }, [name, owner]);

  // State the values this panel wants in the variable, once they have settled.
  useEffect(() => {
    if (name === '' && claimed.current === undefined) {
      return undefined;
    }
    const timer = setTimeout(() => {
      if (claimed.current !== undefined && claimed.current !== name) {
        sync.claim(claimed.current, owner, []);
      }
      const claim = name !== '' && label !== undefined ? values : [];
      if (name !== '') {
        sync.claim(name, owner, claim);
      }
      claimed.current = claim.length > 0 ? name : undefined;
    }, SYNC_DELAY_MS);
    return () => clearTimeout(timer);
  }, [name, label, values, owner]);

  // While this panel wants a variable to hold its selection, keep reading the variable back.
  useEffect(() => {
    if (!wanted || blocked) {
      return undefined;
    }
    const verify = () => sync.verify();
    const interval = setInterval(verify, VERIFY_INTERVAL_MS);
    // Grafana applies a URL change to its variables in the same tick or the next one.
    const stopListening = locationService.getHistory?.()?.listen?.(() => setTimeout(verify, 50));
    return () => {
      clearInterval(interval);
      stopListening?.();
    };
  }, [wanted, blocked]);

  useEffect(
    () => () => {
      if (claimed.current !== undefined) {
        sync.claim(claimed.current, owner, []);
        claimed.current = undefined;
      }
    },
    [owner]
  );

  return useMemo((): SyncStatus => {
    if (name === '') {
      return OFF;
    }
    return blocked ? { state: 'noLabel', name } : status;
  }, [name, blocked, status]);
}
