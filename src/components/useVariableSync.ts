import { useEffect, useRef, useState } from 'react';
import { getTemplateSrv, locationService } from '@grafana/runtime';
import {
  SyncOwnership,
  SyncStatus,
  VariableRuntime,
  releaseVariable,
  syncVariable,
  variableName,
} from '../selection/variable';

/**
 * How long the selected values must stay unchanged before they are written to the variable. Grafana
 * re-runs every query that uses a variable when it changes, so a run of Shift+clicks writes once.
 */
export const SYNC_DELAY_MS = 400;

// One object for "no variable configured", so the status keeps its identity from render to render.
const OFF: SyncStatus = { state: 'off' };

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
 * The selection lives in the panel, so it ends when the panel unmounts, for example when Grafana
 * opens the panel view or the panel editor. The variable is then put back as if the selection had
 * been cleared, unless the page has changed: a URL write must not land on another dashboard.
 */
export function useVariableSync(option: string | undefined, values: string[]): SyncStatus {
  const name = variableName(option);
  const [status, setStatus] = useState<SyncStatus>(OFF);
  const owned = useRef<SyncOwnership | null>(null);
  // The page the variable was written on. Views of one dashboard share the path and differ in the query.
  const ownedPath = useRef('');

  useEffect(() => {
    if (name === '' && owned.current === null) {
      return undefined;
    }
    const timer = setTimeout(() => {
      try {
        const result = syncVariable(runtime, name, values, owned.current);
        owned.current = result.owned;
        ownedPath.current = window.location.pathname;
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

  useEffect(
    () => () => {
      const written = owned.current;
      owned.current = null;
      if (written && window.location.pathname === ownedPath.current) {
        try {
          releaseVariable(runtime, written);
        } catch {
          // Nothing to tell: the panel is gone.
        }
      }
    },
    []
  );

  return name === '' ? OFF : status;
}
