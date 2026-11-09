import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { LOG_ENTRY_LIMIT } from "../shared/constants";
import type {
  Child,
  InventoryState,
  Parent,
  PendingChild,
} from "../shared/contracts";
import type { VmApi } from "./api";
import {
  childStatus,
  childTone,
  inventoryNotices,
  pendingStatus,
  pendingTone,
  phaseLabel,
  safeErrorText,
  type Tone,
} from "./format";
import { useChildActions } from "./hooks/useChildActions";

type DetailData = Awaited<ReturnType<VmApi["detail"]>>;
type LogBatch = DetailData["logs"];

export interface ChildDetailProps {
  theme: PluginTheme;
  compact: boolean;
  name: string;
  child: Child | null;
  pending: PendingChild | null;
  logs: LogBatch | null;
  loading: boolean;
  error: string | null;
  parent: Parent | null;
  inventory: InventoryState;
  registrations: InventoryState;
  onBack(): void;
  onChanged(): Promise<void>;
  onDeleted(child: Child): Promise<void>;
}

function toneColor(theme: PluginTheme, tone: Tone): string {
  if (tone === "success") return theme.colors.statusSuccess;
  if (tone === "warning") return theme.colors.statusWarning;
  if (tone === "danger") return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

export function ChildDetail({
  theme,
  compact,
  name,
  child,
  pending,
  logs,
  loading,
  error,
  parent,
  inventory,
  registrations,
  onBack,
  onChanged,
  onDeleted,
}: ChildDetailProps) {
  const actions = useChildActions(onChanged, onDeleted);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [repairNote, setRepairNote] = useState<string | null>(null);

  const clearActionError = actions.clearError;

  useEffect(() => {
    setDeleteOpen(false);
    setRepairNote(null);
    clearActionError();
  }, [name, clearActionError]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, minHeight: 0 },
        topBar: {
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: 44,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        },
        back: {
          minHeight: 32,
          paddingHorizontal: 10,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
        },
        backText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
        content: { padding: 16, gap: 14 },
        name: {
          color: theme.colors.foreground,
          fontSize: 16,
          fontWeight: "700",
          lineHeight: 22,
        },
        statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
        dot: { width: 8, height: 8, borderRadius: 4 },
        status: {
          flex: 1,
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 17,
        },
        notice: {
          padding: 10,
          borderWidth: 1,
          borderRadius: 10,
          fontSize: 12,
          lineHeight: 17,
        },
        hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
        section: {
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          fontWeight: "600",
          textTransform: "uppercase",
          letterSpacing: 0.7,
        },
        actions: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
        button: {
          minHeight: 38,
          paddingHorizontal: 14,
          borderRadius: 9,
          borderWidth: 1,
          alignItems: "center",
          justifyContent: "center",
        },
        buttonText: { fontSize: 12, fontWeight: "600" },
        dangerText: { color: theme.colors.statusDanger },
        successText: { color: theme.colors.statusSuccess },
        errorText: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 17 },
        logEntry: {
          gap: 4,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        },
        logMeta: {
          color: theme.colors.foregroundMuted,
          fontSize: 10,
          textTransform: "uppercase",
        },
        logText: {
          color: theme.colors.foreground,
          fontSize: 11,
          lineHeight: 16,
          fontFamily: Platform.select({
            ios: "Menlo",
            android: "monospace",
            default: "monospace",
          }),
        },
        modalBody: { backgroundColor: theme.colors.surface1 },
        modalTitle: {
          color: theme.colors.statusDanger,
          fontSize: 16,
          fontWeight: "700",
        },
        modalText: { color: theme.colors.foreground, fontSize: 13, lineHeight: 19 },
      }),
    [theme],
  );

  const notices = inventoryNotices({ parent, inventory, registrations });
  const detailError = error;
  const managedChild = child;
  const tone = managedChild
    ? childTone(managedChild)
    : pending
      ? pendingTone(pending)
      : "muted";
  const status = managedChild
    ? childStatus(managedChild)
    : pending
      ? pendingStatus(pending)
      : "";

  async function repair(): Promise<void> {
    if (!managedChild) return;
    setRepairNote(null);
    const result = await actions.repair(managedChild);
    if (result) {
      setRepairNote(`Repair finished. Phase: ${phaseLabel(result.phase)}.`);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!managedChild) return;
    const deleted = await actions.remove(managedChild, managedChild.name);
    if (deleted) setDeleteOpen(false);
  }

  return (
    <View style={styles.root}>
      {compact ? (
        <View style={styles.topBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to child list"
            onPress={onBack}
            style={styles.back}
          >
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.content}>
        <Text selectable style={styles.name}>
          {name}
        </Text>

        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: toneColor(theme, tone) }]} />
          <Text style={styles.status}>{status}</Text>
        </View>

        {detailError ? <Text style={styles.errorText}>{detailError}</Text> : null}
        {managedChild?.error ? (
          <Text style={styles.errorText}>{safeErrorText(managedChild.error)}</Text>
        ) : null}
        {pending?.error ? (
          <Text style={styles.errorText}>{safeErrorText(pending.error)}</Text>
        ) : null}

        {notices.map((notice) => (
          <Text
            key={notice.text}
            style={[
              styles.notice,
              {
                color:
                  notice.tone === "danger"
                    ? theme.colors.statusDanger
                    : theme.colors.statusWarning,
                borderColor:
                  notice.tone === "danger"
                    ? theme.colors.statusDanger
                    : theme.colors.statusWarning,
              },
            ]}
          >
            {notice.text}
          </Text>
        ))}

        {!managedChild && pending ? (
          <Text style={styles.hint}>
            Creation is in progress. Logs and Repair become available after the sandbox
            exists.
          </Text>
        ) : null}

        {managedChild ? (
          <>
            <Text style={styles.section}>Actions</Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Repair ${managedChild.name}`}
                accessibilityState={{
                  disabled: actions.repairing || actions.deleting,
                }}
                disabled={actions.repairing || actions.deleting}
                onPress={() => {
                  void repair();
                }}
                style={[
                  styles.button,
                  {
                    borderColor: theme.colors.border,
                    opacity: actions.repairing || actions.deleting ? 0.5 : 1,
                  },
                ]}
              >
                <Text style={[styles.buttonText, { color: theme.colors.foreground }]}>
                  {actions.repairing ? "Repairing…" : "Repair"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Delete ${managedChild.name}`}
                accessibilityState={{ disabled: actions.repairing || actions.deleting }}
                disabled={actions.repairing || actions.deleting}
                onPress={() => {
                  actions.clearError();
                  setDeleteOpen(true);
                }}
                style={[
                  styles.button,
                  {
                    borderColor: theme.colors.statusDanger,
                    opacity: actions.repairing || actions.deleting ? 0.5 : 1,
                  },
                ]}
              >
                <Text style={[styles.buttonText, styles.dangerText]}>Delete</Text>
              </Pressable>
            </View>
            {repairNote ? (
              <Text style={[styles.hint, styles.successText]}>{repairNote}</Text>
            ) : null}
            {actions.error ? <Text style={styles.errorText}>{actions.error}</Text> : null}
          </>
        ) : null}

        <Text style={styles.section}>Logs</Text>
        {logs === null ? (
          <Text style={styles.hint}>{loading ? "Loading logs…" : "Logs are unavailable."}</Text>
        ) : (
          <>
            {logs.status === "partial" && logs.error ? (
              <Text
                style={[
                  styles.notice,
                  {
                    color: theme.colors.statusWarning,
                    borderColor: theme.colors.statusWarning,
                  },
                ]}
              >
                {safeErrorText(logs.error)}
              </Text>
            ) : null}
            {logs.status === "unavailable" ? (
              <Text style={styles.errorText}>
                {safeErrorText(logs.error) ?? "Logs are unavailable."}
              </Text>
            ) : null}
            {logs.status !== "unavailable" && logs.entries.length === 0 ? (
              <Text style={styles.hint}>No log entries yet.</Text>
            ) : null}
            {logs.status !== "unavailable" && logs.entries.length > 0 ? (
              logs.entries.slice(-LOG_ENTRY_LIMIT).map((entry, index) => (
                <View key={`${entry.source}-${entry.timestamp ?? "none"}-${index}`} style={styles.logEntry}>
                  <Text style={styles.logMeta}>
                    {entry.source} · {entry.stream}
                    {entry.timestamp ? ` · ${entry.timestamp}` : ""}
                  </Text>
                  <Text selectable style={styles.logText}>
                    {entry.text}
                  </Text>
                </View>
              ))
            ) : null}
          </>
        )}
      </ScrollView>

      {managedChild ? (
        <Modal
          title="Delete child"
          open={deleteOpen}
          onOpenChange={(open) => {
            if (!open && actions.deleting) return;
            setDeleteOpen(open);
            if (!open) actions.clearError();
          }}
        >
          <Modal.Content style={styles.modalBody}>
            <Text style={styles.modalTitle}>Delete {managedChild.name}?</Text>
            <Text style={styles.modalText}>
              This destroys its sandbox and removes its Paseo registration.
            </Text>
            {actions.error ? <Text style={styles.errorText}>{actions.error}</Text> : null}
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel delete"
                disabled={actions.deleting}
                onPress={() => {
                  setDeleteOpen(false);
                  actions.clearError();
                }}
                style={[
                  styles.button,
                  {
                    borderColor: theme.colors.border,
                    opacity: actions.deleting ? 0.5 : 1,
                  },
                ]}
              >
                <Text style={[styles.buttonText, { color: theme.colors.foreground }]}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Confirm delete ${managedChild.name}`}
                accessibilityState={{ disabled: actions.deleting }}
                disabled={actions.deleting}
                onPress={() => {
                  void confirmDelete();
                }}
                style={[
                  styles.button,
                  {
                    borderColor: theme.colors.statusDanger,
                    backgroundColor: theme.colors.statusDanger,
                    opacity: actions.deleting ? 0.5 : 1,
                  },
                ]}
              >
                <Text style={[styles.buttonText, { color: theme.colors.accentForeground }]}>
                  {actions.deleting ? "Deleting…" : "Delete"}
                </Text>
              </Pressable>
            </View>
          </Modal.Content>
        </Modal>
      ) : null}
    </View>
  );
}
