import { useCallback, useEffect, useRef, useState } from "react";
import { createPoller, type Poller } from "./polling";
import { useVmApi } from "./useVmApi";
import type { VmApi } from "../api";

export interface VmDetailState {
  data: Awaited<ReturnType<VmApi["detail"]>> | null;
  loading: boolean;
  error: string | null;
}

export interface VmDetailResult extends VmDetailState {
  refresh(): Promise<void>;
}

export function useVmDetail(
  name: string | null,
  id: string | null | undefined,
): VmDetailResult {
  const api = useVmApi();
  const [state, setState] = useState<VmDetailState>({
    data: null,
    loading: false,
    error: null,
  });
  const pollerRef = useRef<Poller | null>(null);

  useEffect(() => {
    if (!name) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    setState({ data: null, loading: true, error: null });
    const poller = createPoller(
      () => api.detail(id ? { name, id } : { name }),
      (result) => {
        if (result.ok) {
          setState({ data: result.value, loading: false, error: null });
        } else {
          setState({
            data: null,
            loading: false,
            error: "Could not load child details. Retry.",
          });
        }
      },
      { intervalMs: 2000 },
    );
    pollerRef.current = poller;
    poller.start();
    return () => {
      poller.stop();
      pollerRef.current = null;
    };
  }, [api, name, id]);

  const refresh = useCallback(() => {
    return pollerRef.current?.refresh() ?? Promise.resolve();
  }, []);

  return { ...state, refresh };
}
