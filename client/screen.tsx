import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View, type ViewStyle } from "react-native";
import type { CredentialName } from "../shared/constants";
import {
  secretsDeleteRpc,
  secretsSetRpc,
  vmCreateRpc,
  vmDeleteRpc,
  vmReconcileRpc,
  type VmCreateInput,
  type VmDeleteInput,
} from "../shared/contracts";
import { ChildDetail } from "./ChildDetail";
import { ChildList } from "./ChildList";
import { CreateChild } from "./CreateChild";
import { useSecrets } from "./hooks/useSecrets";
import { useVmDetail } from "./hooks/useVmDetail";
import { useVmList } from "./hooks/useVmList";
import { ManageSecrets } from "./ManageSecrets";
import { ActionButton } from "./ui";

/**
 * The single v1 management screen: create confirmation, child list, and one
 * detail pane. Children are used through Paseo's normal host picker.
 */
export function MainScreen({ theme, layout, params }: PluginScreenProps) {
  const compact = layout.compact;
  const list = useVmList();
  const [selection, setSelection] = useState<{ name: string; id?: string } | null>(
    params.name ? { name: params.name } : null,
  );
  const selectedName = selection?.name ?? null;
  const detail = useVmDetail(selectedName, selection?.id);
  const [createOpen, setCreateOpen] = useState(false);
  const [secretsOpen, setSecretsOpen] = useState(false);

  const create = useRpc(vmCreateRpc);
  const reconcile = useRpc(vmReconcileRpc);
  const remove = useRpc(vmDeleteRpc);
  const secrets = useSecrets();
  const setSecret = useRpc(secretsSetRpc);
  const removeSecret = useRpc(secretsDeleteRpc);
  const toast = useToast();

  const refreshSecrets = useCallback(() => {
    void secrets.refresh();
  }, [secrets.refresh]);

  // Reconnect to the child named in the screen params after navigation.
  useEffect(() => {
    if (params.name) setSelection({ name: params.name });
  }, [params.name]);

  const handleCreate = async (input: VmCreateInput) => {
    const result = await create(input);
    setSelection({ name: result.name });
    toast.show(`Creating ${result.name}.`, { variant: "info" });
    await list.refresh();
  };

  const handleRepair = async (name: string) => {
    const result = await reconcile({ name });
    await Promise.all([list.refresh(), detail.refresh()]);
    return result;
  };

  const handleDelete = async (input: VmDeleteInput) => {
    await remove(input);
    setSelection(null);
    await list.refresh();
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
      },
      panelTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
      panelActions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
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
      selectedName={selectedName}
      selectedId={selection?.id ?? null}
      theme={theme}
      compact={compact}
      onSelect={(child) =>
        setSelection({
          name: child.name,
          ...(child.kind === "pending" ? {} : { id: child.id }),
        })
      }
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
          <ActionButton
            label="Manage secrets"
            theme={theme}
            onPress={() => setSecretsOpen(true)}
            compact={compact}
          />
          <ActionButton
            label="Create child"
            theme={theme}
            variant="primary"
            onPress={() => setCreateOpen(true)}
            compact={compact}
          />
        </View>
      </View>
      <View style={{ flex: 1, minHeight: 0 }}>{listPane}</View>
    </View>
  );

  const detailPane = selection ? (
    <ChildDetail
      key={`${selection.name}:${selection.id ?? "pending"}`}
      name={selection.name}
      data={detail.data}
      loading={detail.loading}
      error={detail.error}
      theme={theme}
      compact={compact}
      onBack={() => setSelection(null)}
      onRetry={() => void detail.refresh()}
      onRepair={handleRepair}
      onRetryCreate={handleCreate}
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
        onRefresh={refreshSecrets}
        onSet={handleSetSecret}
        onDelete={handleDeleteSecret}
      />
    </View>
  );
}
