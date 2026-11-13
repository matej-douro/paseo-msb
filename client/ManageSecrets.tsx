import { Loading, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { CredentialName } from "../shared/constants";
import type { SecretsListResult } from "../shared/contracts";
import { errorMessage, secretSource } from "./state";
import { ActionButton, Notice, StatusPill, type PluginTheme } from "./ui";

export interface ManageSecretsProps {
  open: boolean;
  data: SecretsListResult | null;
  loading: boolean;
  error: string | null;
  theme: PluginTheme;
  compact: boolean;
  onOpenChange(open: boolean): void;
  onRefresh(): void;
  onSet(name: CredentialName, value: string): Promise<void>;
  onDelete(name: CredentialName): Promise<void>;
}

/**
 * Shared credential store for new VMs. The five fixed names stay the only
 * allowed values; stored values override the parent environment for create and
 * are never rendered back.
 */
export function ManageSecrets({
  open,
  data,
  loading,
  error,
  theme,
  compact,
  onOpenChange,
  onRefresh,
  onSet,
  onDelete,
}: ManageSecretsProps) {
  const [drafts, setDrafts] = useState<Partial<Record<CredentialName, string>>>({});
  const [pending, setPending] = useState<CredentialName | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDrafts({});
    setActionError(null);
    onRefresh();
  }, [open, onRefresh]);

  const save = async (name: CredentialName) => {
    const value = (drafts[name] ?? "").trim();
    if (!value || pending) return;

    setPending(name);
    setActionError(null);
    try {
      await onSet(name, value);
      setDrafts((current) => ({ ...current, [name]: "" }));
    } catch (saveError) {
      setActionError(errorMessage(saveError));
    } finally {
      setPending(null);
    }
  };

  const remove = async (name: CredentialName) => {
    if (pending) return;

    setPending(name);
    setActionError(null);
    try {
      await onDelete(name);
      setDrafts((current) => ({ ...current, [name]: "" }));
    } catch (deleteError) {
      setActionError(errorMessage(deleteError));
    } finally {
      setPending(null);
    }
  };

  return (
    <Modal title="Credentials" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Values are stored once in the plugin and offered to new VMs by name. Stored values
          override the parent environment. They are never returned to this screen.
        </Text>

        {loading && !data ? <Loading /> : null}

        {error ? (
          <View style={{ gap: 8 }}>
            <Notice text={error} tone="danger" theme={theme} />
            <ActionButton label="Retry" theme={theme} onPress={onRefresh} compact />
          </View>
        ) : null}

        {actionError ? <Notice text={actionError} tone="danger" theme={theme} /> : null}

        {data ? (
          <View style={{ gap: 10 }}>
            {data.secrets.map((entry) => {
              const source = secretSource(entry);
              const draft = drafts[entry.name] ?? "";
              const busy = pending === entry.name;

              return (
                <View
                  key={entry.name}
                  style={{
                    backgroundColor: theme.colors.surface1,
                    borderColor: theme.colors.border,
                    borderWidth: 1,
                    borderRadius: 8,
                    padding: 10,
                    gap: 8,
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <Text
                      style={{
                        color: theme.colors.foreground,
                        fontSize: 12,
                        fontWeight: "600",
                        flexShrink: 1,
                      }}
                    >
                      {entry.name}
                    </Text>
                    <StatusPill label={source.label} tone={source.tone} theme={theme} />
                  </View>

                  <View
                    style={{
                      flexDirection: compact ? "column" : "row",
                      alignItems: compact ? "stretch" : "center",
                      gap: 8,
                    }}
                  >
                    <TextInput
                      value={draft}
                      onChangeText={(text) =>
                        setDrafts((current) => ({ ...current, [entry.name]: text }))
                      }
                      placeholder={entry.stored ? "Replace stored value" : "Paste value"}
                      placeholderTextColor={theme.colors.foregroundMuted}
                      secureTextEntry
                      autoCapitalize="none"
                      autoCorrect={false}
                      editable={!busy}
                      onSubmitEditing={() => void save(entry.name)}
                      style={{
                        flex: 1,
                        color: theme.colors.foreground,
                        backgroundColor: theme.colors.surface2,
                        borderColor: theme.colors.border,
                        borderWidth: 1,
                        borderRadius: 6,
                        paddingVertical: 6,
                        paddingHorizontal: 8,
                        fontSize: 12,
                      }}
                    />
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <ActionButton
                        label={busy ? "Saving…" : "Save"}
                        theme={theme}
                        variant="primary"
                        onPress={() => void save(entry.name)}
                        disabled={busy || draft.trim().length === 0}
                        compact
                      />
                      {entry.stored ? (
                        <ActionButton
                          label="Remove"
                          theme={theme}
                          variant="danger"
                          onPress={() => void remove(entry.name)}
                          disabled={busy}
                          compact
                        />
                      ) : null}
                    </View>
                  </View>
                </View>
              );
            })}

          </View>
        ) : null}

        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <ActionButton label="Close" theme={theme} onPress={() => onOpenChange(false)} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
