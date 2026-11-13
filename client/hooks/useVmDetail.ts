import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { vmDetailRpc, type VmDetailResult } from "../../shared/contracts";
import { errorMessage } from "../state";

const POLL_MS = 2_500;

export interface VmDetailState {
  readonly data: VmDetailResult | null;
  readonly error: string | null;
  readonly loading: boolean;
  refresh(): Promise<void>;
}

/**
 * Reconnects by sandbox name and polls while that name is selected. A null name
 * stops polling without affecting host work.
 */
export function useVmDetail(name: string | null): VmDetailState {
  const invoke = useRpc(vmDetailRpc);
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;

  const [data, setData] = useState<VmDetailResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const mounted = useRef(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const reload = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    const current = generation.current;
    let cancelled = false;
    inFlight.current = false;

    if (!name) {
      reload.current = async () => {};
      setData(null);
      setError(null);
      setLoading(false);
      return () => {
        cancelled = true;
        mounted.current = false;
      };
    }

    setLoading(true);
    setData(null);
    setError(null);

    const load = async () => {
      if (inFlight.current) return;
      inFlight.current = true;

      try {
        const result = await invokeRef.current({ name });
        if (!cancelled && current === generation.current) {
          setData(result);
          setError(null);
        }
      } catch (rpcError) {
        if (!cancelled && current === generation.current) {
          setError(errorMessage(rpcError));
        }
      } finally {
        inFlight.current = false;
        if (!cancelled && current === generation.current) setLoading(false);
      }
    };

    reload.current = load;
    void load();
    const timer = setInterval(() => {
      void load();
    }, POLL_MS);

    return () => {
      cancelled = true;
      mounted.current = false;
      clearInterval(timer);
    };
  }, [name]);

  const refresh = useCallback(async () => {
    if (mounted.current) await reload.current();
  }, []);

  return { data, error, loading, refresh };
}
