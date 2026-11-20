import { useEffect, useRef, useState } from 'react';
import { getTemplateSrv, locationService } from '@grafana/runtime';
import { SyncOwnership, SyncStatus, VariableRuntime, syncVariable, variableName } from '../selection/variable';

/**
 * How long the selected values must stay unchanged before they are written to the variable. Grafana
 * re-runs every query that uses a variable when it changes, so a run of Shift+clicks writes once.
 */
export const SYNC_DELAY_MS = 400;

const runtime: VariableRuntime = {
  getVariables: () => getTemplateSrv()?.getVariables?.() ?? [],
  // `replace: true` updates the URL in place instead of adding a browser history entry per selection.
  setQuery: (query) => locationService.partial(query, true),
};

/**
 * Keeps a dashboard variable equal to the selected label values (see `syncVariable`). `option` is the
 * panel option naming the variable; empty turns the sync off. A new `values` array restarts the delay
 * and nothing more: the variable is written only when the values differ from the last write.
 *
 * The variable is not restored when the panel unmounts: the dashboard is then being left or
 * rebuilt, and a URL write at that moment would land on the next page.
 */
export function useVariableSync(option: string | undefined, values: string[]): SyncStatus {
  const name = variableName(option);
  const [status, setStatus] = useState<SyncStatus>({ state: 'off' });
  const owned = useRef<SyncOwnership | null>(null);

  useEffect(() => {
    if (name === '' && owned.current === null) {
      return undefined;
    }
    const timer = setTimeout(() => {
      try {
        const result = syncVariable(runtime, name, values, owned.current);
        owned.current = result.owned;
        // Every data refresh passes here: keep the previous object when nothing changed, so React skips the render.
        setStatus((previous) =>
          JSON.stringify(previous) === JSON.stringify(result.status) ? previous : result.status
        );
      } catch {
        // Grafana could not take the write (a value that cannot be put in a URL, a missing service).
        owned.current = null;
        setStatus({ state: 'failed', name });
      }
    }, SYNC_DELAY_MS);
    return () => clearTimeout(timer);
  }, [name, values]);

  return name === '' ? { state: 'off' } : status;
}
