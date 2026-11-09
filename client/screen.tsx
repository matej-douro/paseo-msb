import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Child } from "../shared/contracts";
import { createChild } from "./actions";
import { ChildDetail } from "./ChildDetail";
import { ChildList } from "./ChildList";
import { CreateChild, type CreateChildInput } from "./CreateChild";
import { newCreateAttempt, type CreateAttempt } from "./create";
import { useVmApi } from "./hooks/useVmApi";
import { useVmDetail } from "./hooks/useVmDetail";
import { useVmList } from "./hooks/useVmList";
import { rememberChildName, rememberedChildName } from "./selection";

export function MsbScreen({ theme, layout, host, params }: PluginScreenProps) {
  const api = useVmApi();
  const toast = useToast();
  const list = useVmList();
  const [selectedName, setSelectedName] = useState<string | null>(
    () => params.name || rememberedChildName(),
  );
  const [attempt, setAttempt] = useState<CreateAttempt | null>(null);

  useEffect(() => {
    if (params.name) rememberChildName(params.name);
  }, [params.name]);

  const selectedFromList =
    selectedName === null
      ? null
      : (list.data?.children.find((child) => child.name === selectedName) ?? null);
  const detail = useVmDetail(selectedName, selectedFromList?.id ?? null);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, backgroundColor: theme.colors.surface0 },
        header: {
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: layout.compact ? 16 : 24,
          paddingVertical: layout.compact ? 12 : 16,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        },
        headerText: { flex: 1, minWidth: 0, gap: 2 },
        title: { color: theme.colors.foreground, fontSize: 18, fontWeight: "700" },
        subtitle: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 16,
        },
        create: {
          minHeight: 38,
          paddingHorizontal: 14,
          borderRadius: 9,
          backgroundColor: theme.colors.accent,
          alignItems: "center",
          justifyContent: "center",
        },
        createText: {
          color: theme.colors.accentForeground,
          fontSize: 12,
          fontWeight: "700",
        },
        body: { flex: 1, minHeight: 0 },
        bodyWide: { flexDirection: "row" },
        bodyCompact: { flexDirection: "column" },
        listPane: { flex: 1, minWidth: 0, minHeight: 0 },
        detailPane: { flex: 1.15, minWidth: 0, minHeight: 0 },
        detailDivider: { borderLeftWidth: 1, borderLeftColor: theme.colors.border },
      }),
    [theme, layout.compact],
  );

  function selectChild(name: string): void {
    rememberChildName(name);
    setSelectedName(name);
  }

  function clearSelection(): void {
    rememberChildName(null);
    setSelectedName(null);
  }

  function openCreate(): void {
    setAttempt(newCreateAttempt());
  }

  async function submitCreate(input: CreateChildInput): Promise<void> {
    await createChild(api, input);
    setAttempt(null);
    await list.refresh();
    toast.show("Creation started.", { variant: "info" });
  }

  async function deleted(child: Child): Promise<void> {
    clearSelection();
    await list.refresh();
    toast.show(`Deleted ${child.name}.`, { variant: "success" });
  }

  async function changed(): Promise<void> {
    await Promise.all([detail.refresh(), list.refresh()]);
  }

  const pending = detail.data?.pending ?? null;
  const detailErrorCode = detail.data?.error?.code;
  const child =
    detail.data?.child ??
    (detailErrorCode === "sandbox_not_found" || detailErrorCode === "sandbox_replaced"
      ? null
      : selectedFromList);
  const inventory =
    detail.data?.inventory ??
    list.data?.inventory ?? { status: "available" as const, error: null };
  const registrations =
    detail.data?.registrations ??
    list.data?.registrations ?? { status: "available" as const, error: null };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Paseo MSB</Text>
          <Text numberOfLines={1} style={styles.subtitle}>
            Pi child hosts on {host.label}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create child"
          disabled={list.data === null}
          onPress={openCreate}
          style={[styles.create, { opacity: list.data === null ? 0.5 : 1 }]}
        >
          <Text style={styles.createText}>Create child</Text>
        </Pressable>
      </View>

      <View
        style={[
          styles.body,
          layout.compact ? styles.bodyCompact : styles.bodyWide,
        ]}
      >
        {!layout.compact || selectedName === null ? (
          <View style={styles.listPane}>
            <ChildList
              theme={theme}
              data={list.data}
              loading={list.loading}
              error={list.error}
              selectedName={selectedName}
              onSelect={selectChild}
              onRetry={() => {
                void list.refresh();
              }}
            />
          </View>
        ) : null}

        {selectedName !== null ? (
          <View
            style={[
              styles.detailPane,
              layout.compact ? null : styles.detailDivider,
            ]}
          >
            <ChildDetail
              theme={theme}
              compact={layout.compact}
              name={selectedName}
              child={child}
              pending={pending}
              logs={detail.data?.logs ?? null}
              loading={detail.loading}
              error={detail.error}
              parent={list.data?.parent ?? null}
              inventory={inventory}
              registrations={registrations}
              onBack={clearSelection}
              onChanged={changed}
              onDeleted={deleted}
            />
          </View>
        ) : null}
      </View>

      <CreateChild
        open={attempt !== null}
        requestId={attempt?.requestId ?? ""}
        credentials={list.data?.credentials ?? []}
        theme={theme}
        onOpenChange={(open) => {
          if (!open) setAttempt(null);
        }}
        onSubmit={submitCreate}
      />
    </View>
  );
}
