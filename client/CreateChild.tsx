import {
  Icon,
  Modal,
  SettingsCard,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
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
  type IntegrationCatalogEntry,
  type IntegrationId,
  type LlmAvailability,
  type LlmCatalogEntry,
  type LlmId,
  type ProviderAvailability,
  type ProviderCatalogEntry,
  type ProviderId,
} from "../shared/provisioning";
import { INTEGRATION_ICONS, LLM_ICONS, PROVIDER_ICONS } from "./provider-icons";
import { newRequestId } from "./request-id";
import { credentialSourceLabel, errorMessage, planSummary } from "./state";
import { ActionButton, type PluginTheme } from "./ui";

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
    setRequestId(null);
    setPending(false);
    setError(null);
  }, [open]);

  const issue = planIssue(providers, integrations, providerStates, integrationStates);
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

        <SettingsSection title="Providers" trailing={<CountLabel count={providers.length} theme={theme} />}>
          <View style={{ gap: 8 }}>
            <SettingsCard>
              {PROVIDER_CATALOG.map((entry, index) => {
                const state = providerStates.find((candidate) => candidate.id === entry.id);
                if (!state) return null;
                const selection = providers.find(
                  (candidate) => candidate.provider === entry.id,
                );

                return (
                  <ProviderBlock
                    key={entry.id}
                    entry={entry}
                    state={state}
                    selection={selection}
                    last={index === PROVIDER_CATALOG.length - 1}
                    theme={theme}
                    compact={compact}
                    onToggle={() => toggleProvider(entry.id)}
                    onToggleLlm={(llm) => toggleLlm(entry.id, llm)}
                  />
                );
              })}
            </SettingsCard>
          </View>
        </SettingsSection>

        <SettingsSection
          title="Integrations"
          trailing={<CountLabel count={integrations.length} theme={theme} />}
        >
          <SettingsCard>
            {INTEGRATION_CATALOG.map((entry, index) => {
              const state = integrationStates.find(
                (candidate) => candidate.id === entry.id,
              );
              if (!state) return null;

              return (
                <IntegrationRow
                  key={entry.id}
                  entry={entry}
                  available={state.available}
                  reason={state.reason}
                  checked={integrations.includes(entry.id)}
                  last={index === INTEGRATION_CATALOG.length - 1}
                  theme={theme}
                  compact={compact}
                  onToggle={() => toggleIntegration(entry.id)}
                />
              );
            })}
          </SettingsCard>
        </SettingsSection>

        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
            Will install
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {planSummary({ providers, integrations })}
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
  integrations: readonly IntegrationId[],
  availability: readonly ProviderAvailability[],
  integrationAvailability: readonly { id: IntegrationId; available: boolean }[],
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

  for (const integration of integrations) {
    const state = integrationAvailability.find((candidate) => candidate.id === integration);
    if (!state?.available) {
      const entry = INTEGRATION_CATALOG.find((candidate) => candidate.id === integration);
      return `${entry?.label ?? integration} is not available with the current secrets.`;
    }
  }

  return null;
}


function CountLabel({ count, theme }: { count: number; theme: PluginTheme }) {
  return (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
      {count > 0 ? `${count} selected` : "none"}
    </Text>
  );
}

function ProviderBlock({
  entry,
  state,
  selection,
  last,
  theme,
  compact,
  onToggle,
  onToggleLlm,
}: {
  entry: ProviderCatalogEntry;
  state: ProviderAvailability;
  selection: ProviderSelection | undefined;
  last: boolean;
  theme: PluginTheme;
  compact: boolean;
  onToggle(): void;
  onToggleLlm(llm: LlmId): void;
}) {
  const selected = selection !== undefined;
  const nested = selected && entry.llms.length > 0;

  return (
    <>
      <ProviderRow
        entry={entry}
        state={state}
        selected={selected}
        selectedCount={selection?.llms.length ?? 0}
        last={!nested && last}
        theme={theme}
        compact={compact}
        onToggle={onToggle}
      />
      {nested
        ? entry.llms.map((llm, index) => (
            <LlmRow
              key={llm.id}
              llm={llm}
              availability={state.llms.find((candidate) => candidate.id === llm.id)}
              checked={selection?.llms.includes(llm.id) ?? false}
              exclusive={entry.id === "claude"}
              last={last && index === entry.llms.length - 1}
              theme={theme}
              compact={compact}
              onToggle={() => onToggleLlm(llm.id)}
            />
          ))
        : null}
    </>
  );
}

function ProviderRow({
  entry,
  state,
  selected,
  selectedCount,
  last,
  theme,
  compact,
  onToggle,
}: {
  entry: ProviderCatalogEntry;
  state: ProviderAvailability;
  selected: boolean;
  selectedCount: number;
  last: boolean;
  theme: PluginTheme;
  compact: boolean;
  onToggle(): void;
}) {
  const available = state.available;
  const status = available
    ? selectedCount > 0
      ? `Available · ${selectedCount} selected`
      : "Available"
    : state.reason ?? "Unavailable";

  return (
    <SettingsRowFrame
      role="switch"
      accessibilityLabel={`${entry.label}, ${status}`}
      accessibilityState={{ checked: selected, disabled: !available }}
      disabled={!available}
      last={last}
      theme={theme}
      compact={compact}
      onPress={onToggle}
    >
      <Icon
        name={selected ? "ChevronDown" : "ChevronRight"}
        size={14}
        color={theme.colors.foregroundMuted}
      />
      <Icon
        icon={PROVIDER_ICONS[entry.id]}
        size={20}
        color={available ? theme.colors.foreground : theme.colors.foregroundMuted}
      />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{
            color: available ? theme.colors.foreground : theme.colors.foregroundMuted,
            fontSize: 13,
            fontWeight: "600",
          }}
        >
          {entry.label}
        </Text>
        <Text
          numberOfLines={2}
          style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}
        >
          {status}
        </Text>
      </View>
      <SelectionControl kind="switch" checked={selected} theme={theme} />
    </SettingsRowFrame>
  );
}

