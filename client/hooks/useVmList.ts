import { useCallback, useEffect, useRef, useState } from "react";
import { createPoller, type Poller } from "./polling";
import { useVmApi } from "./useVmApi";
import type { VmApi } from "../api";

export const LIST_POLL_MS = 2000;
export const DETAIL_POLL_MS = 2000;

export interface VmListState {
  data: Awaited<ReturnType<VmApi["list"]>> | null;
  loading: boolean;
  error: string | null;
}

export interface VmListResult extends VmListState {
  refresh(): Promise<void>;
}

export function useVmList(): VmListResult {
  const api = useVmApi();
  const [state, setState] = useState<VmListState>({
    data: null,
    loading: true,
    error: null,
  });
  const pollerRef = useRef<Poller | null>(null);

  useEffect(() => {
    const poller = createPoller(
      () => api.list(),
      (result) => {
        if (result.ok) {
          setState({ data: result.value, loading: false, error: null });
        } else {
          setState((previous) => ({
            ...previous,
            loading: false,
            error: "Could not load child VMs. Retry.",
          }));
        }
      },
      { intervalMs: LIST_POLL_MS },
    );
    pollerRef.current = poller;
    poller.start();
    return () => {
      poller.stop();
      pollerRef.current = null;
    };
  }, [api]);

  const refresh = useCallback(() => {
    return pollerRef.current?.refresh() ?? Promise.resolve();
  }, []);

  return { ...state, refresh };
}
