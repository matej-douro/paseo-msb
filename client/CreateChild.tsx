import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  CPUS,
  GUEST_IMAGE,
  MEMORY_MIB,
  type CredentialName,
} from "../shared/constants";
import type { VmCreateInput } from "../shared/contracts";
import { newRequestId } from "./request-id";
import { canCreate, credentialSourceLabel, errorMessage, toggleCredential } from "./state";
import { ActionButton, StatusPill, type PluginTheme } from "./ui";

export interface CreateChildProps {
  open: boolean;
  credentials: readonly CredentialName[];
  storedCredentials: readonly CredentialName[];
  theme: PluginTheme;
  compact: boolean;
  onOpenChange(open: boolean): void;
  onCreate(input: VmCreateInput): Promise<void>;
}

/**
 * The single create confirmation. Fixed image and resources, credential names
 * only, and one request ID per modal attempt so retries stay idempotent.
 */
export function CreateChild({
  open,
  credentials,
  storedCredentials,
  theme,
  compact,
  onOpenChange,
  onCreate,
}: CreateChildProps) {
  const [selected, setSelected] = useState<CredentialName[]>([]);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableSelection = selected.filter((name) => credentials.includes(name));

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setRequestId(null);
    setPending(false);
    setError(null);
  }, [open]);

  const submit = async () => {
    const chosen = selected.filter((name) => credentials.includes(name));
    if (!canCreate(chosen) || pending) return;

    const id = requestId ?? newRequestId();
    setRequestId(id);
    setPending(true);
    setError(null);

    try {
      await onCreate({ requestId: id, secretEnvVars: chosen });
      setRequestId(null);
      setSelected([]);
      onOpenChange(false);
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal title="Create child" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          One fixed microsandbox child with Pi installed.
        </Text>

        <View style={{ gap: 4 }}>
          <FixedRow theme={theme} label="Image" value={GUEST_IMAGE} />
          <FixedRow theme={theme} label="CPUs" value={String(CPUS)} />
          <FixedRow theme={theme} label="Memory" value={`${MEMORY_MIB} MiB`} />
          <FixedRow theme={theme} label="Port" value="loopback → guest 6767" />
        </View>

        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
            Credentials
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            Names only. Values are read from the parent environment and never shown.
          </Text>

          {credentials.length === 0 ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
              No credentials are available. Add one in Manage secrets or the parent environment
              before creating a child.
            </Text>
          ) : (
            <View style={{ gap: 2 }}>
              {credentials.map((name) => {
                const checked = selected.includes(name);
                return (
                  <Pressable
                    key={name}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    accessibilityLabel={name}
                    onPress={() => setSelected((current) => toggleCredential(current, name))}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      paddingVertical: 6,
                      opacity: pressed ? 0.7 : 1,
                    })}
                  >
                    <View
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        borderWidth: 1,
                        borderColor: checked ? theme.colors.accent : theme.colors.border,
                        backgroundColor: checked ? theme.colors.accent : "transparent",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {checked ? (
                        <Icon name="Check" size={12} color={theme.colors.accentForeground} />
                      ) : null}
                    </View>
                    <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{name}</Text>
                    <StatusPill
                      label={credentialSourceLabel(name, storedCredentials)}
                      tone={storedCredentials.includes(name) ? "accent" : "muted"}
                      theme={theme}
                    />
                  </Pressable>
                );
              })}
            </View>
          )}

          {!canCreate(availableSelection) ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              Select at least one credential.
            </Text>
          ) : null}
        </View>

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
              label={pending ? "Creating…" : "Create child"}
              theme={theme}
              variant="primary"
              onPress={() => void submit()}
              disabled={!canCreate(availableSelection) || pending}
            />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

function FixedRow({
  theme,
  label,
  value,
}: {
  theme: PluginTheme;
  label: string;
  value: string;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, width: 64 }}>
        {label}
      </Text>
      <Text style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }}>
        {value}
      </Text>
    </View>
  );
}
