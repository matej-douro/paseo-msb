import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";

/**
 * Placeholder screen for task 2. Task 5 replaces it with the single
 * create/list/detail management surface.
 */
export function MainScreen({ theme, layout }: PluginScreenProps) {
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        gap: layout.compact ? 8 : 12,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 20 : 24,
        fontWeight: "600" as const,
      },
      detail: {
        color: theme.colors.foregroundMuted,
      },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Paseo microVM hosts</Text>
      <Text style={styles.detail}>
        The management screen is being built in a later task.
      </Text>
    </View>
  );
}
