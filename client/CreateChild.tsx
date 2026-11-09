import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { FIXED_RESOURCES, IMAGE } from "../shared/constants";
import type { CredentialName } from "./types";
import { canCreate, toggleCredential } from "./create";

export interface CreateChildInput {
  requestId: string;
  secretEnvVars: CredentialName[];
}

export interface CreateChildProps {
  open: boolean;
  requestId: string;
  credentials: readonly CredentialName[];
  theme: PluginTheme;
  onOpenChange(open: boolean): void;
  onSubmit(input: CreateChildInput): Promise<void>;
}

export function CreateChild({
  open,
  requestId,
  credentials,
  theme,
  onOpenChange,
  onSubmit,
}: CreateChildProps) {
  const [selected, setSelected] = useState<CredentialName[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setError(null);
  }, [open]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        body: { backgroundColor: theme.colors.surface1 },
        intro: { color: theme.colors.foreground, fontSize: 15, lineHeight: 21 },
        card: {
          gap: 8,
          padding: 14,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 10,
          backgroundColor: theme.colors.surface0,
        },
        label: {
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.6,
        },
        value: { color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
        section: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" },
        hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
        credential: {
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: 44,
          paddingHorizontal: 12,
          borderWidth: 1,
          borderRadius: 10,
        },
        checkbox: {
          width: 18,
          height: 18,
          borderRadius: 4,
          borderWidth: 1,
          alignItems: "center",
          justifyContent: "center",
        },
        checkmark: {
          color: theme.colors.accentForeground,
          fontSize: 12,
          lineHeight: 16,
        },
        credentialName: { color: theme.colors.foreground, fontSize: 13 },
        warning: { color: theme.colors.statusWarning, fontSize: 12 },
        error: { color: theme.colors.statusDanger, fontSize: 12 },
        empty: {
          color: theme.colors.foregroundMuted,
          fontSize: 13,
          lineHeight: 18,
          paddingVertical: 8,
        },
        actions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
        button: {
          minHeight: 40,
          paddingHorizontal: 16,
          borderRadius: 10,
          borderWidth: 1,
          alignItems: "center",
          justifyContent: "center",
        },
        buttonText: { fontSize: 13, fontWeight: "600" },
      }),
    [theme],
  );

  const createDisabled =
    submitting || !canCreate(selected, credentials) || credentials.length === 0;

  function handleOpenChange(next: boolean): void {
    if (!next && submitting) return;
    onOpenChange(next);
  }

  async function submit(): Promise<void> {
    if (!canCreate(selected, credentials)) {
      setError("Select at least one available credential.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({ requestId, secretEnvVars: selected });
    } catch {
      setError("Could not start creation. Retry with the same request.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Create child"
      open={open}
      onOpenChange={handleOpenChange}
    >
      <Modal.Content style={styles.body}>
        <Text style={styles.intro}>
          A fixed child microVM runs Paseo with Pi. The child appears in Paseo's normal host
          picker after setup finishes.
        </Text>

        <View style={styles.card}>
          <Text style={styles.label}>Image</Text>
          <Text selectable style={styles.value}>
            {IMAGE.repository}@{IMAGE.indexDigest}
          </Text>
          <Text style={styles.label}>Resources</Text>
          <Text style={styles.value}>
            {FIXED_RESOURCES.cpus} CPUs · {FIXED_RESOURCES.memoryMiB} MiB memory
          </Text>
        </View>

        <Text style={styles.section}>Pi credentials</Text>
        <Text style={styles.hint}>
          Select one or more credentials available to the parent daemon. Only names are shown.
        </Text>

        {credentials.length === 0 ? (
          <Text style={styles.empty}>
            No supported Pi credentials are set on the parent daemon. Add one and reload the
            plugin.
          </Text>
        ) : (
          credentials.map((name) => {
            const checked = selected.includes(name);
            return (
              <Pressable
                key={name}
                accessibilityRole="checkbox"
                accessibilityLabel={name}
                accessibilityState={{ checked, disabled: submitting }}
                disabled={submitting}
                onPress={() => {
                  setError(null);
                  setSelected((current) =>
                    toggleCredential(current, name, credentials),
                  );
                }}
                style={[
                  styles.credential,
                  {
                    borderColor: checked ? theme.colors.accent : theme.colors.border,
                    backgroundColor: checked
                      ? theme.colors.surface2
                      : theme.colors.surface0,
                  },
                ]}
              >
                <View
                  style={[
                    styles.checkbox,
                    {
                      borderColor: checked
                        ? theme.colors.accent
                        : theme.colors.foregroundMuted,
                      backgroundColor: checked
                        ? theme.colors.accent
                        : "transparent",
                    },
                  ]}
                >
                  {checked ? <Text style={styles.checkmark}>✓</Text> : null}
                </View>
                <Text style={styles.credentialName}>{name}</Text>
              </Pressable>
            );
          })
        )}

        {credentials.length > 0 && selected.length === 0 ? (
          <Text style={styles.warning}>Select at least one credential.</Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel create"
            disabled={submitting}
            onPress={() => handleOpenChange(false)}
            style={[
              styles.button,
              { borderColor: theme.colors.border, opacity: submitting ? 0.5 : 1 },
            ]}
          >
            <Text style={[styles.buttonText, { color: theme.colors.foreground }]}>
              Cancel
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create child"
            accessibilityState={{ disabled: createDisabled }}
            disabled={createDisabled}
            onPress={() => {
              void submit();
            }}
            style={[
              styles.button,
              {
                borderColor: theme.colors.accent,
                backgroundColor: theme.colors.accent,
                opacity: createDisabled ? 0.5 : 1,
              },
            ]}
          >
            <Text
              style={[styles.buttonText, { color: theme.colors.accentForeground }]}
            >
              {submitting ? "Creating…" : "Create child"}
            </Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}
