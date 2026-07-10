import { useEffect } from 'react';
import { useQuery } from 'urql';
import type { UseQueryState } from 'urql';

import { GetScan } from './graphql';
import type { GetScanData, GetScanVariables } from './graphql';

/**
 * Poll a scan by id every 2 seconds via urql until it reaches a terminal state
 * (FE-02, D-03, RESEARCH Pattern 4).
 *
 * urql has no built-in `pollInterval`, so the loop is driven manually with
 * `setInterval` + `reexecuteQuery({ requestPolicy: 'network-only' })`. Polling
 * STOPS once `status` is `Finished` or `Failed`: the effect early-returns (arming
 * no interval) whenever `terminal` is true, and the existing interval is cleared
 * on cleanup. While `id` is null (no scan yet) the query is paused.
 *
 * The full urql result is returned so `App` can render from `data`/`fetching`/`error`.
 */
export function useScanPolling(
  id: string | null,
): UseQueryState<GetScanData, GetScanVariables> {
  const [result, reexecute] = useQuery<GetScanData, GetScanVariables>({
    query: GetScan,
    variables: { id: id ?? '' },
    pause: id === null,
  });

  const status = result.data?.scan?.status;
  const terminal = status === 'Finished' || status === 'Failed';

  useEffect(() => {
    if (id === null || terminal) {
      return;
    }
    const timer = setInterval(() => {
      reexecute({ requestPolicy: 'network-only' });
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [id, terminal, reexecute]);

  return result;
}
