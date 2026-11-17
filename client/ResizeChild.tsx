import { Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { ROOT_DISK_MIB, type RuntimeStatus } from "../shared/constants";
import type {
  VmObservedResources,
  VmResizeInput,
  VmResizeResult,
  VmResources,
} from "../shared/contracts";
import {
  MEMORY_FIELD_BOUNDS,
  errorMessage,
  resizeChangeLines,
  resizeDiskBounds,
  resizeFeedback,
  resizeRequestInput,
  resizeRestartIssue,
  resizeTargetFor,
  resizeTargetIssue,
  restartConfirmationText,
  type ResizeFeedback,
  type ResizeTarget,
  type ResourceLine,
} from "./state";
import { ActionButton, Notice, ResourceSlider, TextField, type PluginTheme } from "./ui";

export interface ResizeChildProps {
  open: boolean;
  name: string;
  id: string;
  observed: VmObservedResources;
  requestedResources: VmResources | null;
  runtimeStatus: RuntimeStatus;
  theme: PluginTheme;
  compact: boolean;
  onOpenChange(open: boolean): void;
  onResize(input: VmResizeInput): Promise<VmResizeResult>;
}

/**
 * The only resource editor. RAM and a grow-only root disk are set with bounded
 * sliders; a `restart_required` result opens a second, explicit confirmation
 * before the restart-and-apply call. The dialog never starts a stopped VM.
 */
export function ResizeChild({
  open,
  name,
  id,
  observed,
  requestedResources,
  runtimeStatus,
  theme,
  compact,
  onOpenChange,
  onResize,
}: ResizeChildProps) {
  const toast = useToast();
  const [memoryMib, setMemoryMib] = useState(MEMORY_FIELD_BOUNDS.min);
  const [diskMib, setDiskMib] = useState(ROOT_DISK_MIB);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ResizeFeedback | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const wasOpen = useRef(false);

  // Initialize on the closed-to-open edge only. Polling refreshes `observed`
  // while the dialog is open, and that must not move the user's sliders.
  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;

    const target = resizeTargetFor(observed, requestedResources);
    setMemoryMib(target.memoryMib ?? MEMORY_FIELD_BOUNDS.min);
    setDiskMib(target.diskMib ?? resizeDiskBounds(observed).min);
    setPending(false);
    setError(null);
    setFeedback(null);
    setConfirmRestart(false);
  }, [open, observed, requestedResources]);

  const memoryDisabled = observed.memoryMib === null;
  const diskDisabled = observed.diskMib === null;
  const diskBounds = resizeDiskBounds(observed);
  const target: ResizeTarget = {
    memoryMib: memoryDisabled ? null : memoryMib,
    diskMib: diskDisabled ? null : diskMib,
  };
  const targetIssue = resizeTargetIssue(target, observed);
  const restartIssue = resizeRestartIssue(runtimeStatus);

  const apply = async (restart: boolean) => {
    if (pending) return;
    const issue = resizeTargetIssue(target, observed);
    if (issue) {
      setError(issue);
      return;
    }

    setPending(true);
    setError(null);

    try {
      const result = await onResize(resizeRequestInput(name, id, target, restart));
      const next = resizeFeedback(result);

      if (next.offersRestart && restartIssue === null) {
        setFeedback(next);
        setConfirmRestart(true);
      } else if (next.offersRestart && restartIssue !== null) {
        // The runtime needs a restart, but this VM cannot be restarted here.
        setFeedback({ ...next, text: `${next.text} ${restartIssue}` });
        setConfirmRestart(false);
      } else {
        setFeedback(next);
        setConfirmRestart(false);
        if (result.result === "applied") {
          toast.show(next.text, { variant: "success" });
        } else if (result.result === "resize_failed") {
          toast.error(next.text);
        }
      }
    } catch (resizeError) {
      setError(errorMessage(resizeError));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal title="Edit resources" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        {confirmRestart ? (
          <RestartConfirmation
            name={name}
            observed={observed}
            target={target}
            theme={theme}
            pending={pending}
            error={error}
            onCancel={() => {
              setConfirmRestart(false);
              setError(null);
            }}
            onConfirm={() => void apply(true)}
          />
        ) : (
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: compact ? "column" : "row", gap: 16 }}>
              <View style={{ flex: compact ? undefined : 1, minWidth: 0, gap: 4 }}>
                <ResourceSlider
                  label="RAM"
                  value={memoryMib}
                  bounds={MEMORY_FIELD_BOUNDS}
                  theme={theme}
                  disabled={memoryDisabled || pending}
                  onChange={setMemoryMib}
                />
                {memoryDisabled ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                    RAM is unreported for this VM. Repair must report its effective value before RAM
                    can be changed.
                  </Text>
                ) : null}
              </View>

              <View style={{ flex: compact ? undefined : 1, minWidth: 0, gap: 4 }}>
                <ResourceSlider
                  label="Root disk"
                  value={diskMib}
                  bounds={diskBounds}
                  theme={theme}
                  disabled={diskDisabled || pending}
                  onChange={setDiskMib}
                />
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                  {diskDisabled
                    ? "The root disk size is unreported, so it cannot be changed."
                    : "The root disk can only grow."}
                </Text>
              </View>

              <View style={{ width: compact ? undefined : 64, minWidth: 0 }}>
                <TextField
                  label="CPUs"
                  value={String(observed.cpus)}
                  error={null}
                  theme={theme}
                  editable={false}
                />
              </View>
            </View>

            {targetIssue ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                {targetIssue}
              </Text>
            ) : null}

            {feedback ? <Notice text={feedback.text} tone={feedback.tone} theme={theme} /> : null}

            {error ? (
              <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text>
            ) : null}

            <View
              style={{
                flexDirection: "row",
                justifyContent: compact ? "space-between" : "flex-end",
                gap: 8,
              }}
            >
              <View style={{ flex: compact ? 1 : undefined }}>
                <ActionButton
                  label="Cancel"
                  theme={theme}
                  onPress={() => onOpenChange(false)}
                  disabled={pending}
                />
              </View>
              <View style={{ flex: compact ? 1 : undefined }}>
                <ActionButton
                  label={pending ? "Applying…" : "Apply"}
                  theme={theme}
                  variant="primary"
                  onPress={() => void apply(false)}
                  disabled={pending || targetIssue !== null}
                />
              </View>
            </View>
          </View>
        )}
      </Modal.Content>
    </Modal>
  );
}

function RestartConfirmation({
  name,
  observed,
  target,
  theme,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  name: string;
  observed: VmObservedResources;
  target: ResizeTarget;
  theme: PluginTheme;
  pending: boolean;
  error: string | null;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
        {`Restart and apply resources for ${name}?`}
      </Text>

      <View style={{ gap: 6 }}>
        {resizeChangeLines(observed, target).map((line) => (
          <ResourceLineRow key={line.label} line={line} theme={theme} />
        ))}
      </View>

      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {restartConfirmationText(name)}
      </Text>

      {error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text>
      ) : null}

      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        <ActionButton label="Cancel" theme={theme} onPress={onCancel} disabled={pending} />
        <ActionButton
          label={pending ? "Restarting…" : "Restart and apply"}
          theme={theme}
          variant="danger"
          onPress={onConfirm}
          disabled={pending}
        />
      </View>
    </View>
  );
}

function ResourceLineRow({ line, theme }: { line: ResourceLine; theme: PluginTheme }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{line.label}</Text>
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{line.value}</Text>
    </View>
  );
}
