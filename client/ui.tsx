import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { LogBundle } from "../shared/contracts";
import { logBundleSummary, logLineCountLabel, logTimestamp, type Tone } from "./state";

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

export interface IconButtonProps {
  /** A Lucide icon name. */
  icon: string;
  /** Accessibility label and hover tooltip. */
  label: string;
  onPress(): void;
  theme: PluginTheme;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  /** Icon color for the ghost variant. */
  tone?: Tone;
  /** Explicit icon color; overrides the variant and tone color. */
  iconColor?: string;
  /** Square side in pixels. */
  size?: number;
  disabled?: boolean;
}

/**
 * A square icon button for dense rows. The label appears as a tooltip on hover
 * and stays available to accessibility on platforms without hover.
 */
export function IconButton({
  icon,
  label,
  onPress,
  theme,
  variant = "secondary",
  tone = "accent",
  iconColor,
  size = 26,
  disabled = false,
}: IconButtonProps) {
  const [hovered, setHovered] = useState(false);
  const ghost = variant === "ghost";
  const background = ghost
    ? "transparent"
    : variant === "primary"
      ? theme.colors.accent
      : variant === "danger"
        ? theme.colors.statusDanger
        : theme.colors.surface2;
  const color =
    iconColor ??
    (ghost
      ? toneColor(theme, tone)
      : variant === "secondary"
        ? theme.colors.foreground
        : theme.colors.accentForeground);

  return (
    <View style={{ position: "relative", zIndex: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }) => ({
          width: size,
          height: size,
          borderRadius: 6,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: background,
          borderColor: theme.colors.border,
          borderWidth: variant === "secondary" ? 1 : 0,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        })}
      >
        <Icon name={icon} size={Math.max(12, size - 12)} color={color} />
      </Pressable>

      {hovered && !disabled ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: size + 4,
            right: 0,
            zIndex: 10,
            backgroundColor: theme.colors.surface2,
            borderColor: theme.colors.border,
            borderWidth: 1,
            borderRadius: 6,
            paddingVertical: 3,
            paddingHorizontal: 6,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 10 }}>{label}</Text>
        </View>
      ) : null}
    </View>
  );
}

export interface StatusPillProps {
  label: string;
  tone: Tone;
  theme: PluginTheme;
  /** Tinted background and no outline, instead of the default outlined pill. */
  filled?: boolean;
}

export function StatusPill({ label, tone, theme, filled = false }: StatusPillProps) {
  const color = toneColor(theme, tone);

  return (
    <View
      style={{
        borderColor: color,
        borderWidth: filled ? 0 : 1,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: filled ? 3 : 2,
        alignSelf: "flex-start",
        overflow: "hidden",
      }}
    >
      {/* Theme colors arrive in any format, so tint with an overlay instead of parsing alpha. */}
      {filled ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundColor: color,
            opacity: 0.16,
          }}
        />
      ) : null}
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export interface LogBlockProps {
  title: string;
  bundle: LogBundle;
  theme: PluginTheme;
  /** Setup progress stays readable; a finished child starts collapsed. */
  defaultOpen?: boolean;
}

/**
 * One collapsible log block: header with the line count, monospace body with a
 * separate timestamp column.
 */
export function LogBlock({ title, bundle, theme, defaultOpen = false }: LogBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const showLines = open && bundle.available && bundle.entries.length > 0;

  return (
    <View
      style={{
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title} logs`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingVertical: 8,
          paddingHorizontal: 10,
          backgroundColor: theme.colors.surface1,
          opacity: pressed ? 0.75 : 1,
        })}
      >
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foreground,
            fontSize: 12,
            fontWeight: "600",
            flex: 1,
            flexShrink: 1,
          }}
        >
          {title}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {logLineCountLabel(bundle)}
        </Text>
      </Pressable>

      {open ? (
        <View
          style={{
            backgroundColor: theme.colors.surface1,
            borderTopColor: theme.colors.border,
            borderTopWidth: 1,
            paddingVertical: 8,
            paddingHorizontal: 10,
            gap: 2,
          }}
        >
          {showLines ? (
            bundle.entries.map((entry, index) => (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: entries are append-only, no stable id
                key={`${entry.timestamp}-${index}`}
                style={{ flexDirection: "row", gap: 10 }}
              >
                <Text
                  selectable
                  style={{
                    width: 58,
                    color: theme.colors.foregroundMuted,
                    fontSize: 10,
                    fontFamily: "monospace",
                  }}
                >
                  {logTimestamp(entry.timestamp)}
                </Text>
                <Text
                  selectable
                  style={{
                    flex: 1,
                    flexShrink: 1,
                    color: theme.colors.foreground,
                    fontSize: 11,
                    fontFamily: "monospace",
                  }}
                >
                  {entry.text}
                </Text>
              </View>
            ))
          ) : (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {logBundleSummary(bundle)}
            </Text>
          )}
        </View>
      ) : null}
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
