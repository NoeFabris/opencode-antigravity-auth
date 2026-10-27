import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

export const AccountSummary = z.object({
  id: z.string(),
  email: z.string(),
  enabled: z.boolean(),
  current: z.boolean(),
  verificationRequired: z.boolean(),
  lastUsed: z.number(),
  quota: z.object({
    remainingFraction: z.number().min(0).max(1),
    resetTime: z.string().optional(),
    updatedAt: z.number().optional(),
  }).optional(),
})

export const AntigravityAccountsRpc = Rpc.define({
  id: "antigravity.accounts",
  methods: {
    list: { input: z.object({}), output: z.array(AccountSummary) },
    connections: { input: z.object({ id: z.string() }), output: z.object({ ids: z.array(z.string()) }) },
    quotas: {
      input: z.object({ id: z.string().optional() }),
      output: z.object({ report: z.string(), accounts: z.array(z.object({ id: z.string(), email: z.string(), disabled: z.boolean(), report: z.string() })) }),
    },
    update: {
      input: z.object({ id: z.string(), action: z.enum(["enable", "disable", "select", "delete"]) }),
      output: z.object({ message: z.string() }),
    },
    models: { input: z.object({}), output: z.object({ count: z.number() }) },
  },
  events: {},
})

export type AccountSummary = z.infer<typeof AccountSummary>
