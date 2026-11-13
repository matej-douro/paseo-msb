import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  CPUS,
  GUEST_IMAGE,
  MEMORY_MIB,
  type CredentialName,
} from "../shared/constants";
import type { VmCreateInput } from "../shared/contracts";
import {
  INTEGRATION_CATALOG,
  PROVIDER_CATALOG,
  availableCredentialSet,
  integrationAvailability,
  providerAvailability,
  requiredCredentialsForPlan,
  type IntegrationId,
  type LlmId,
  type ProviderId,
  type ProviderAvailability,
} from "../shared/provisioning";
import { newRequestId } from "./request-id";
import { credentialSourceLabel, errorMessage } from "./state";
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

interface ProviderSelection {
  readonly provider: ProviderId;
  readonly llms: LlmId[];
}

/**
 * The single create confirmation. Providers and integrations are selected by
 * intent; the server derives exactly which credentials enter the sandbox.
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
  const [providers, setProviders] = useState<ProviderSelection[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationId[]>([]);
  const [providersOpen, setProvidersOpen] = useState(true);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = useMemo(() => availableCredentialSet(credentials), [credentials]);
  const providerStates = useMemo(
    () => PROVIDER_CATALOG.map((entry) => providerAvailability(entry.id, available)),
    [available],
  );
  const integrationStates = useMemo(
    () => INTEGRATION_CATALOG.map((entry) => integrationAvailability(entry.id, available)),
    [available],
  );

  useEffect(() => {
    if (!open) return;
    setProviders([]);
    setIntegrations([]);
    setProvidersOpen(true);
    setIntegrationsOpen(false);
    setRequestId(null);
    setPending(false);
    setError(null);
  }, [open]);

  const issue = planIssue(providers, providerStates);
  const canSubmit = issue === null && !pending;
  const required = requiredCredentialsForPlan({ providers, integrations });

  const toggleProvider = (provider: ProviderId) => {
    setProviders((current) => {
      const existing = current.find((selection) => selection.provider === provider);
      if (existing) return current.filter((selection) => selection.provider !== provider);

      const state = providerStates.find((candidate) => candidate.id === provider);
      const usable = state?.llms.filter((llm) => llm.available) ?? [];
      const llms = usable.length === 1 && usable[0] ? [usable[0].id] : [];
      return [...current, { provider, llms }];
    });
  };

  const toggleLlm = (provider: ProviderId, llm: LlmId) => {
    setProviders((current) =>
      current.map((selection) => {
        if (selection.provider !== provider) return selection;
        if (provider === "claude") return { ...selection, llms: [llm] };
        return {
          ...selection,
          llms: selection.llms.includes(llm)
            ? selection.llms.filter((candidate) => candidate !== llm)
            : [...selection.llms, llm],
        };
      }),
    );
  };

  const toggleIntegration = (integration: IntegrationId) => {
    setIntegrations((current) =>
      current.includes(integration)
        ? current.filter((candidate) => candidate !== integration)
        : [...current, integration],
    );
  };

  const submit = async () => {
    if (!canSubmit) return;

    const id = requestId ?? newRequestId();
    setRequestId(id);
    setPending(true);
    setError(null);

    try {
      await onCreate({ requestId: id, plan: { providers, integrations } });
      setRequestId(null);
      setProviders([]);
      setIntegrations([]);
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
          One fixed microsandbox child. Select the providers and integrations it should have.
        </Text>

        <View style={{ gap: 4 }}>
          <FixedRow theme={theme} label="Image" value={GUEST_IMAGE} />
          <FixedRow theme={theme} label="CPUs" value={String(CPUS)} />
          <FixedRow theme={theme} label="Memory" value={`${MEMORY_MIB} MiB`} />
          <FixedRow theme={theme} label="Port" value="loopback → guest 6767" />
        </View>

        <Section
          title="Providers"
          count={providers.length}
          open={providersOpen}
          onToggle={() => setProvidersOpen((current) => !current)}
          theme={theme}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            Secrets decide what can be added. Only the selected options are passed to the child.
          </Text>

          {PROVIDER_CATALOG.map((entry) => {
            const state = providerStates.find((candidate) => candidate.id === entry.id);
            if (!state) return null;
            const selection = providers.find((candidate) => candidate.provider === entry.id);

            return (
              <View key={entry.id} style={{ gap: 2 }}>
                <OptionRow
                  checked={selection !== undefined}
                  disabled={!state.available}
                  label={entry.label}
                  description={entry.description}
                  reason={state.reason}
                  theme={theme}
                  onPress={() => toggleProvider(entry.id)}
                />

                {selection
                  ? entry.llms.map((llm) => {
                      const availability = state.llms.find(
                        (candidate) => candidate.id === llm.id,
                      );
                      return (
                        <OptionRow
                          key={llm.id}
                          nested
                          checked={selection.llms.includes(llm.id)}
                          disabled={!availability?.available}
                          label={llm.label}
                          description={llm.description}
                          reason={
                            availability && availability.missing.length > 0
                              ? `Set ${availability.missing.join(" or ")}.`
                              : null
                          }
                          theme={theme}
                          onPress={() => toggleLlm(entry.id, llm.id)}
                        />
                      );
                    })
                  : null}
              </View>
            );
          })}
        </Section>

        <Section
          title="Integrations"
          count={integrations.length}
          open={integrationsOpen}
          onToggle={() => setIntegrationsOpen((current) => !current)}
          theme={theme}
        >
          {INTEGRATION_CATALOG.map((entry) => {
            const state = integrationStates.find((candidate) => candidate.id === entry.id);
            if (!state) return null;
            return (
              <OptionRow
                key={entry.id}
                checked={integrations.includes(entry.id)}
                disabled={!state.available}
                label={entry.label}
                description={entry.description}
                reason={state.reason}
                theme={theme}
                onPress={() => toggleIntegration(entry.id)}
              />
            );
          })}
        </Section>

        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
            Will install
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {installSummary(providers, integrations)}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            Credentials:{" "}
            {required.length === 0
              ? "none"
              : required
                  .map((name) => `${name} (${credentialSourceLabel(name, storedCredentials)})`)
                  .join(", ")}
          </Text>
        </View>

        {issue ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{issue}</Text>
        ) : null}

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
              disabled={!canSubmit}
            />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

function planIssue(
  providers: readonly ProviderSelection[],
  availability: readonly ProviderAvailability[],
): string | null {
  if (providers.length === 0) return "Select at least one provider.";

  for (const selection of providers) {
    const state = availability.find((candidate) => candidate.id === selection.provider);
    const entry = PROVIDER_CATALOG.find((candidate) => candidate.id === selection.provider);
    if (!entry) return "A selected provider is not recognized.";
    if (!state?.available) return `${entry.label} is not available with the current secrets.`;
    if (selection.llms.length === 0) {
      return `Select at least one model provider for ${entry.label}.`;
    }
    for (const llm of selection.llms) {
      const llmState = state.llms.find((candidate) => candidate.id === llm);
      if (!llmState?.available) {
        const label = entry.llms.find((candidate) => candidate.id === llm)?.label ?? llm;
        return `${label} is not available with the current secrets.`;
      }
    }
  }

  return null;
}

function installSummary(
  providers: readonly ProviderSelection[],
  integrations: readonly IntegrationId[],
): string {
  const parts: string[] = [];

  for (const selection of providers) {
    const entry = PROVIDER_CATALOG.find((candidate) => candidate.id === selection.provider);
    if (!entry) continue;
    const llms = selection.llms
      .map((llm) => entry.llms.find((candidate) => candidate.id === llm)?.label ?? llm)
      .join(", ");
    parts.push(llms.length > 0 ? `${entry.label} (${llms})` : entry.label);
  }

  for (const integration of integrations) {
    const entry = INTEGRATION_CATALOG.find((candidate) => candidate.id === integration);
    if (entry) parts.push(entry.label);
  }

  return parts.length > 0 ? parts.join(" · ") : "Nothing selected.";
}

function Section({
  title,
  count,
  open,
  onToggle,
  theme,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle(): void;
  theme: PluginTheme;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingVertical: 6,
          opacity: pressed ? 0.75 : 1,
        })}
      >
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>
          {title}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {count > 0 ? `${count} selected` : "none"}
        </Text>
      </Pressable>
      {open ? <View style={{ gap: 4 }}>{children}</View> : null}
    </View>
  );
}

function OptionRow({
  checked,
  disabled,
  nested = false,
  label,
  description,
  reason,
  theme,
  onPress,
}: {
  checked: boolean;
  disabled: boolean;
  nested?: boolean;
  label: string;
  description: string;
  reason: string | null;
  theme: PluginTheme;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        paddingVertical: 6,
        paddingLeft: nested ? 22 : 0,
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
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
          marginTop: 1,
        }}
      >
        {checked ? (
          <Icon name="Check" size={12} color={theme.colors.accentForeground} />
        ) : null}
      </View>
      <View style={{ flex: 1, flexShrink: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: nested ? 12 : 13 }}>
          {label}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{description}</Text>
        {reason ? (
          <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>{reason}</Text>
        ) : null}
      </View>
      {!disabled ? (
        <StatusPill
          label={checked ? "Selected" : "Available"}
          tone={checked ? "accent" : "muted"}
          theme={theme}
        />
      ) : (
        <StatusPill label="Unavailable" tone="warning" theme={theme} />
      )}
    </Pressable>
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
