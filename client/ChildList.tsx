import { Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import type { VmChild, VmListResult } from "../shared/contracts";
import {
  childErrorText,
  childPhase,
  childTone,
  inventoryNotice,
  isEmptyInventory,
  phaseText,
  registrationText,
  registrationTone,
  registrationsNotice,
  runtimeText,
} from "./state";
import { ActionButton, Notice, StatusPill, type PluginTheme } from "./ui";

export interface ChildListProps {
  data: VmListResult | null;
  error: string | null;
  loading: boolean;
  selectedName: string | null;
  theme: PluginTheme;
  compact: boolean;
  onSelect(name: string): void;
  onRetry(): void;
}

export function ChildList({
  data,
  error,
  loading,
  selectedName,
  theme,
  compact,
  onSelect,
  onRetry,
}: ChildListProps) {
  if (!data && loading) {
    return (
      <View style={{ flex: 1, minHeight: compact ? 240 : 0 }}>
        <Loading />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ gap: 8, paddingBottom: 16 }}
    >
      {error ? (
        <View style={{ gap: 8 }}>
          <Notice text={error} tone="danger" theme={theme} />
          <ActionButton label="Retry" theme={theme} onPress={onRetry} compact />
        </View>
      ) : null}

      {data ? <ListNotices data={data} theme={theme} /> : null}

      {data && isEmptyInventory(data) ? (
        <View style={{ gap: 4, paddingVertical: 24, alignItems: "center" }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
            No child VMs yet
          </Text>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              textAlign: "center",
            }}
          >
            Create one to install Pi and register it as a Paseo host.
          </Text>
        </View>
      ) : null}

      {data?.children.map((child) => (
        <ChildRow
          key={child.name}
          child={child}
          selected={child.name === selectedName}
          theme={theme}
          onSelect={() => onSelect(child.name)}
        />
      ))}
    </ScrollView>
  );
}

function ListNotices({ data, theme }: { data: VmListResult; theme: PluginTheme }) {
  const notices = [inventoryNotice(data.inventory), registrationsNotice(data.registrations)].filter(
    (notice): notice is string => notice !== null,
  );

  if (notices.length === 0) return null;

  return (
    <View style={{ gap: 6 }}>
      {notices.map((notice) => (
        <Notice key={notice} text={notice} theme={theme} />
      ))}
    </View>
  );
}

function ChildRow({
  child,
  selected,
  theme,
  onSelect,
}: {
  child: VmChild;
  selected: boolean;
  theme: PluginTheme;
  onSelect(): void;
}) {
  const error = childErrorText(child);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={child.name}
      accessibilityState={{ selected }}
      onPress={onSelect}
      style={({ pressed }) => ({
        backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        gap: 6,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foreground,
            fontSize: 13,
            fontWeight: "600",
            flexShrink: 1,
          }}
        >
          {child.name}
        </Text>
        <StatusPill
          label={phaseText(childPhase(child))}
          tone={childTone(child)}
          theme={theme}
        />
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {child.kind === "sandbox" ? (
          <>
            <StatusPill label={runtimeText(child.runtimeStatus)} tone="muted" theme={theme} />
            <StatusPill
              label={registrationText(child.registration)}
              tone={registrationTone(child.registration)}
              theme={theme}
            />
          </>
        ) : child.kind === "registration" ? (
          <>
            <StatusPill label="Registration only" tone="warning" theme={theme} />
            <StatusPill
              label={registrationText(child.registration)}
              tone={registrationTone(child.registration)}
              theme={theme}
            />
          </>
        ) : (
          <StatusPill label="Pending create" tone="accent" theme={theme} />
        )}
      </View>

      {error ? (
        <Text
          numberOfLines={3}
          style={{ color: theme.colors.statusDanger, fontSize: 11 }}
        >
          {error}
        </Text>
      ) : null}
    </Pressable>
  );
}
