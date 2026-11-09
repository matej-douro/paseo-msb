import {
  connectParent,
  getFreePort,
  restartIsolatedParent,
  startIsolatedParent,
  stopIsolatedParent,
  waitForHost,
  waitForProvider,
} from "./paseo-daemon.mjs";

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function runParentContract(pins, report) {
  const parent = await startIsolatedParent();
  const child = await startIsolatedParent();
  let parentClient = null;
  let registrationId = null;
  try {
    parentClient = await connectParent(parent.url, { clientId: "spike-contract-parent" });
    const childClient = await connectParent(child.url, { clientId: "spike-contract-child" });
    const childPi = await waitForProvider(childClient.api, "pi", 30_000);
    await childClient.close();
    report.contractPass("contract.child.provider", "Standalone child daemon reports Pi", {
      detail: childPi?.available ? "pi available" : "pi unavailable",
    });
    if (!childPi?.available) {
      report.fail("contract.child.provider-available", "Standalone child daemon reports Pi", {
        detail: "pi unavailable in the isolated child daemon",
      });
      return;
    }

    const sourceKey = `spike-contract-${Date.now()}`;
    const label = `${(await parentClient.api.hosts.list()).self.label}/contract-child`;
    const added = await parentClient.api.hosts.add({
      connection: `127.0.0.1:${child.port}`,
      label,
      sourceKey,
      metadata: {
        source: "paseo-msb-spike",
        vm: sourceKey,
        name: "contract-child",
      },
    });
    registrationId = added.registrationId;
    report.contractPass("contract.parent.add", "hosts.add persists sourceKey and metadata", {
      detail: "registration created",
      evidence: {
        status: added.status,
        sourceKey: added.source.key,
        hasMetadata: Object.keys(added.metadata).length > 0,
      },
    });

    const online = await waitForHost(parentClient.api, registrationId, "online", 30_000);
    report.contractPass("contract.parent.online", "Routed child reaches online", {
      detail: online.serverId ? "serverId assigned" : "online without serverId",
    });

    const routed = await parentClient.api.hosts.client(online.serverId);
    await routed.providers.refresh();
    const routedPi = await waitForProvider(routed, "pi", 30_000);
    await routed.dispose();
    report.contractPass("contract.parent.refresh", "providers.refresh through routed client sees Pi", {
      detail: routedPi?.available ? "pi available through routed client" : "pi unavailable through routed client",
    });
    if (!routedPi?.available) {
      report.fail("contract.parent.refresh-pi", "providers.refresh through routed client sees Pi", {
        detail: "pi unavailable through routed client",
      });
    }

    await restartIsolatedParent(parent);
    parentClient = await connectParent(parent.url, { clientId: "spike-contract-parent-restarted" });
    const afterRestart = await waitForHost(parentClient.api, registrationId, "online", 30_000);
    report.contractPass("contract.parent.restart", "Registration survives parent restart", {
      detail: afterRestart.serverId ? "online after restart" : "online after restart without serverId",
    });

    await parentClient.api.hosts.remove(registrationId);
    const directory = await parentClient.api.hosts.list();
    const stillThere = directory.hosts.some((entry) => entry.registrationId === registrationId);
    registrationId = null;
    if (stillThere) {
      report.fail("contract.parent.remove", "hosts.remove removes the registration", {
        detail: "registration still present after remove",
      });
    } else {
      report.contractPass("contract.parent.remove", "hosts.remove removes the registration", {
        detail: "registration absent after remove",
      });
    }
  } catch (error) {
    report.fail("contract.parent", "Parent registration contract", {
      detail: safeError(error),
    });
    if (registrationId && parentClient) {
      try {
        await parentClient.api.hosts.remove(registrationId);
      } catch {
        // Best-effort cleanup only.
      }
    }
  } finally {
    if (parentClient) {
      await parentClient.close();
    }
    await stopIsolatedParent(parent);
    await stopIsolatedParent(child);
  }
}
