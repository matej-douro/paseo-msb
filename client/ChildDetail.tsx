import { Loading, Modal, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import type {
  LogBundle,
  VmDeleteInput,
  VmDetailResult,
  VmReconcileResult,
} from "../shared/contracts";
import {
  childErrorText,
  childPhase,
  childTone,
  deleteConfirmationText,
  errorMessage,
  logBundleSummary,
  phaseText,
  reconcileFailureMessage,
  reconcileSuccessMessage,
  registrationText,
  registrationTone,
  runtimeText,
} from "./state";
import { ActionButton, Notice, StatusPill, type PluginTheme } from "./ui";

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
  onDelete,
  onDeleted,
}: ChildDetailProps) {
  const toast = useToast();
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const child = data?.child ?? null;
  const sandbox = child?.kind === "sandbox" ? child : null;

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

  const confirmDelete = async () => {
    if (!sandbox || deleting) return;
    setDeleting(true);
    setDeleteError(null);

    try {
      await onDelete({
        name: sandbox.name,
        id: sandbox.id,
        confirmName: sandbox.name,
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
              color: theme.colors.foreground,
              fontSize: 15,
              fontWeight: "600",
              flexShrink: 1,
            }}
          >
            {name}
          </Text>
          {child ? (
            <StatusPill
              label={phaseText(childPhase(child))}
              tone={childTone(child)}
              theme={theme}
            />
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
            text="This child is no longer in the managed inventory. It may have been deleted or reloaded."
            theme={theme}
          />
        ) : null}

        {child ? (
          <>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
              <DetailRow
                theme={theme}
                label="Phase"
                value={phaseText(childPhase(child))}
              />
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
                    value={registrationText(sandbox.registration)}
                  />
                  <DetailRow theme={theme} label="Stable ID" value={sandbox.id} mono />
                </>
              ) : (
                <DetailRow theme={theme} label="Kind" value="Pending create" />
              )}
            </View>

            {sandbox?.registration ? (
              <StatusPill
                label={registrationText(sandbox.registration)}
                tone={registrationTone(sandbox.registration)}
                theme={theme}
              />
            ) : null}

            {childErrorText(child) ? (
              <Notice text={childErrorText(child)!} tone="danger" theme={theme} />
            ) : null}

            {sandbox ? (
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <ActionButton
                  label={repairing ? "Repairing…" : "Repair"}
                  theme={theme}
                  onPress={() => void repair()}
                  disabled={repairing || deleting}
                  compact
                />
                <ActionButton
                  label="Delete"
                  theme={theme}
                  variant="danger"
                  onPress={() => {
                    setDeleteError(null);
                    setDeleteOpen(true);
                  }}
                  disabled={repairing || deleting}
                  compact
                />
              </View>
            ) : (
              <Notice
                text="Waiting for the sandbox to be created. Repair and Delete become available when it exists."
                theme={theme}
              />
            )}

            {repairError ? (
              <Notice text={repairError} tone="danger" theme={theme} />
            ) : null}

            {sandbox ? (
              <View style={{ gap: 12 }}>
                <LogSection title="Sandbox logs" bundle={data!.logs.sandbox} theme={theme} />
                <LogSection title="Pi install logs" bundle={data!.logs.job} theme={theme} />
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

function LogSection({
  title,
  bundle,
  theme,
}: {
  title: string;
  bundle: LogBundle;
  theme: PluginTheme;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
        {title}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {logBundleSummary(bundle)}
      </Text>

      {bundle.entries.map((entry, index) => (
        <View
          key={`${entry.timestamp}-${index}`}
          style={{
            flexDirection: "row",
            gap: 6,
            backgroundColor: theme.colors.surface1,
            borderRadius: 4,
            paddingVertical: 3,
            paddingHorizontal: 6,
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
            {entry.timestamp.slice(11, 19)}
          </Text>
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 11,
              fontFamily: "monospace",
              flexShrink: 1,
            }}
          >
            {entry.text}
          </Text>
        </View>
      ))}
    </View>
  );
}
