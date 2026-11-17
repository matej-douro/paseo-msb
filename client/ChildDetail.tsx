import { Loading, Modal, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { METRICS_POLL_INTERVAL_MS } from "../shared/constants";
import type {
  Availability,
  VmChild,
  VmCreateInput,
  VmDeleteInput,
  VmDetailResult,
  VmDismissInput,
  VmMetricsResult,
  VmReconcileResult,
  VmResizeInput,
  VmResizeResult,
} from "../shared/contracts";
import { useVmMetrics } from "./hooks/useVmMetrics";
import { metricsUnavailableText, type MetricsHistoryPoint } from "./metrics";
import {
  canResize,
  childErrorText,
  childPhase,
  childPlan,
  deleteConfirmationText,
  errorMessage,
  mergeLogBundles,
  missingChildText,
  phaseText,
  planSummary,
  reconcileFailureMessage,
  reconcileSuccessMessage,
  registrationOnlyDetailText,
  registrationText,
  resourceDetailLines,
  retryCreateInput,
  runtimeText,
  setupPill,
  vmPill,
} from "./state";
import { ResizeChild } from "./ResizeChild";
import { ActionButton, IconButton, LogBlock, MetricsChart, Notice, RootDiskBar, StatusPill, type PluginTheme } from "./ui";

export interface ChildDetailProps {
  name: string;
  data: VmDetailResult | null;
  loading: boolean;
  error: string | null;
  theme: PluginTheme;
  compact: boolean;
  onBack(): void;
  onRetry(): void;
  onRepair(name: string): Promise<VmReconcileResult>;
  onRetryCreate(input: VmCreateInput): Promise<void>;
  onDismiss(input: VmDismissInput): Promise<void>;
  onDismissed(): void;
  onDelete(input: VmDeleteInput): Promise<void>;
  onDeleted(): void;
  onResize(input: VmResizeInput): Promise<VmResizeResult>;
}

/**
 * Read-only detail with bounded logs, Repair, and Delete. Delete always names
 * the child and states exactly what matching cleanup removes.
 */
export function ChildDetail({
  name,
  data,
  loading,
  error,
  theme,
  compact,
  onBack,
  onRetry,
  onRepair,
  onRetryCreate,
  onDismiss,
  onDismissed,
  onDelete,
  onDeleted,
  onResize,
}: ChildDetailProps) {
  const toast = useToast();
  const [repairing, setRepairing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [resizeOpen, setResizeOpen] = useState(false);

  const child = data?.child ?? null;
  const registrations = data?.registrations ?? ({ status: "available" } as const);
  const sandbox = child?.kind === "sandbox" ? child : null;
  const registrationOnly = child?.kind === "registration" ? child : null;
  const deleteTarget = sandbox ?? registrationOnly;
  const childError = child ? childErrorText(child) : null;
  const logs = data?.logs ?? null;
  // Live metrics poll only while a running sandbox's detail is visible. Pending
  // and registration-only children never show the panel.
  const metricsEnabled = sandbox?.runtimeStatus === "running";
  const metrics = useVmMetrics(
    sandbox?.name ?? null,
    sandbox?.id ?? null,
    metricsEnabled,
  );
  // Logs stay open while setup is in progress; a ready child starts collapsed.
  const logsDefaultOpen = child ? childPhase(child) !== "ready" : false;

  const repair = async () => {
    if (repairing) return;
    setRepairing(true);
    setRepairError(null);

    try {
      const result = await onRepair(name);
      const failure = reconcileFailureMessage(result);
      if (failure) {
        setRepairError(failure);
        toast.error(failure);
      } else {
        toast.show(reconcileSuccessMessage(result), { variant: "success" });
      }
    } catch (repairFailure) {
      const message = errorMessage(repairFailure);
      setRepairError(message);
      toast.error(message);
    } finally {
      setRepairing(false);
    }
  };

  const retryCreate = async () => {
    if (child?.kind !== "pending" || retrying) return;
    setRetrying(true);
    setRetryError(null);

    try {
      await onRetryCreate(retryCreateInput(child));
      toast.show(`Retrying ${child.name}.`, { variant: "info" });
    } catch (retryFailure) {
      const message = errorMessage(retryFailure);
      setRetryError(message);
      toast.error(message);
    } finally {
      setRetrying(false);
    }
  };

  const dismissCreate = async () => {
    if (child?.kind !== "pending" || dismissing) return;
    setDismissing(true);
    setRetryError(null);

    try {
      await onDismiss({ name: child.name });
      toast.show("Create attempt dismissed.", { variant: "success" });
      onDismissed();
    } catch (dismissFailure) {
      const message = errorMessage(dismissFailure);
      setRetryError(message);
      toast.error(message);
    } finally {
      setDismissing(false);
    }
  };

  // A settled resize refreshes the live metrics alongside the detail and list.
  const resize = async (input: VmResizeInput) => {
    const result = await onResize(input);
    await metrics.refresh();
    return result;
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);

    try {
      await onDelete({
        name: deleteTarget.name,
        id: deleteTarget.id,
        confirmName: deleteTarget.name,
      });
      setDeleteOpen(false);
      toast.show("Child deleted.", { variant: "success" });
      onDeleted();
    } catch (deleteFailure) {
      setDeleteError(errorMessage(deleteFailure));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 12, paddingBottom: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {compact ? (
            <ActionButton label="Back" theme={theme} onPress={onBack} compact />
          ) : null}
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              flexShrink: 1,
              color: theme.colors.foreground,
              fontSize: 15,
              fontWeight: "600",
            }}
          >
            {name}
          </Text>
          {deleteTarget ? (
            <View style={{ flexDirection: "row", gap: 6 }}>
              {sandbox && canResize(sandbox.resources) ? (
                <IconButton
                  icon="SlidersHorizontal"
                  label="Edit resources"
                  theme={theme}
                  onPress={() => setResizeOpen(true)}
                  disabled={repairing || deleting || retrying}
                />
              ) : null}
              <IconButton
                icon="Wrench"
                label={repairing ? "Repairing…" : "Repair child"}
                theme={theme}
                onPress={() => void repair()}
                disabled={repairing || deleting || retrying}
              />
              <IconButton
                icon="Trash2"
                label="Delete child"
                theme={theme}
                variant="danger"
                onPress={() => {
                  setDeleteError(null);
                  setDeleteOpen(true);
                }}
                disabled={repairing || deleting}
              />
            </View>
          ) : null}
        </View>

        {loading && !data ? <Loading /> : null}

        {error ? (
          <View style={{ gap: 8 }}>
            <Notice text={error} tone="danger" theme={theme} />
            <ActionButton label="Retry" theme={theme} onPress={onRetry} compact />
          </View>
        ) : null}

        {data && !child ? (
          <Notice text={missingChildText(data)} theme={theme} />
        ) : null}

        {child ? (
          <>
            <ChildPills child={child} registrations={registrations} theme={theme} />

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
              <DetailRow theme={theme} label="Phase" value={phaseText(childPhase(child))} />
              {child.kind !== "registration" ? (
                <DetailRow theme={theme} label="Setup" value={planSummary(childPlan(child))} />
              ) : null}
              {sandbox ? (
                <>
                  <DetailRow
                    theme={theme}
                    label="Runtime"
                    value={runtimeText(sandbox.runtimeStatus)}
                  />
                  <DetailRow
                    theme={theme}
                    label="Registration"
                    value={registrationText(sandbox.registration, registrations)}
                  />
                  <DetailRow theme={theme} label="Stable ID" value={sandbox.id} mono />
                  {resourceDetailLines(sandbox.resources, sandbox.requestedResources).map((line) => (
                    <DetailRow key={line.label} theme={theme} label={line.label} value={line.value} />
                  ))}
                </>
              ) : registrationOnly ? (
                <>
                  <DetailRow
                    theme={theme}
                    label="Registration"
                    value={registrationText(registrationOnly.registration, registrations)}
                  />
                  <DetailRow theme={theme} label="Stable ID" value={registrationOnly.id} mono />
                </>
              ) : null}
            </View>

            {registrationOnly ? (
              <Notice text={registrationOnlyDetailText()} theme={theme} />
            ) : null}

            {childError ? <Notice text={childError} tone="danger" theme={theme} /> : null}

            {sandbox ? (
              <LiveMetricsPanel
                theme={theme}
                compact={compact}
                availability={
                  metricsEnabled
                    ? metrics.availability
                    : { status: "unavailable", reason: "not_running" }
                }
                points={metricsEnabled ? metrics.points : []}
                loading={metricsEnabled && metrics.loading}
              />
            ) : null}

            {child.kind === "pending" && child.error ? (
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <ActionButton
                  label={retrying ? "Retrying…" : "Retry create"}
                  theme={theme}
                  variant="primary"
                  onPress={() => void retryCreate()}
                  disabled={retrying || dismissing}
                  compact
                />
                <ActionButton
                  label={dismissing ? "Dismissing…" : "Dismiss"}
                  theme={theme}
                  onPress={() => void dismissCreate()}
                  disabled={retrying || dismissing}
                  compact
                />
              </View>
            ) : null}

            {child.kind === "pending" && child.phase !== "failed" ? (
              <Notice
                text="Waiting for the sandbox to be created. Repair and Delete become available when it exists."
                theme={theme}
              />
            ) : null}

            {retryError ? <Notice text={retryError} tone="danger" theme={theme} /> : null}

            {repairError ? (
              <Notice text={repairError} tone="danger" theme={theme} />
            ) : null}

            {sandbox && logs ? (
              <LogBlock
                title="Logs"
                bundle={mergeLogBundles(logs.sandbox, logs.job)}
                theme={theme}
                defaultOpen={logsDefaultOpen}
              />
            ) : null}
          </>
        ) : null}
      </ScrollView>

      {sandbox ? (
        <ResizeChild
          open={resizeOpen}
          name={sandbox.name}
          id={sandbox.id}
          observed={sandbox.resources}
          requestedResources={sandbox.requestedResources}
          runtimeStatus={sandbox.runtimeStatus}
          theme={theme}
          compact={compact}
          onOpenChange={setResizeOpen}
          onResize={resize}
        />
      ) : null}

      <Modal title="Delete child" open={deleteOpen} onOpenChange={setDeleteOpen}>
        <Modal.Content>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
            {deleteTarget
              ? deleteConfirmationText(name, deleteTarget.kind)
              : "This child is no longer available. Close this dialog."}
          </Text>
          {deleteError ? (
            <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{deleteError}</Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <ActionButton
              label="Cancel"
              theme={theme}
              onPress={() => setDeleteOpen(false)}
              disabled={deleting}
            />
            <ActionButton
              label={deleting ? "Deleting…" : "Delete"}
              theme={theme}
              variant="danger"
              onPress={() => void confirmDelete()}
              disabled={deleting || !deleteTarget}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function ChildPills({
  child,
  registrations,
  theme,
}: {
  child: VmChild;
  registrations: Availability;
  theme: PluginTheme;
}) {
  const setup = setupPill(child);
  const vm = vmPill(child, registrations);

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      <StatusPill label={setup.label} tone={setup.tone} theme={theme} filled />
      <StatusPill label={vm.label} tone={vm.tone} theme={theme} filled />
    </View>
  );
}

function LiveMetricsPanel({
  theme,
  compact,
  availability,
  points,
  loading,
}: {
  theme: PluginTheme;
  compact: boolean;
  availability: VmMetricsResult | null;
  points: readonly MetricsHistoryPoint[];
  loading: boolean;
}) {
  const latest = availability?.status === "available" && points.length > 0
    ? points[points.length - 1]
    : null;
  const message =
    availability?.status === "unavailable"
      ? metricsUnavailableText(availability.reason)
      : loading
        ? "Reading metrics…"
        : "Waiting for the first sample…";

  return (
    <View
      style={{
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}
        >
          Live metrics
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
          {`refreshes every ${METRICS_POLL_INTERVAL_MS / 1000} s`}
        </Text>
      </View>

      {latest ? (
        <View style={{ gap: 8 }}>
          <MetricsChart points={points} theme={theme} compact={compact} />
          <RootDiskBar sample={latest.sample} theme={theme} />
        </View>
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {message}
        </Text>
      )}
    </View>
  );
}

function DetailRow({
  theme,
  label,
  value,
  mono = false,
}: {
  theme: PluginTheme;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
      <Text
        style={{
          color: theme.colors.foreground,
          fontSize: 12,
          fontFamily: mono ? "monospace" : undefined,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

