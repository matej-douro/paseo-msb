import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { memo, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type PointerEvent,
} from "react-native";
import type { LogBundle, MetricsSample } from "../shared/contracts";
import {
  METRICS_HISTORY_LIMIT,
  metricsChart,
  metricsChartAccessibility,
  metricsChartLegend,
  metricsGridlineTop,
  metricsIndexByTimestamp,
  metricsPointIndexAt,
  metricsPointX,
  metricsTooltip,
  rootDiskUsage,
  rootDiskUsageText,
  type MetricsChartLine,
  type MetricsChartPoint,
  type MetricsHistoryPoint,
  type MetricsTooltip,
} from "./metrics";
import {
  logBundleSummary,
  logLineCountLabel,
  logTimestamp,
  resourceSliderOffset,
  resourceSliderValue,
  snapResourceValue,
  type ResourceFieldBounds,
  type Tone,
} from "./state";

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

export interface ResourceSliderProps {
  label: string;
  value: number;
  bounds: ResourceFieldBounds;
  unit?: string;
  hint?: string;
  theme: PluginTheme;
  disabled?: boolean;
  onChange(value: number): void;
}

const SLIDER_TRACK_HEIGHT = 6;
const SLIDER_THUMB_SIZE = 16;

/**
 * A bounded, step-snapping slider. It is the only way to set a resource value,
 * so every emitted value already lies on the shared step grid. Dragging and
 * tapping both use page coordinates measured from the track, which keeps the
 * hot path clear of per-render closures that could re-create the responder
 * mid-gesture.
 */
export function ResourceSlider({
  label,
  value,
  bounds,
  unit,
  hint,
  theme,
  disabled = false,
  onChange,
}: ResourceSliderProps) {
  const displayUnit = unit ?? bounds.unit;
  const [width, setWidth] = useState(0);
  const trackRef = useRef<View>(null);
  const widthRef = useRef(0);
  const leftRef = useRef(0);
  const valueRef = useRef(value);
  const boundsRef = useRef(bounds);
  const disabledRef = useRef(disabled);
  const onChangeRef = useRef(onChange);
  valueRef.current = value;
  boundsRef.current = bounds;
  disabledRef.current = disabled;
  onChangeRef.current = onChange;

  const commitRef = useRef<(offset: number) => void>(() => {});
  commitRef.current = (offset) => {
    const next = resourceSliderValue(offset, boundsRef.current);
    if (next !== valueRef.current) onChangeRef.current(next);
  };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabledRef.current,
        onMoveShouldSetPanResponder: () => !disabledRef.current,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event) => {
          if (widthRef.current <= 0) return;
          commitRef.current((event.nativeEvent.pageX - leftRef.current) / widthRef.current);
        },
        onPanResponderMove: (event) => {
          if (widthRef.current <= 0) return;
          commitRef.current((event.nativeEvent.pageX - leftRef.current) / widthRef.current);
        },
      }),
    [],
  );

  const handleLayout = (event: LayoutChangeEvent) => {
    const layout = event.nativeEvent.layout;
    widthRef.current = layout.width;
    setWidth(layout.width);
    trackRef.current?.measureInWindow((x) => {
      leftRef.current = x;
    });
  };

  const resolved = snapResourceValue(value, bounds);
  const offset = resourceSliderOffset(resolved, bounds);
  const fillWidth = Math.max(0, Math.min(width, width * offset));
  const thumbLeft = Math.max(
    0,
    Math.min(
      Math.max(0, width - SLIDER_THUMB_SIZE),
      fillWidth - SLIDER_THUMB_SIZE / 2,
    ),
  );

  const adjust = (delta: number) => {
    if (disabled) return;
    onChangeRef.current(snapResourceValue(valueRef.current + delta, boundsRef.current));
  };

  return (
    <View style={{ gap: 4, opacity: disabled ? 0.5 : 1 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
          {label}
        </Text>
        <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
          {`${resolved} ${displayUnit}`}
        </Text>
      </View>

      <View
        ref={trackRef}
        onLayout={handleLayout}
        {...pan.panHandlers}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min: bounds.min, max: bounds.max, now: resolved }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => {
          const action = event.nativeEvent.actionName;
          if (action === "increment") adjust(bounds.step);
          if (action === "decrement") adjust(-bounds.step);
        }}
        style={{ height: 24, justifyContent: "center" }}
      >
        <View
          pointerEvents="none"
          style={{
            height: SLIDER_TRACK_HEIGHT,
            borderRadius: SLIDER_TRACK_HEIGHT / 2,
            backgroundColor: theme.colors.surface2,
            borderColor: theme.colors.border,
            borderWidth: 1,
          }}
        />
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            height: SLIDER_TRACK_HEIGHT,
            width: fillWidth,
            borderRadius: SLIDER_TRACK_HEIGHT / 2,
            backgroundColor: theme.colors.accent,
          }}
        />
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: thumbLeft,
            width: SLIDER_THUMB_SIZE,
            height: SLIDER_THUMB_SIZE,
            borderRadius: SLIDER_THUMB_SIZE / 2,
            backgroundColor: theme.colors.accent,
            borderColor: theme.colors.surface0,
            borderWidth: 2,
          }}
        />
      </View>

      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
          {`${bounds.min} ${displayUnit}`}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
          {`${bounds.max} ${displayUnit}`}
        </Text>
      </View>

      {hint ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{hint}</Text>
      ) : null}
    </View>
  );
}

