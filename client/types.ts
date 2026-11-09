import type { z } from "zod";
import type { CredentialNameSchema } from "../shared/contracts";

export type CredentialName = z.infer<typeof CredentialNameSchema>;
