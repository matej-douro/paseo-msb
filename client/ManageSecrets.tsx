import { Loading, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { CredentialName } from "../shared/constants";
import type { SecretEntry, SecretsListResult } from "../shared/contracts";
import { errorMessage } from "./state";
import { ActionButton, IconButton, Notice, type PluginTheme } from "./ui";

/** A stored value is never returned; a fixed dot run stands in for it. */
const STORED_PLACEHOLDER = "••••••••";

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
 * Shared credential store for new VMs. The fixed names stay the only allowed
 * values; stored values override the parent environment for create and are
 * never rendered back.
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
          override the parent environment.
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
          <View
            style={{
              borderColor: theme.colors.border,
              borderWidth: 1,
              borderRadius: 8,
            }}
          >
            {data.secrets.map((entry, index) => (
              <SecretRow
                key={entry.name}
                entry={entry}
                draft={drafts[entry.name] ?? ""}
                busy={pending === entry.name}
                last={index === data.secrets.length - 1}
                theme={theme}
                compact={compact}
                onChangeText={(text) =>
                  setDrafts((current) => ({ ...current, [entry.name]: text }))
                }
                onSave={() => void save(entry.name)}
                onRemove={() => void remove(entry.name)}
              />
            ))}
          </View>
        ) : null}

        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <ActionButton label="Close" theme={theme} onPress={() => onOpenChange(false)} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

function SecretRow({
  entry,
  draft,
  busy,
  last,
  theme,
  compact,
  onChangeText,
  onSave,
  onRemove,
}: {
  entry: SecretEntry;
  draft: string;
  busy: boolean;
  last: boolean;
  theme: PluginTheme;
  compact: boolean;
  onChangeText(text: string): void;
  onSave(): void;
  onRemove(): void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 8,
        paddingHorizontal: compact ? 8 : 10,
        borderBottomColor: theme.colors.border,
        borderBottomWidth: last ? 0 : 1,
      }}
    >
      <Text
        style={{
          flex: 1,
          color: theme.colors.foreground,
          fontSize: 11,
          fontWeight: "600",
        }}
      >
        {entry.name}
      </Text>

      {/* The field is the cell: its actions live inside the same border. */}
      <View
        style={{
          flex: 1.6,
          minHeight: 28,
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 6,
          paddingLeft: 8,
          paddingRight: 2,
        }}
      >
        <TextInput
          value={draft}
          onChangeText={onChangeText}
          placeholder={entry.stored ? STORED_PLACEHOLDER : "Paste value"}
          placeholderTextColor={theme.colors.foregroundMuted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          onSubmitEditing={onSave}
          style={{
            flex: 1,
            color: theme.colors.foreground,
            fontSize: 11,
            paddingVertical: 5,
          }}
        />
        <IconButton
          icon="Check"
          label={busy ? "Saving…" : `Save ${entry.name}`}
          theme={theme}
          variant="ghost"
          tone="accent"
          size={22}
          onPress={onSave}
          disabled={busy || draft.trim().length === 0}
        />
        {entry.stored ? (
          <IconButton
            icon="Trash2"
            label={busy ? "Removing…" : `Remove stored ${entry.name}`}
            theme={theme}
            variant="ghost"
            tone="danger"
            size={22}
            onPress={onRemove}
            disabled={busy}
          />
        ) : null}
      </View>
    </View>
  );
}
