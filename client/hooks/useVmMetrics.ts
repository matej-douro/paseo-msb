import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { vmMetricsRpc, type VmMetricsResult } from "../../shared/contracts";
import {
  createMetricsHistory,
  createMetricsPoller,
  type MetricsHistoryPoint,
} from "../metrics";

export interface VmMetricsState {
  readonly availability: VmMetricsResult | null;
  /** Bounded rolling history for the selected generation. */
  readonly points: readonly MetricsHistoryPoint[];
  readonly loading: boolean;
}

const UNAVAILABLE: VmMetricsResult = {
  status: "unavailable",
  reason: "unavailable",
};

/**
 * Polls `vm.metrics` every three seconds while a running sandbox's detail is
 * visible. The poller is single-flight and stops on unmount or selection
 * change; a failed read does not fail the detail or logs. The history is
 * discarded on selection or generation change and when metrics go unavailable.
 */
export function useVmMetrics(
  name: string | null,
  id: string | null,
  enabled: boolean,
): VmMetricsState {
  const invoke = useRpc(vmMetricsRpc);
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;

  const [availability, setAvailability] = useState<VmMetricsResult | null>(null);
  const [points, setPoints] = useState<readonly MetricsHistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !name || !id) {
      setAvailability(null);
      setPoints([]);
      setLoading(false);
      return;
    }

    let active = true;
    const history = createMetricsHistory();
    setAvailability(null);
    setPoints([]);
    setLoading(true);

    const poll = async () => {
      try {
        const result = await invokeRef.current({ name, id });
        if (!active) return;

        if (result.status === "available") {
          setAvailability(result);
          setPoints(history.append(result.sample, id, Date.now()));
        } else {
          history.reset();
          setAvailability(result);
          setPoints([]);
        }
      } catch {
        if (!active) return;
        // A transport or generation error is reported as the fixed unavailable
        // reason; the detail and logs are unaffected.
        history.reset();
        setAvailability(UNAVAILABLE);
        setPoints([]);
      } finally {
        if (active) setLoading(false);
      }
    };

    const poller = createMetricsPoller(poll);
    poller.start();

    return () => {
      active = false;
      poller.stop();
    };
  }, [name, id, enabled]);

  return { availability, points, loading };
}
