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
 * stops polling without affecting host work. A pending attempt is selected by
 * request ID so two same-name rows never open the wrong detail.
 *
 * Responses are latest-request-wins across selections and manual refreshes, so
 * one selection's in-flight detail can never clear or overwrite another's.
 */
export function useVmDetail(
  name: string | null,
  id?: string,
  requestId?: string,
): VmDetailState {
  const invoke = useRpc(vmDetailRpc);
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;

  const [data, setData] = useState<VmDetailResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const mounted = useRef(false);
  const sequence = useRef(0);
  const reload = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    mounted.current = true;

    if (!name) {
      reload.current = async () => {};
      setData(null);
      setError(null);
      setLoading(false);
      return () => {
        mounted.current = false;
      };
    }

    setLoading(true);
    setData(null);
    setError(null);

    const load = async () => {
      const request = ++sequence.current;

      try {
        const input = requestId ? { name, requestId } : id ? { name, id } : { name };
        const result = await invokeRef.current(input);
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
    };

    reload.current = load;
    void load();
    const timer = setInterval(() => {
      void load();
    }, POLL_MS);

    return () => {
      mounted.current = false;
      sequence.current += 1;
      clearInterval(timer);
    };
  }, [name, id, requestId]);

  const refresh = useCallback(async () => {
    if (mounted.current) await reload.current();
  }, []);

  return { data, error, loading, refresh };
}
