import { Loading, Modal, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import type {
  Availability,
  VmChild,
  VmCreateInput,
  VmDeleteInput,
  VmDetailResult,
  VmReconcileResult,
} from "../shared/contracts";
import {
  childErrorText,
  childPhase,
  deleteConfirmationText,
  errorMessage,
  phaseText,
  reconcileFailureMessage,
  reconcileSuccessMessage,
  registrationText,
  runtimeText,
  setupPill,
  vmPill,
} from "./state";
import { ActionButton, IconButton, LogBlock, Notice, StatusPill, type PluginTheme } from "./ui";

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
  onDelete(input: VmDeleteInput): Promise<void>;
  onDeleted(): void;
}

/**
 * Read-only detail with bounded logs, Repair, and Delete. Delete always names
 * the child and states that the sandbox and registration are removed.
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
  onDelete,
  onDeleted,
}: ChildDetailProps) {
  const toast = useToast();
  const [repairing, setRepairing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const child = data?.child ?? null;
  const registrations = data?.registrations ?? ({ status: "available" } as const);
  const sandbox = child?.kind === "sandbox" ? child : null;
  const registrationOnly = child?.kind === "registration" ? child : null;
  const deleteTarget = sandbox ?? registrationOnly;
  const childError = child ? childErrorText(child) : null;
  const logs = data?.logs ?? null;
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
      await onRetryCreate({
        requestId: child.requestId,
        secretEnvVars: child.credentialNames,
      });
      toast.show(`Retrying ${child.name}.`, { variant: "info" });
    } catch (retryFailure) {
      const message = errorMessage(retryFailure);
      setRetryError(message);
      toast.error(message);
    } finally {
      setRetrying(false);
    }
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
          <Notice
            text={
              data.inventory.status === "unavailable"
                ? "Inventory is unavailable, so this child's state cannot be confirmed. It is not known to be deleted."
                : "This child is no longer in the managed inventory. It may have been deleted or reloaded."
            }
            theme={theme}
          />
        ) : null}

        {child ? (
          <>
            <ChildPills child={child} registrations={registrations} theme={theme} />

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
              <DetailRow theme={theme} label="Phase" value={phaseText(childPhase(child))} />
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

            {childError ? <Notice text={childError} tone="danger" theme={theme} /> : null}

            {child.kind === "pending" && child.error ? (
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <ActionButton
                  label={retrying ? "Retrying…" : "Retry create"}
                  theme={theme}
                  variant="primary"
                  onPress={() => void retryCreate()}
                  disabled={retrying}
                  compact
                />
              </View>
            ) : null}

            {deleteTarget ? null : (
              <Notice
                text="Waiting for the sandbox to be created. Repair and Delete become available when it exists."
                theme={theme}
              />
            )}

            {retryError ? <Notice text={retryError} tone="danger" theme={theme} /> : null}

            {repairError ? (
              <Notice text={repairError} tone="danger" theme={theme} />
            ) : null}

            {sandbox && logs ? (
              <View style={{ gap: 12 }}>
                <LogBlock
                  title="Sandbox logs"
                  bundle={logs.sandbox}
                  theme={theme}
                  defaultOpen={logsDefaultOpen}
                />
                <LogBlock
                  title="Pi install logs"
                  bundle={logs.job}
                  theme={theme}
                  defaultOpen={logsDefaultOpen}
                />
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      <Modal title="Delete child" open={deleteOpen} onOpenChange={setDeleteOpen}>
        <Modal.Content>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
            {deleteConfirmationText(name)}
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
              disabled={deleting}
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

