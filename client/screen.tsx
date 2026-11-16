import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Text, View, type ViewStyle } from "react-native";
import type { CredentialName } from "../shared/constants";
import {
  secretsDeleteRpc,
  secretsListRpc,
  secretsSetRpc,
  vmCreateRpc,
  vmDeleteRpc,
  vmDismissRpc,
  vmReconcileRpc,
  type VmCreateInput,
  type VmDeleteInput,
  type VmDismissInput,
} from "../shared/contracts";
import { ChildDetail } from "./ChildDetail";
import { ChildList } from "./ChildList";
import { CreateChild } from "./CreateChild";
import { useSecrets } from "./hooks/useSecrets";
import { useVmDetail } from "./hooks/useVmDetail";
import { useVmList } from "./hooks/useVmList";
import { ManageSecrets } from "./ManageSecrets";
import { createBlockedMessage, errorMessage, selectChildFor, selectionFor, type ChildSelection } from "./state";
import { IconButton } from "./ui";

/**
 * The single v1 management screen: create confirmation, child list, and one
 * detail pane. Children are used through Paseo's normal host picker.
 */
export function MainScreen({ theme, layout, params }: PluginScreenProps) {
  const compact = layout.compact;
  const list = useVmList();
  const [selection, setSelection] = useState<ChildSelection | null>(
    params.name ? { name: params.name } : null,
  );
  const selectedName = selection?.name ?? null;
  const selectedChild =
    selection && list.data ? selectChildFor(list.data.children, selection) : null;
  // A pending attempt has no generation id, so only non-pending children pass one.
  const detailId = selectedChild?.kind === "pending" ? undefined : selectedChild?.id;
  const detail = useVmDetail(selectedName, detailId);
  const [createOpen, setCreateOpen] = useState(false);
  const [createChecking, setCreateChecking] = useState(false);
  const [secretsOpen, setSecretsOpen] = useState(false);

  const create = useRpc(vmCreateRpc);
  const dismiss = useRpc(vmDismissRpc);
  const reconcile = useRpc(vmReconcileRpc);
  const remove = useRpc(vmDeleteRpc);
  const readSecrets = useRpc(secretsListRpc);
  const secrets = useSecrets();
  const setSecret = useRpc(secretsSetRpc);
  const removeSecret = useRpc(secretsDeleteRpc);
  const toast = useToast();

  // Reconnect to the child named in the screen params after navigation.
  useEffect(() => {
    if (params.name) setSelection({ name: params.name });
  }, [params.name]);

  const createChild = async (input: VmCreateInput) => {
    const result = await create(input);
    setSelection({ name: result.name });
    await list.refresh();
    return result;
  };

  const handleCreate = async (input: VmCreateInput) => {
    try {
      await readSecrets({});
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
    const result = await createChild(input);
    toast.show(`Creating ${result.name}.`, { variant: "info" });
  };

  // ChildDetail owns the "Retrying" toast, so this path does not add another.
  const handleRetryCreate = async (input: VmCreateInput) => {
    await readSecrets({});
    await createChild(input);
  };

  const handleDismiss = async (input: VmDismissInput) => {
    await dismiss(input);
  };

  const handleRepair = async (name: string) => {
    const result = await reconcile({ name });
    await Promise.all([list.refresh(), detail.refresh()]);
    return result;
  };

  // Selection and list cleanup live in onDeleted, after the success toast.
  const handleDelete = async (input: VmDeleteInput) => {
    await remove(input);
  };

  const openCreate = async () => {
    if (createChecking) return;
    const blocked = createBlockedMessage(list.data, list.error);
    if (blocked) {
      toast.error(blocked);
      return;
    }

    setCreateChecking(true);
    try {
      // A fresh read turns an unreadable store into an action failure instead
      // of presenting stale or empty credential availability as authoritative.
      await readSecrets({});
      setCreateOpen(true);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setCreateChecking(false);
    }
  };

  const handleSetSecret = async (name: CredentialName, value: string) => {
    await setSecret({ name, value });
    await Promise.all([secrets.refresh(), list.refresh()]);
    toast.show(`Saved ${name}.`, { variant: "success" });
  };

  const handleDeleteSecret = async (name: CredentialName) => {
    await removeSecret({ name });
    await Promise.all([secrets.refresh(), list.refresh()]);
    toast.show(`Removed stored ${name}.`, { variant: "info" });
  };

  const styles = useMemo<Record<string, ViewStyle>>(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
        padding: compact ? 10 : 12,
        gap: 10,
      },
      columns: { flex: 1, flexDirection: "row", gap: 12, minHeight: 0 },
      listColumn: { width: compact ? undefined : 360, minHeight: 0 },
      // A bordered sheet separates the panes and holds the detail scrolling.
      panel: {
        flex: 1,
        minHeight: 0,
        borderColor: theme.colors.border,
        borderWidth: compact ? 0 : 1,
        borderRadius: compact ? 0 : 10,
        padding: compact ? 0 : 12,
        gap: 10,
        overflow: "hidden",
      },
      listPanel: { flex: 1, minHeight: 0, gap: 10 },
      panelHeader: {
        flexDirection: compact ? "column" : "row",
        alignItems: compact ? "stretch" : "center",
        justifyContent: "space-between",
        gap: 8,
        // Hover tooltips belong to the header and must paint above the list.
        position: "relative",
        zIndex: 20,
      },
      panelTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
      panelActions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
      listViewport: { flex: 1, minHeight: 0, position: "relative", zIndex: 0 },
      emptyDetail: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      },
    }),
    [theme, compact],
  );

  const listPane = (
    <ChildList
      data={list.data}
      error={list.error}
      loading={list.loading}
      selectedName={selectedChild?.name ?? null}
      selectedId={selectedChild && selectedChild.kind !== "pending" ? selectedChild.id : null}
      selectedPending={selectedChild?.kind === "pending"}
      theme={theme}
      compact={compact}
      onSelect={(child) => setSelection(selectionFor(child))}
      onRetry={() => void list.refresh()}
    />
  );

  // The screen header is gone: the buttons that matter live with the list.
  const listPanel = (
    <View style={styles.listPanel}>
      <View style={styles.panelHeader}>
        <View style={styles.panelTitleRow}>
          <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
            Child VMs
          </Text>
          {list.data ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {list.data.children.length}
            </Text>
          ) : null}
        </View>
        <View style={styles.panelActions}>
          <IconButton
            icon="KeyRound"
            label="Manage secrets"
            theme={theme}
            size={compact ? 28 : 30}
            onPress={() => setSecretsOpen(true)}
          />
          <IconButton
            icon="Plus"
            label={createChecking ? "Checking credentials…" : "Create child"}
            theme={theme}
            variant="primary"
            size={compact ? 28 : 30}
            disabled={createChecking}
            onPress={() => void openCreate()}
          />
        </View>
      </View>
      <View style={styles.listViewport}>{listPane}</View>
    </View>
  );

  const detailPane = selection ? (
    <ChildDetail
      key={`${selection.name}:${selection.id ?? ""}`}
      name={selection.name}
      data={detail.data}
      loading={detail.loading}
      error={detail.error}
      theme={theme}
      compact={compact}
      onBack={() => setSelection(null)}
      onRetry={() => void detail.refresh()}
      onRepair={handleRepair}
      onRetryCreate={handleRetryCreate}
      onDismiss={handleDismiss}
      onDismissed={() => {
        setSelection(null);
        void list.refresh();
      }}
      onDelete={handleDelete}
      onDeleted={() => {
        setSelection(null);
        void list.refresh();
      }}
    />
  ) : (
    <View style={styles.emptyDetail}>
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 13,
          textAlign: "center",
        }}
      >
        Select a child to see details.
      </Text>
    </View>
  );

  return (
    <View style={styles.screen}>
      {compact ? (
        selection ? (
          <View style={styles.panel}>{detailPane}</View>
        ) : (
          listPanel
        )
      ) : (
        <View style={styles.columns}>
          <View style={styles.listColumn}>{listPanel}</View>
          <View style={styles.panel}>{detailPane}</View>
        </View>
      )}

      <CreateChild
        open={createOpen}
        credentials={list.data?.credentials ?? []}
        storedCredentials={list.data?.storedCredentials ?? []}
        theme={theme}
        compact={compact}
        onOpenChange={setCreateOpen}
        onCreate={handleCreate}
      />

      <ManageSecrets
        open={secretsOpen}
        data={secrets.data}
        loading={secrets.loading}
        error={secrets.error}
        theme={theme}
        compact={compact}
        onOpenChange={setSecretsOpen}
        onRefresh={secrets.refresh}
        onSet={handleSetSecret}
        onDelete={handleDeleteSecret}
      />
    </View>
  );
}
