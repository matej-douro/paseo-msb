import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { Tone } from "./state";

export type PluginTheme = PluginHostProps["theme"];

const TONE_COLORS: Record<Tone, keyof PluginTheme["colors"]> = {
  success: "statusSuccess",
  warning: "statusWarning",
  danger: "statusDanger",
  muted: "foregroundMuted",
  accent: "accent",
};

export function toneColor(theme: PluginTheme, tone: Tone): string {
  return theme.colors[TONE_COLORS[tone]];
}

export interface ActionButtonProps {
  label: string;
  onPress(): void;
  theme: PluginTheme;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  compact?: boolean;
}

/** The only button surface in this screen; theme colors only. */
export function ActionButton({
  label,
  onPress,
  theme,
  variant = "secondary",
  disabled = false,
  compact = false,
}: ActionButtonProps) {
  const styles = useMemo(() => {
    const background =
      variant === "primary"
        ? theme.colors.accent
        : variant === "danger"
          ? theme.colors.statusDanger
          : theme.colors.surface2;
    const color =
      variant === "secondary" ? theme.colors.foreground : theme.colors.accentForeground;

    return {
      button: {
        backgroundColor: background,
        borderColor: variant === "secondary" ? theme.colors.border : background,
        borderWidth: 1,
        borderRadius: 8,
        paddingVertical: compact ? 6 : 8,
        paddingHorizontal: compact ? 10 : 14,
        opacity: disabled ? 0.45 : 1,
      },
      pressed: { opacity: disabled ? 0.45 : 0.75 },
      label: {
        color,
        fontSize: compact ? 12 : 13,
        fontWeight: "600" as const,
      },
    };
  }, [theme, variant, disabled, compact]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

export interface StatusPillProps {
  label: string;
  tone: Tone;
  theme: PluginTheme;
}

export function StatusPill({ label, tone, theme }: StatusPillProps) {
  const color = toneColor(theme, tone);

  return (
    <View
      style={{
        borderColor: color,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 2,
        alignSelf: "flex-start",
      }}
    >
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export interface NoticeProps {
  text: string;
  theme: PluginTheme;
  tone?: Tone;
}

export function Notice({ text, theme, tone = "warning" }: NoticeProps) {
  const color = toneColor(theme, tone);

  return (
    <View
      style={{
        borderLeftColor: color,
        borderLeftWidth: 3,
        backgroundColor: theme.colors.surface1,
        borderRadius: 6,
        paddingVertical: 8,
        paddingHorizontal: 10,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{text}</Text>
    </View>
  );
}