const METRICS_CHART_HEIGHT = 72;
const METRICS_CHART_HEIGHT_COMPACT = 56;

export interface MetricsChartProps {
  points: readonly MetricsHistoryPoint[];
  theme: PluginTheme;
  compact?: boolean;
}

/**
 * A bounded rolling line chart over samples already received. Every live
 * series shares one graph; each family keeps its own scale so unlike units are
 * never added together. Hovering selects the nearest sample for the tooltip;
 * when the pointer leaves, the chart returns to the latest sample. The same
 * reading is exposed through the accessibility value and stepping actions.
 */
export function MetricsChart({ points, theme, compact = false }: MetricsChartProps) {
  const chartHeight = compact ? METRICS_CHART_HEIGHT_COMPACT : METRICS_CHART_HEIGHT;
  const plotHeight = Math.max(0, chartHeight - 2);
  const [width, setWidth] = useState(0);
  const [selectedTimestamp, setSelectedTimestamp] = useState<string | null>(null);

  const selectedIndex =
    selectedTimestamp === null
      ? null
      : metricsIndexByTimestamp(points, selectedTimestamp);
  const accessibility = metricsChartAccessibility(points, selectedIndex);
  const model = useMemo(
    () => metricsChart(points, width, plotHeight, METRICS_HISTORY_LIMIT),
    [points, width, plotHeight],
  );
  const legend = useMemo(() => metricsChartLegend(model), [model]);

  const handleLayout = (event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  };

  const selectPointer = (event: PointerEvent) => {
    if (width <= 0 || points.length === 0) return;
    const index = metricsPointIndexAt(
      points,
      event.nativeEvent.offsetX,
      width,
      METRICS_HISTORY_LIMIT,
    );
    if (index !== null) setSelectedTimestamp(points[index].sample.timestamp);
  };

  const stepSelection = (delta: number) => {
    if (points.length === 0) return;
    const from = selectedIndex ?? points.length - 1;
    const next = Math.min(points.length - 1, Math.max(0, from + delta));
    setSelectedTimestamp(points[next].sample.timestamp);
  };

  const clearSelection = () => {
    setSelectedTimestamp(null);
  };

  // Touch has no hover-out; keep the last touch sample instead of clearing it.
  const clearOnLeave = (event: PointerEvent) => {
    if (event.nativeEvent.pointerType !== "touch") clearSelection();
  };

  if (points.length === 0) return null;

  const displayIndex = selectedIndex ?? points.length - 1;
  const markerX = metricsPointX(
    points,
    displayIndex,
    width,
    METRICS_HISTORY_LIMIT,
  );
  const tooltip = metricsTooltip(points[displayIndex]);

  return (
    <View style={{ gap: 6 }}>
      <View
        onLayout={handleLayout}
        onPointerEnter={selectPointer}
        onPointerMove={selectPointer}
        onPointerLeave={clearOnLeave}
        onPointerCancel={clearSelection}
        accessible
        focusable
        accessibilityRole="adjustable"
        accessibilityLabel={accessibility.label}
        accessibilityValue={{ text: accessibility.value }}
        accessibilityActions={[
          { name: "increment", label: "Next sample" },
          { name: "decrement", label: "Previous sample" },
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "increment") stepSelection(1);
          if (event.nativeEvent.actionName === "decrement") stepSelection(-1);
        }}
        style={{
          height: chartHeight,
          borderRadius: 4,
          overflow: "hidden",
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
          borderWidth: 1,
        }}
      >
          {[0.25, 0.5, 0.75].map((ratio) => (
            <View
              key={ratio}
              pointerEvents="none"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: Math.round(metricsGridlineTop(ratio, plotHeight)),
                height: 1,
                backgroundColor: theme.colors.border,
                opacity: 0.4,
              }}
            />
          ))}
          {model.lines.map((line) => (
            <MetricsLineView
              key={`${line.series}:${line.points[0].x}`}
              line={line}
            />
          ))}
          {markerX !== null ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: markerX - 0.5,
                top: 0,
                bottom: 0,
                width: 1,
                backgroundColor: theme.colors.foregroundMuted,
                opacity: 0.7,
              }}
            />
          ) : null}
        </View>

      {legend.length > 0 ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            columnGap: 10,
            rowGap: 4,
          }}
        >
          {legend.map((item) => (
            <View
              key={item.series}
              style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
            >
              <View
                style={{
                  width: 12,
                  height: 3,
                  borderRadius: 1.5,
                  backgroundColor: item.color,
                }}
              />
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>
                {item.label}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      <MetricsTooltipView tooltip={tooltip} theme={theme} />
    </View>
  );
}

const MetricsLineView = memo(function MetricsLineView({
  line,
}: {
  line: MetricsChartLine;
}) {
  const color = line.color;
  const thickness = 2.5;
  const lastPoint = line.points[line.points.length - 1];
  const dotSize = line.points.length === 1 ? 5 : 3;

  return (
    <>
      {line.points.map((point, index) => {
        if (index === 0) return null;
        const previous = line.points[index - 1];
        return (
          <MetricsLineSegment
            key={`${previous.x}:${previous.y}-${point.x}:${point.y}`}
            from={previous}
            to={point}
            color={color}
            thickness={thickness}
          />
        );
      })}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: lastPoint.x - dotSize / 2,
          top: lastPoint.y - dotSize / 2,
          width: dotSize,
          height: dotSize,
          borderRadius: dotSize / 2,
          backgroundColor: color,
        }}
      />
    </>
  );
});

