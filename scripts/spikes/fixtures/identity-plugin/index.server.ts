// @ts-nocheck -- scratch spike fixture, not product code
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const registrationInput = z
  .object({
    connection: z.string(),
    label: z.string(),
    metadata: z.record(z.string(), z.string()),
    sourceKey: z.string(),
  })
  .strict();

const add = defineRpc({
  name: "spike.add",
  input: registrationInput,
  output: z.unknown(),
});

const update = defineRpc({
  name: "spike.update",
  input: z
    .object({
      registrationId: z.string(),
      enabled: z.boolean().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
      connection: z.string().optional(),
      label: z.string().optional(),
    })
    .strict(),
  output: z.unknown(),
});

const list = defineRpc({
  name: "spike.list",
  input: z.object({}).strict().optional(),
  output: z.unknown(),
});

const remove = defineRpc({
  name: "spike.remove",
  input: z.object({ registrationId: z.string() }).strict(),
  output: z.unknown(),
});

export default function contribute(server) {
  server.handle(add, async (input, { paseo }) => {
    const registration = await paseo.hosts.add(input);
    return { registration, directory: await paseo.hosts.list() };
  });

  server.handle(update, async (input, { paseo }) => {
    const { registrationId, ...patch } = input;
    return paseo.hosts.update(registrationId, patch);
  });

  server.handle(list, async (_input, { paseo }) => paseo.hosts.list());

  server.handle(remove, async (input, { paseo }) => {
    await paseo.hosts.remove(input.registrationId);
    return { removed: true };
  });

  return () => {};
}
