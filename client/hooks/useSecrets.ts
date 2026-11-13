import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useRef, useState } from "react";
import { secretsListRpc, type SecretsListResult } from "../../shared/contracts";
import { errorMessage } from "../state";

export interface SecretsState {
  readonly data: SecretsListResult | null;
  readonly error: string | null;
  readonly loading: boolean;
  refresh(): Promise<void>;
}

/** Loads the credential store on demand; there is nothing to poll here. */
export function useSecrets(): SecretsState {
  const invoke = useRpc(secretsListRpc);
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;

  const [data, setData] = useState<SecretsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);

    try {
      const result = await invokeRef.current({});
      setData(result);
      setError(null);
    } catch (rpcError) {
      setError(errorMessage(rpcError));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  return { data, error, loading, refresh };
}
