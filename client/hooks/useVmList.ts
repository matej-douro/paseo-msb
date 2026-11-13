import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { vmListRpc, type VmListResult } from "../../shared/contracts";
import { errorMessage } from "../state";

const POLL_MS = 2_500;

export interface VmListState {
  readonly data: VmListResult | null;
  readonly error: string | null;
  readonly loading: boolean;
  refresh(): Promise<void>;
}

/**
 * Polls `vm.list` only while the screen is mounted. Host work continues on the
 * server; stopping the interval does not stop it.
 *
 * Responses are latest-request-wins: an older in-flight poll can never
 * overwrite a newer response, and a manual refresh always issues its own
 * request instead of being skipped behind a poll.
 */
export function useVmList(): VmListState {
  const invoke = useRpc(vmListRpc);
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;

  const [data, setData] = useState<VmListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const mounted = useRef(false);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++sequence.current;

    try {
      const result = await invokeRef.current({});
      if (mounted.current && request === sequence.current) {
        setData(result);
        setError(null);
      }
    } catch (rpcError) {
      if (mounted.current && request === sequence.current) {
        setError(errorMessage(rpcError));
      }
    } finally {
      if (mounted.current && request === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_MS);

    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  return { data, error, loading, refresh };
}
