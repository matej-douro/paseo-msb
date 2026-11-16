import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { vmMetricsRpc, type VmMetricsResult } from "../../shared/contracts";
import {
  createMetricsPoller,
  createMetricsTracker,
  type MetricsSnapshot,
} from "../metrics";

export interface VmMetricsState {
  readonly availability: VmMetricsResult | null;
  readonly snapshot: MetricsSnapshot | null;
  readonly loading: boolean;
}

const UNAVAILABLE: VmMetricsResult = {
  status: "unavailable",
  reason: "unavailable",
};

/**
 * Polls `vm.metrics` every three seconds while a running sandbox's detail is
 * visible. The poller is single-flight and stops on unmount or selection
 * change; a failed read does not fail the detail or logs.
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
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !name || !id) {
      setAvailability(null);
      setSnapshot(null);
      setLoading(false);
      return;
    }

    let active = true;
    const tracker = createMetricsTracker();
    setAvailability(null);
    setSnapshot(null);
    setLoading(true);

    const poll = async () => {
      try {
        const result = await invokeRef.current({ name, id });
        if (!active) return;

        if (result.status === "available") {
          setAvailability(result);
          setSnapshot(tracker.apply(result.sample, id, Date.now()));
        } else {
          tracker.reset();
          setAvailability(result);
          setSnapshot(null);
        }
      } catch {
        if (!active) return;
        // A transport or generation error is reported as the fixed unavailable
        // reason; the detail and logs are unaffected.
        tracker.reset();
        setAvailability(UNAVAILABLE);
        setSnapshot(null);
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

  return { availability, snapshot, loading };
}
