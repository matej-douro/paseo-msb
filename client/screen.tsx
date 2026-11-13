import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View, type ViewStyle } from "react-native";
import { CPUS, MEMORY_MIB, PI_VERSION, type CredentialName } from "../shared/constants";
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
  const [selectedName, setSelectedName] = useState<string | null>(params.name ?? null);
  const detail = useVmDetail(selectedName);
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
    if (params.name) setSelectedName(params.name);
  }, [params.name]);

  const handleCreate = async (input: VmCreateInput) => {
    const result = await create(input);
    setSelectedName(result.name);
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
    setSelectedName(null);
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
        padding: compact ? 12 : 20,
        gap: compact ? 10 : 14,
      },
      header: {
        flexDirection: compact ? "column" : "row",
        alignItems: compact ? "stretch" : "center",
        justifyContent: "space-between",
        gap: 10,
      },
      columns: { flex: 1, flexDirection: "row", gap: 14, minHeight: 0 },
      listPane: { width: 360, minHeight: 0 },
      detailPane: { flex: 1, minHeight: 0 },
      compactPane: { flex: 1, minHeight: 0 },
      emptyDetail: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      },
    }),
    [theme, compact],
  );

  const header = (
    <View style={styles.header}>
      <View style={{ gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: compact ? 20 : 24, fontWeight: "600" }}>
          Paseo microVM hosts
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {CPUS} vCPU · {MEMORY_MIB} MiB · Pi {PI_VERSION} · loopback only
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
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
  );

  const listPane = (
    <ChildList
      data={list.data}
      error={list.error}
      loading={list.loading}
      selectedName={selectedName}
      theme={theme}
      compact={compact}
      onSelect={setSelectedName}
      onRetry={() => void list.refresh()}
    />
  );

  const detailPane = selectedName ? (
    <ChildDetail
      key={selectedName}
      name={selectedName}
      data={detail.data}
      loading={detail.loading}
      error={detail.error}
      theme={theme}
      compact={compact}
      onBack={() => setSelectedName(null)}
      onRetry={() => void detail.refresh()}
      onRepair={handleRepair}
      onDelete={handleDelete}
      onDeleted={() => {
        setSelectedName(null);
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
        Select a child to see bounded logs, Repair, and Delete.
      </Text>
    </View>
  );

  return (
    <View style={styles.screen}>
      {header}

      {compact ? (
        <View style={styles.compactPane}>{selectedName ? detailPane : listPane}</View>
      ) : (
        <View style={styles.columns}>
          <View style={styles.listPane}>{listPane}</View>
          <View style={styles.detailPane}>{detailPane}</View>
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