function LlmRow({
  llm,
  availability,
  checked,
  exclusive,
  last,
  theme,
  compact,
  onToggle,
}: {
  llm: LlmCatalogEntry;
  availability: LlmAvailability | undefined;
  checked: boolean;
  exclusive: boolean;
  last: boolean;
  theme: PluginTheme;
  compact: boolean;
  onToggle(): void;
}) {
  const available = availability?.available ?? false;
  const status =
    available
      ? "Available"
      : availability && availability.missing.length > 0
        ? `Set ${availability.missing.join(" or ")}.`
        : "Unavailable";

  return (
    <SettingsRowFrame
      nested
      role={exclusive ? "radio" : "switch"}
      accessibilityLabel={`${llm.label}, ${status}`}
      accessibilityState={{ checked, disabled: !available }}
      disabled={!available}
      last={last}
      theme={theme}
      compact={compact}
      onPress={onToggle}
    >
      <Icon
        icon={LLM_ICONS[llm.id]}
        size={16}
        color={available ? theme.colors.foreground : theme.colors.foregroundMuted}
      />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{
            color: available ? theme.colors.foreground : theme.colors.foregroundMuted,
            fontSize: 12,
            fontWeight: "500",
          }}
        >
          {llm.label}
        </Text>
        <Text
          numberOfLines={2}
          style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}
        >
          {status}
        </Text>
      </View>
      <SelectionControl
        kind={exclusive ? "radio" : "switch"}
        checked={checked}
        theme={theme}
      />
    </SettingsRowFrame>
  );
}

function IntegrationRow({
  entry,
  available,
  reason,
  checked,
  last,
  theme,
  compact,
  onToggle,
}: {
  entry: IntegrationCatalogEntry;
  available: boolean;
  reason: string | null;
  checked: boolean;
  last: boolean;
  theme: PluginTheme;
  compact: boolean;
  onToggle(): void;
}) {
  const status = available ? "Available" : reason ?? "Unavailable";

  return (
    <SettingsRowFrame
      role="switch"
      accessibilityLabel={`${entry.label}, ${status}`}
      accessibilityState={{ checked, disabled: !available }}
      disabled={!available}
      last={last}
      theme={theme}
      compact={compact}
      onPress={onToggle}
    >
      <View style={{ width: 14 }} />
      <Icon
        icon={INTEGRATION_ICONS[entry.id]}
        size={20}
        color={available ? theme.colors.foreground : theme.colors.foregroundMuted}
      />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{
            color: available ? theme.colors.foreground : theme.colors.foregroundMuted,
            fontSize: 13,
            fontWeight: "600",
          }}
        >
          {entry.label}
        </Text>
        <Text
          numberOfLines={2}
          style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}
        >
          {status}
        </Text>
      </View>
      <SelectionControl kind="switch" checked={checked} theme={theme} />
    </SettingsRowFrame>
  );
}

function SettingsRowFrame({
  nested = false,
  role = "switch",
  accessibilityLabel,
  accessibilityState,
  disabled,
  last,
  theme,
  compact,
  onPress,
  children,
}: {
  nested?: boolean;
  role?: "switch" | "radio";
  accessibilityLabel: string;
  accessibilityState: { checked: boolean; disabled: boolean };
  disabled: boolean;
  last: boolean;
  theme: PluginTheme;
  compact: boolean;
  onPress(): void;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={accessibilityState}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: nested ? 48 : 56,
        paddingVertical: 8,
        paddingLeft: nested ? (compact ? 36 : 38) : compact ? 10 : 12,
        paddingRight: compact ? 10 : 12,
        borderBottomColor: theme.colors.border,
        borderBottomWidth: last ? 0 : 1,
        backgroundColor: disabled
          ? "transparent"
          : pressed || hovered
            ? theme.colors.surface2
            : "transparent",
        opacity: disabled ? 0.55 : pressed ? 0.85 : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

function SelectionControl({
  kind,
  checked,
  theme,
}: {
  kind: "switch" | "radio";
  checked: boolean;
  theme: PluginTheme;
}) {
  if (kind === "radio") {
    return (
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          borderWidth: 1,
          borderColor: checked ? theme.colors.accent : theme.colors.border,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked ? (
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: theme.colors.accent,
            }}
          />
        ) : null}
      </View>
    );
  }

  return (
    <View
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: checked ? theme.colors.accent : theme.colors.border,
        backgroundColor: checked ? theme.colors.accent : theme.colors.surface2,
        padding: 2,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: checked ? "flex-end" : "flex-start",
      }}
    >
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: checked
            ? theme.colors.accentForeground
            : theme.colors.foregroundMuted,
        }}
      />
    </View>
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