function MetricsLineSegment({
  from,
  to,
  color,
  thickness,
}: {
  from: MetricsChartPoint;
  to: MetricsChartPoint;
  color: string;
  thickness: number;
}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return null;

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: (from.x + to.x) / 2 - length / 2,
        top: (from.y + to.y) / 2 - thickness / 2,
        width: length,
        height: thickness,
        borderRadius: thickness / 2,
        backgroundColor: color,
        transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
      }}
    />
  );
}

function MetricsTooltipView({
  tooltip,
  theme,
}: {
  tooltip: MetricsTooltip;
  theme: PluginTheme;
}) {
  return (
    <View
      style={{
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 6,
        paddingVertical: 6,
        paddingHorizontal: 8,
        gap: 2,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text
        style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}
      >
        {`${tooltip.clock} UTC`}
      </Text>
      <View style={{ gap: 4 }}>
        {tooltip.rows.map((row) => (
          <View
            key={row.label}
            style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}
          >
            <Text
              style={{
                width: 70,
                color: theme.colors.foregroundMuted,
                fontSize: 10,
              }}
            >
              {row.label}
            </Text>
            <Text
              style={{
                flex: 1,
                flexShrink: 1,
                color: theme.colors.foreground,
                fontSize: 11,
                fontWeight: "600",
              }}
            >
              {row.value}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export interface RootDiskBarProps {
  sample: MetricsSample;
  theme: PluginTheme;
}

/**
 * Current writable upper-layer usage with a text value and a progressbar role.
 * Hidden when either side is unreported or the total is non-positive.
 */
export function RootDiskBar({ sample, theme }: RootDiskBarProps) {
  const usage = rootDiskUsage(sample);
  if (!usage) return null;

  const tone: Tone =
    usage.percent >= 90 ? "danger" : usage.percent >= 75 ? "warning" : "accent";
  const percent = Math.min(100, Math.max(0, usage.percent));
  const text = rootDiskUsageText(usage);

  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
          Root disk
        </Text>
        <Text style={{ color: theme.colors.foreground, fontSize: 10 }}>{text}</Text>
      </View>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Root disk usage"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(percent), text }}
        style={{
          height: 8,
          borderRadius: 4,
          overflow: "hidden",
          backgroundColor: theme.colors.surface2,
        }}
      >
        <View
          style={{
            height: 8,
            width: `${percent}%`,
            backgroundColor: toneColor(theme, tone),
          }}
        />
      </View>
    </View>
  );
}
