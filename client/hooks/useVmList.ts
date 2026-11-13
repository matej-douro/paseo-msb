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
 */
export function useVmList(): VmListState {
  const invoke = useRpc(vmListRpc);
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;

  const [data, setData] = useState<VmListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const mounted = useRef(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const result = await invokeRef.current({});
      if (mounted.current) {
        setData(result);
        setError(null);
      }
    } catch (rpcError) {
      if (mounted.current) setError(errorMessage(rpcError));
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
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
