import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";

export function MsbScreen({ theme, layout }: PluginScreenProps) {
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      text: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 16 : 18,
      },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.text}>Paseo MSB management is not implemented in this task.</Text>
    </View>
  );
}
