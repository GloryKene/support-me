# SupportMe Smart Contract Governance: Multi-Signature & Timelock Administration

This runbook documents the multi-signature (M-of-N) threshold and timelock governance mechanisms for managing sensitive administrative actions across the SupportMe Soroban smart contracts (`donation` and `creator-registry`).

---

## 1. Governance Overview

To protect user funds and creator registry records against single-key compromise or unauthorized parameter changes, high-risk administrative operations require:
1. **Multi-Signature Approval**: Proposals require a configurable threshold ($M$-of-$N$) of authorized admin signatures before execution.
2. **Timelock Delay**: A mandatory delay period ($\text{ETA} = \text{creation\_timestamp} + \text{delay\_secs}$) before an approved proposal can be executed on-chain.
3. **Emergency Circuit Breaker**: Any single authorized admin can execute an immediate `emergency_pause` to freeze contract state in response to an active threat.
4. **Proposal Expiry**: Proposals expire after 7 days (`ADMIN_PROPOSAL_TTL_SECONDS = 604,800` seconds). Expired proposals cannot be approved or executed.
5. **Proposal Cancellation**: A proposal's original creator can unilaterally cancel it via `cancel_admin_action`. Other admins can also cancel a proposal once a threshold of non-proposer admins approve cancellation. Cancelled proposals can never be executed.
6. **Dynamic Approval Recount**: Approvals are recounted against the current admin set at execution time. If an admin who approved a proposal is later removed via `RemoveAdmin`, their approval no longer counts toward the threshold.

---

## 2. High-Risk Administrative Actions

Administrative actions are divided by contract support:

### Actions Supported on Both Contracts
- `AddAdmin(Address)`: Adds a new trusted address to the contract admin list. JSON: `{"AddAdmin": "<NEW_ADMIN_ADDRESS>"}`
- `RemoveAdmin(Address)`: Revokes admin privileges from an address. JSON: `{"RemoveAdmin": "<ADMIN_ADDRESS>"}`
- `SetThreshold(u32)`: Adjusts the signature threshold ($M$). JSON: `{"SetThreshold": 2}`
- `SetDonationContract(Address)`: On `creator-registry`, updates the bound donation contract address. On `donation`, updates the bound creator registry address. JSON: `{"SetDonationContract": "<CONTRACT_ADDRESS>"}`

### Donation-Contract-Only Actions
The following actions are supported exclusively by the `donation` contract (and rejected with `UnsupportedAction` by `creator-registry`):
- `SetExecutor(Address)`: Configures or rotates the off-chain auto-charge executor address. JSON: `{"SetExecutor": "<NEW_EXECUTOR_ADDRESS>"}`
- `Pause`: Suspends contract transfers and subscription operations. JSON: `"Pause"`
- `Unpause`: Resumes contract operations. JSON: `"Unpause"`
- `AddAllowedToken(Address)`: Adds a Stellar SAC token address to the donation allowlist. JSON: `{"AddAllowedToken": "<TOKEN_ADDRESS>"}`
- `RemoveAllowedToken(Address)`: Removes a token from the allowlist. JSON: `{"RemoveAllowedToken": "<TOKEN_ADDRESS>"}`
- `SetMinDonation(i128)`: Sets the minimum donation guardrail in stroops (0 disables). JSON: `{"SetMinDonation": 10000000}`
- `SetMaxDonation(i128)`: Sets the maximum donation guardrail in stroops (0 disables). JSON: `{"SetMaxDonation": 1000000000}`

---

## 3. Operations Runbook

### Step 1: Propose an Administrative Action
An authorized admin constructs and submits a proposal transaction using `stellar contract invoke`:

```bash
stellar contract invoke \
  --id <DONATION_CONTRACT_ID> \
  --source-account <ADMIN_1_KEY> \
  --network testnet \
  -- \
  propose_admin_action \
  --proposer <ADMIN_1_ADDRESS> \
  --action '{"SetExecutor": "<NEW_EXECUTOR_ADDRESS>"}'
```

*Output:* Returns the `proposal_id` (e.g. `0`) and emits a `ProposalCreatedEvent`.

The action is checked against the contract's current state before it is stored, so an invalid payload fails here instead of after the approvals and the timelock. Nothing is stored when a check fails:

| Proposed action | Rejected when | Error |
| --- | --- | --- |
| `SetThreshold(n)` | `n` is 0 or above the current admin count | `InvalidThreshold` |
| `AddAdmin(a)` | `a` is already an admin | `AdminAlreadyExists` |
| `RemoveAdmin(a)` | `a` is not an admin | `AdminNotFound` |
| `RemoveAdmin(a)` | `a` is the last admin | `CannotRemoveAllAdmins` |
| `RemoveAdmin(a)` | the remaining admins would be fewer than the threshold | `ThresholdExceedsAdmins` |
| `SetMinDonation(x)` / `SetMaxDonation(x)` (donation only) | `x` is negative | `InvalidAmount` |
| `SetMinDonation(x)` / `SetMaxDonation(x)` (donation only) | the new bound would put the minimum above a non-zero maximum | `InvalidDonationLimits` |

Execution still enforces these conditions, because the admin set, threshold or donation limits can change while a proposal waits. An `AddAdmin` or `RemoveAdmin` that would change nothing by then fails with `AdminAlreadyExists` or `AdminNotFound` and stays unexecuted, so it can be cancelled.

---

### Step 2: Co-Signers Approve the Proposal
Additional admins review the proposal on-chain and submit approvals until the required signature threshold ($M$) is reached:

```bash
stellar contract invoke \
  --id <DONATION_CONTRACT_ID> \
  --source-account <ADMIN_2_KEY> \
  --network testnet \
  -- \
  approve_admin_action \
  --admin <ADMIN_2_ADDRESS> \
  --proposal_id 0
```

---

### Step 3: Execute the Proposal After Timelock
Once the threshold is satisfied, the ledger timestamp reaches $\ge \text{ETA}$, and the proposal has not expired ($\le \text{expires\_at}$):

```bash
stellar contract invoke \
  --id <DONATION_CONTRACT_ID> \
  --source-account <ADMIN_1_KEY> \
  --network testnet \
  -- \
  execute_admin_action \
  --executor <ADMIN_1_ADDRESS> \
  --proposal_id 0
```

---

### Step 4: Cancel a Proposal (Optional)
The proposer can unilaterally cancel their own proposal before execution. Other admins can also cancel once $M$ current admins call `cancel_admin_action`:

```bash
stellar contract invoke \
  --id <DONATION_CONTRACT_ID> \
  --source-account <ADMIN_1_KEY> \
  --network testnet \
  -- \
  cancel_admin_action \
  --caller <ADMIN_1_ADDRESS> \
  --proposal_id 0
```

---

## 4. Emergency Procedures

### Immediate Emergency Pause
In the event of a suspected security event or anomaly, any single authorized admin can immediately pause the donation contract:
```bash
stellar contract invoke \
  --id <DONATION_CONTRACT_ID> \
  --source-account <ANY_ADMIN_KEY> \
  --network testnet \
  -- \
  emergency_pause \
  --admin <ADMIN_ADDRESS>
```

### Unpausing the Contract
Resuming operations requires the full multi-sig proposal and execution flow (`propose_admin_action` with `"Unpause"`).
