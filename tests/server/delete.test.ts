import { describe, expect, it } from "vitest";
import { MANAGED_LABEL } from "../../shared/constants";
import { safeError } from "../../shared/errors";
import { deleteVm, type DeleteContext } from "../../server/delete";
import {
  fakeHostDirectory,
  fakeRegistration,
  fakeSandbox,
  FakePaseoHosts,
  FakeSandboxCreator,
  PARENT_ID,
  type FakeCreatorOptions,
} from "./fake-runtime";

const NAME = "paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";
const INPUT = { name: NAME, id: "sandbox_1", confirmName: NAME };

function deleteContext(
  creator: FakeSandboxCreator,
  hosts: FakePaseoHosts,
): DeleteContext {
  return { hosts, sandboxHost: creator, timeoutMs: 100, pollMs: 1 };
}

function ownedRegistration(overrides: Parameters<typeof fakeRegistration>[0] = {}) {
  return fakeRegistration({
    registrationId: "reg_owned",
    label: `${PARENT_ID}/${NAME}`,
    source: { id: "plugin", key: "sandbox_1" },
    metadata: { source: "paseo-msb", vm: "sandbox_1", name: NAME },
    ...overrides,
  });
}

describe("deleteVm", () => {
  it("destroys the exact sandbox and removes its registration", async () => {
    const creator = new FakeSandboxCreator({
      existing: fakeSandbox({ id: "sandbox_1", name: NAME }),
    });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    const result = await deleteVm(deleteContext(creator, hosts), INPUT);

    expect(result).toEqual({ name: NAME, removed: true });
    expect(creator.destroyed).toEqual(["sandbox_1"]);
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("removes a stale registration when the sandbox is already gone", async () => {
    const creator = new FakeSandboxCreator({ existing: null });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    const result = await deleteVm(deleteContext(creator, hosts), INPUT);

    expect(result).toEqual({ name: NAME, removed: true });
    expect(creator.destroyed).toEqual([]);
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("treats missing resources as success", async () => {
    const creator = new FakeSandboxCreator({ existing: null });
    const hosts = new FakePaseoHosts();

    const result = await deleteVm(deleteContext(creator, hosts), INPUT);

    expect(result).toEqual({ name: NAME, removed: true });
    expect(creator.destroyed).toEqual([]);
    expect(hosts.removed).toEqual([]);
  });

  it("is safe to repeat", async () => {
    const options: FakeCreatorOptions = {
      existing: fakeSandbox({ id: "sandbox_1", name: NAME }),
    };
    const creator = new FakeSandboxCreator(options);
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });
    const context = deleteContext(creator, hosts);

    await deleteVm(context, INPUT);
    options.existing = null;

    await expect(deleteVm(context, INPUT)).resolves.toEqual({ name: NAME, removed: true });
    expect(creator.destroyed).toEqual(["sandbox_1"]);
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("refuses a same-name replacement with a different stable ID", async () => {
    const creator = new FakeSandboxCreator({
      existing: fakeSandbox({ id: "sandbox_replacement", name: NAME }),
    });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    await expect(deleteVm(deleteContext(creator, hosts), INPUT)).rejects.toThrow(
      safeError("id_mismatch").message,
    );

    expect(creator.destroyed).toEqual([]);
    expect(hosts.removed).toEqual([]);
  });

  it("refuses an unmanaged sandbox", async () => {
    const creator = new FakeSandboxCreator({
      existing: fakeSandbox({
        id: "sandbox_1",
        name: NAME,
        labels: { [MANAGED_LABEL]: "v2" },
      }),
    });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    await expect(deleteVm(deleteContext(creator, hosts), INPUT)).rejects.toThrow(
      safeError("invalid_config").message,
    );

    expect(creator.destroyed).toEqual([]);
    expect(hosts.removed).toEqual([]);
  });

  it("keeps the registration when destruction fails", async () => {
    const creator = new FakeSandboxCreator({
      existing: fakeSandbox({ id: "sandbox_1", name: NAME }),
      destroyError: new Error("runtime destroy failed"),
    });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    await expect(deleteVm(deleteContext(creator, hosts), INPUT)).rejects.toThrow(
      safeError("delete_failed").message,
    );

    expect(hosts.removed).toEqual([]);
  });

  it("leaves a stale registration for Repair when removal fails after destroy", async () => {
    const creator = new FakeSandboxCreator({
      existing: fakeSandbox({ id: "sandbox_1", name: NAME }),
    });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
      removeError: new Error("hosts.remove failed"),
    });

    await expect(deleteVm(deleteContext(creator, hosts), INPUT)).rejects.toThrow(
      safeError("registration_failed").message,
    );

    expect(creator.destroyed).toEqual(["sandbox_1"]);
    expect(hosts.removed).toEqual([]);
  });

  it("refuses to destroy anything when registrations are unavailable", async () => {
    const creator = new FakeSandboxCreator({
      existing: fakeSandbox({ id: "sandbox_1", name: NAME }),
    });
    const hosts = new FakePaseoHosts({
      listError: new Error("registrations unavailable: leaked detail"),
    });

    await expect(deleteVm(deleteContext(creator, hosts), INPUT)).rejects.toThrow(
      safeError("registrations_unavailable").message,
    );

    expect(creator.destroyed).toEqual([]);
    expect(hosts.removed).toEqual([]);
  });

  it("refuses to destroy anything when the runtime lookup fails", async () => {
    const creator = new FakeSandboxCreator({
      findError: new Error("runtime lookup failed"),
    });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    await expect(deleteVm(deleteContext(creator, hosts), INPUT)).rejects.toThrow(
      safeError("runtime_unavailable").message,
    );

    expect(creator.destroyed).toEqual([]);
    expect(hosts.removed).toEqual([]);
  });

  it("rejects a confirmation mismatch", async () => {
    const creator = new FakeSandboxCreator({ existing: null });
    const hosts = new FakePaseoHosts();

    await expect(
      deleteVm(deleteContext(creator, hosts), { ...INPUT, confirmName: "paseo-other" }),
    ).rejects.toThrow(safeError("invalid_request").message);
  });
});
