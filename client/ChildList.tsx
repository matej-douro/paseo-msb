import type { PluginTheme } from "@getpaseo/plugin";
import { Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type {
  Child,
  InventoryState,
  Parent,
  PendingChild,
} from "../shared/contracts";
import {
  childStatus,
  childTone,
  inventoryNotices,
  pendingStatus,
  pendingTone,
  safeErrorText,
  type Tone,
} from "./format";

export interface ChildListProps {
  theme: PluginTheme;
  data: {
    parent: Parent | null;
    pending: readonly PendingChild[];
    children: readonly Child[];
    inventory: InventoryState;
    registrations: InventoryState;
  } | null;
  loading: boolean;
  error: string | null;
  selectedName: string | null;
  onSelect(name: string): void;
  onRetry(): void;
}

function toneColor(theme: PluginTheme, tone: Tone): string {
  if (tone === "success") return theme.colors.statusSuccess;
  if (tone === "warning") return theme.colors.statusWarning;
  if (tone === "danger") return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

export function ChildList({
  theme,
  data,
  loading,
  error,
  selectedName,
  onSelect,
  onRetry,
}: ChildListProps) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, minHeight: 0 },
        content: { padding: 16, gap: 12 },
        section: {
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          fontWeight: "600",
          textTransform: "uppercase",
          letterSpacing: 0.7,
        },
        row: {
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 10,
          padding: 12,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 10,
          backgroundColor: theme.colors.surface1,
        },
        dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
        rowBody: { flex: 1, minWidth: 0, gap: 3 },
        name: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
        status: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 },
        error: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 16 },
        chevron: { color: theme.colors.foregroundMuted, fontSize: 18, lineHeight: 20 },
        notice: {
          padding: 10,
          borderWidth: 1,
          borderRadius: 10,
          fontSize: 12,
          lineHeight: 17,
        },
        empty: {
          gap: 6,
          paddingVertical: 24,
          paddingHorizontal: 16,
          alignItems: "center",
        },
        emptyTitle: {
          color: theme.colors.foreground,
          fontSize: 14,
          fontWeight: "600",
          textAlign: "center",
        },
        emptyText: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 17,
          textAlign: "center",
        },
        failed: { padding: 24, gap: 10, alignItems: "center" },
        failedText: { color: theme.colors.statusDanger, fontSize: 13, textAlign: "center" },
        retry: {
          minHeight: 36,
          paddingHorizontal: 14,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
        },
        retryText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
      }),
    [theme],
  );

  if (!data && loading) return <Loading />;

  if (!data && error) {
    return (
      <View style={styles.failed}>
        <Text style={styles.failedText}>{error}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry loading child VMs"
          onPress={onRetry}
          style={styles.retry}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const pending = data?.pending ?? [];
  const children = data?.children ?? [];
  const notices = data
    ? inventoryNotices({
        parent: data.parent,
        inventory: data.inventory,
        registrations: data.registrations,
      })
    : [];

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        {error ? (
          <Text
            style={[
              styles.notice,
              {
                color: theme.colors.statusDanger,
                borderColor: theme.colors.statusDanger,
              },
            ]}
          >
            {error}
          </Text>
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

        {pending.length > 0 ? (
          <>
            <Text style={styles.section}>Pending creates</Text>
            {pending.map((entry) => (
              <Row
                key={entry.name}
                name={entry.name}
                status={pendingStatus(entry)}
                error={safeErrorText(entry.error)}
                tone={pendingTone(entry)}
                selected={selectedName === entry.name}
                theme={theme}
                styles={styles}
                onSelect={onSelect}
              />
            ))}
          </>
        ) : null}

        {children.length > 0 ? (
          <>
            <Text style={styles.section}>Managed children</Text>
            {children.map((child) => (
              <Row
                key={child.id}
                name={child.name}
                status={childStatus(child)}
                error={safeErrorText(child.error)}
                tone={childTone(child)}
                selected={selectedName === child.name}
                theme={theme}
                styles={styles}
                onSelect={onSelect}
              />
            ))}
          </>
        ) : null}

        {pending.length === 0 && children.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {data?.inventory.status === "unavailable"
                ? "Managed children are unavailable"
                : "No child VMs yet"}
            </Text>
            <Text style={styles.emptyText}>
              {data?.inventory.status === "unavailable"
                ? "Inventory could not be read. Retry before creating a child."
                : "Create a child to run Paseo with Pi on a fixed microVM."}
            </Text>
            {data?.inventory.status === "unavailable" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry loading child VMs"
                onPress={onRetry}
                style={styles.retry}
              >
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Row({
  name,
  status,
  error,
  tone,
  selected,
  theme,
  styles,
  onSelect,
}: {
  name: string;
  status: string;
  error: string | null;
  tone: Tone;
  selected: boolean;
  theme: PluginTheme;
  styles: ReturnType<typeof StyleSheet.create>;
  onSelect(name: string): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${name}`}
      accessibilityState={{ selected }}
      onPress={() => onSelect(name)}
      style={[
        styles.row,
        selected
          ? {
              borderColor: theme.colors.accent,
              backgroundColor: theme.colors.surface2,
            }
          : null,
      ]}
    >
      <View style={[styles.dot, { backgroundColor: toneColor(theme, tone) }]} />
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={styles.name}>
          {name}
        </Text>
        <Text style={styles.status}>{status}</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}
