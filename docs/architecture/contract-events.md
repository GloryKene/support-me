# Soroban Contract Events Specification

This document defines the schema, topic indexing strategy, and backend consumption patterns for all smart contract events emitted by SupportMe's Soroban contracts (`donation` and `creator-registry`).

---

## 1. Overview & Architecture

Historically, off-chain backend systems had to periodically poll contract state via RPCs to track donation arrivals, subscription cancellations, or profile updates. 

SupportMe contracts now emit self-contained events for all key on-chain state mutations. Every event payload carries sufficient contextual data (including involved parties, token asset address, amounts, and schedule timestamps) so that indexers, listeners, and backend services can reconcile off-chain database state without making follow-up RPC queries.

Between the two contracts there are 20 distinct event topics (§2). The backend's `SorobanEventListener` only reconciles the six that have a corresponding row to update in Postgres — `donated`, `subscribed`, `sub_cancelled`, `goal_upd`, `sub_failed`, and `don_rec` (§3). The remaining fourteen — creator registration and the admin-governance/guardrail topics — are emitted for on-chain transparency and external indexers; the listener's `processEvent` switch has no case for them and its `default` branch returns `false` without writing to the database.

```
+---------------------+           +------------------------+
|   Stellar Network   |           |  SorobanEventListener  |
|  (Soroban Contracts)|           |    (Express Backend)   |
+----------+----------+           +-----------+------------+
           |                                  |
           | emit #[contractevent]            |
           +--------------------------------->| poll getEvents (cursor-based)
                                              |
                                              +----+ Reconcile DB (Prisma)
                                              |    | (e.g. sub cancelled, goal updated)
                                              |
                                              v
                                         eventBus (Node.js)
                                              |
                                              v
                                      GET /api/events (SSE)
                                              |
                                              v
                                     Connected Dashboards
```

---

## 2. Event Schemas & Payload Shapes

### 2.1. `DonatedEvent`
Emitted by `DonationContract::donate` and `DonationContract::charge_subscription` whenever tokens move from donor/supporter to creator.

- **Topic Schema**: `["donated", donor: Address, creator: Address]`
- **Value Schema**:
  ```rust
  pub struct DonatedEvent {
      pub donor: Address,                  // [topic]
      pub creator: Address,                // [topic]
      pub donation_id: u32,                // Per-contract donation counter
      pub token: Address,                  // SAC address of donated token (e.g. native XLM or USDC)
      pub amount: i128,                    // Net amount transferred to the creator, in atomic units / stroops
      pub memo: String,                    // Donor memo or "recurring"
      pub timestamp: u64,                  // Ledger timestamp
      pub subscription_id: Option<u64>,    // Set when this donation was a recurring charge, else None
  }
  ```
- **Indexing & Filtering**:
  Indexed by `donor` and `creator`. Allows querying all donations received by a creator or all donations sent by a supporter without scanning unrelated ledger traffic.

---

### 2.2. `SubscribedEvent`
Emitted by `DonationContract::subscribe` when a supporter sets up a recurring donation schedule.

- **Topic Schema**: `["subscribed", supporter: Address, creator: Address]`
- **Value Schema**:
  ```rust
  pub struct SubscribedEvent {
      pub supporter: Address,       // [topic] Supporter wallet address
      pub creator: Address,         // [topic] Creator wallet address
      pub subscription_id: u64,     // Globally unique counter ID
      pub token: Address,           // SAC address to draw allowance from
      pub amount: i128,             // Amount charged per interval
      pub interval_secs: u64,       // Interval in seconds (e.g. 2,592,000 for monthly)
      pub next_charge_at: u64,      // Timestamp when first recurrence becomes due
  }
  ```
- **Indexing & Filtering**:
  Indexed by `supporter` and `creator`. Contains full interval and asset metadata, allowing the backend to register the subscription and schedule without extra RPC queries.

---

### 2.3. `SubscriptionCancelledEvent`
Emitted by `DonationContract::cancel_subscription` when a supporter cancels their recurring donation.

- **Topic Schema**: `["sub_cancelled", supporter: Address, creator: Address]`
- **Value Schema**:
  ```rust
  pub struct SubscriptionCancelledEvent {
      pub supporter: Address,       // [topic] Supporter wallet address
      pub creator: Address,         // [topic] Creator wallet address
      pub subscription_id: u64,     // ID of the cancelled subscription
  }
  ```
- **Indexing & Filtering**:
  Indexed by both `supporter` and `creator`. Enables the backend to immediately reconcile database state (`active = false`) upon event ingestion without polling.

---

### `SubscriptionAllowanceEvent`

Cancellation subtracts the cancelled subscription's amount from the shared SAC
allowance, clamped at zero. When the remainder is positive, the contract
re-approves it through the cancellation ledger plus the cancelled subscription's
TTL bump. This can shorten or lengthen the previous expiry.

- **Topic Schema**: `["sub_allowance_updated", supporter: Address, token: Address]`
- **Value Schema**:
  ```rust
  pub struct SubscriptionAllowanceEvent {
      #[topic]
      pub supporter: Address,
      #[topic]
      pub token: Address,
      pub subscription_id: u64,
      pub live_until_ledger: u32, // Inclusive expiration ledger
  }
  ```
- **Client handling**: If the replacement expiry falls before the supporter's
  intended approval window, prompt them to re-approve the allowance through
  their desired ledger. A zero remainder is revoked and emits no
  `sub_allowance_updated` event.

---

### 2.4. `GoalUpdatedEvent`
Emitted by `CreatorRegistryContract::set_goal` and `DonationContract::set_goal` whenever a creator sets or updates their target funding goal.

- **Topic Schema**: `["goal_upd", creator: Address]`
- **Value Schema**:
  ```rust
  pub struct GoalUpdatedEvent {
      pub creator: Address,         // [topic] Creator wallet address
      pub goal_amount: i128,        // Target funding goal in atomic units (0 clears goal)
      pub updated_at: u64,          // Ledger timestamp of the update
  }
  ```
- **Indexing & Filtering**:
  Indexed by `creator`. The backend automatically syncs `Creator.donationGoal` in PostgreSQL upon receiving this event.

---

### 2.5. `DonationRecordedEvent`
Emitted by `CreatorRegistryContract::record_donation` when lifetime totals are updated following a successful donation.

- **Topic Schema**: `["don_rec", creator: Address]`
- **Value Schema**:
  ```rust
  pub struct DonationRecordedEvent {
      pub creator: Address,         // [topic] Creator wallet address
      pub amount: i128,             // Incremental donation amount
      pub total_donations: i128,    // New cumulative lifetime total donations
      pub donation_count: u32,      // New cumulative lifetime donation count
  }
  ```
- **Indexing & Filtering**:
  Carries current cumulative statistics directly so indexers can maintain up-to-date creator leaderboards without calculating rollups or querying storage.

---

### 2.6. `CreatedEvent`
Emitted by `CreatorRegistryContract::register_creator` when a creator signs up.

- **Topic Schema**: `["created", creator: Address]`
- **Value Schema**:
  ```rust
  pub struct CreatedEvent {
      pub creator: Address,         // [topic] Creator wallet address
      pub username: String,         // Registered unique username
  }
  ```

---

### 2.7. `SubscriptionChargeFailedEvent`
Emitted by `DonationContract::charge_subscription` when a scheduled recurring charge fails (insufficient allowance or balance), instead of silently skipping the subscription.

- **Topic Schema**: `["sub_failed", supporter: Address, creator: Address]`
- **Value Schema**:
  ```rust
  pub struct SubscriptionChargeFailedEvent {
      #[topic]
      pub supporter: Address,       // Supporter wallet address
      #[topic]
      pub creator: Address,         // Creator wallet address
      pub subscription_id: u64,     // ID of the subscription that failed to charge
      pub reason: ChargeError,      // InsufficientAllowance | InsufficientBalance
  }
  ```
- **Indexing & Filtering**:
  Indexed by `supporter` and `creator`. Lets the backend record *why* a charge failed on the `Subscription` row without needing to re-derive it from RPC simulation.

---

### Admin Governance Events (`creator-registry` and `donation`)

Both contracts share an identical multi-signature/timelock proposal lifecycle (see `common::AdminProposal`) and emit the same four topics with the same payload shape. The `proposal_id` counter, and the set of actions a proposal may carry out, are local to whichever contract emitted the event — a `donation` proposal with `proposal_id = 3` is unrelated to a `creator-registry` proposal with the same ID.

#### 2.8. `ProposalCreatedEvent`
Emitted when an admin proposes a high-risk administrative action (e.g. rotating admins, changing the signer threshold, repointing the donation contract).

- **Topic Schema**: `["prop_created", proposer: Address]`
- **Value Schema**:
  ```rust
  pub struct ProposalCreatedEvent {
      pub proposal_id: u64,    // Newly created proposal's ID
      #[topic]
      pub proposer: Address,   // Admin who created the proposal
      pub eta: u64,            // Ledger timestamp after which the proposal becomes executable
      pub action: AdminAction, // The action this proposal will apply
  }
  ```

#### 2.9. `ProposalApprovedEvent`
Emitted each time an admin approves a pending proposal.

- **Topic Schema**: `["prop_approved", admin: Address]`
- **Value Schema**:
  ```rust
  pub struct ProposalApprovedEvent {
      pub proposal_id: u64,
      #[topic]
      pub admin: Address,          // Admin who approved
      pub approvals_count: u32,    // Running total of approvals on this proposal
  }
  ```

#### 2.10. `ProposalExecutedEvent`
Emitted once a proposal has enough approvals and its timelock has elapsed, after its action has been applied.

- **Topic Schema**: `["prop_exec", executor: Address]`
- **Value Schema**:
  ```rust
  pub struct ProposalExecutedEvent {
      pub proposal_id: u64,
      #[topic]
      pub executor: Address,   // Caller that triggered execution
  }
  ```

#### 2.11. `ProposalCancelledEvent`
Emitted when a proposal is cancelled, either unilaterally by its proposer or after `threshold` current admins request cancellation.

- **Topic Schema**: `["prop_cancelled", cancelled_by: Address]`
- **Value Schema**:
  ```rust
  pub struct ProposalCancelledEvent {
      pub proposal_id: u64,
      #[topic]
      pub cancelled_by: Address,
  }
  ```

---

### Donation Guardrail Events (`donation` contract only)

Emitted whenever an admin changes one of the donation contract's operational guardrails, whether through a multisig-approved `AdminAction` or (where one still exists) the single-admin legacy shortcut.

#### 2.12. `AllowedTokenChangedEvent`
Emitted whenever a token is added to or removed from the donation allowlist.

- **Topic Schema**: `["allow_tok", token: Address]`
- **Value Schema**:
  ```rust
  pub struct AllowedTokenChangedEvent {
      #[topic]
      pub token: Address,   // SAC address whose allowlist status changed
      pub allowed: bool,    // true if newly allowed, false if newly disallowed
  }
  ```

#### 2.13. `MinDonationChangedEvent`
Emitted whenever the minimum donation amount guardrail changes.

- **Topic Schema**: `["min_don"]` (no topic fields)
- **Value Schema**:
  ```rust
  pub struct MinDonationChangedEvent {
      pub old_min: i128,
      pub new_min: i128,
  }
  ```

#### 2.14. `MaxDonationChangedEvent`
Emitted whenever the maximum donation amount guardrail changes.

- **Topic Schema**: `["max_don"]` (no topic fields)
- **Value Schema**:
  ```rust
  pub struct MaxDonationChangedEvent {
      pub old_max: i128,
      pub new_max: i128,
  }
  ```

#### 2.15. `PauseChangedEvent`
Emitted whenever the contract is paused or unpaused — covers both the instant `emergency_pause` shortcut and the multisig `Pause`/`Unpause` `AdminAction`s.

- **Topic Schema**: `["pause_chg"]` (no topic fields)
- **Value Schema**:
  ```rust
  pub struct PauseChangedEvent {
      pub paused: bool,
  }
  ```

#### 2.16. `ExecutorChangedEvent`
Emitted whenever the address authorized to call `charge_subscription` changes, whether via the multisig `SetExecutor` action or the single-admin legacy `set_executor` shortcut. `old_executor` is `None` the first time an executor is ever set.

- **Topic Schema**: `["exec_chg", new_executor: Address]`
- **Value Schema**:
  ```rust
  pub struct ExecutorChangedEvent {
      pub old_executor: Option<Address>,
      #[topic]
      pub new_executor: Address,
  }
  ```

---

### Admin Set & Registry Events (`creator-registry` and `donation`)

Emitted when an executed `AdminAction` changes the admin set, the signer threshold, or the cross-contract address. Both contracts emit identical shapes. In `donation` the repointed address is the creator registry; in `creator-registry` it is the donation contract (the field is `new_registry` in both).

#### 2.17. `AdminAddedEvent`
- **Topic Schema**: `["admin_added", admin: Address]`
- **Value Schema**:
  ```rust
  pub struct AdminAddedEvent {
      #[topic]
      pub admin: Address,       // Newly added admin
      pub total_admins: u32,    // Admin count after the change
  }
  ```

#### 2.18. `AdminRemovedEvent`
- **Topic Schema**: `["admin_removed", admin: Address]`
- **Value Schema**:
  ```rust
  pub struct AdminRemovedEvent {
      #[topic]
      pub admin: Address,       // Removed admin
      pub total_admins: u32,    // Admin count after the change
  }
  ```

#### 2.19. `ThresholdChangedEvent`
- **Topic Schema**: `["threshold_chg"]` (no topic fields)
- **Value Schema**:
  ```rust
  pub struct ThresholdChangedEvent {
      pub old_threshold: u32,
      pub new_threshold: u32,
  }
  ```

#### 2.20. `RegistryChangedEvent`
Also emitted by the registry's legacy single-admin `set_donation_contract`.

- **Topic Schema**: `["registry_chg", new_registry: Address]`
- **Value Schema**:
  ```rust
  pub struct RegistryChangedEvent {
      pub old_registry: Option<Address>,   // None if never set
      #[topic]
      pub new_registry: Address,
  }
  ```

---

## 3. Backend Event Consumption & Reconciliation

The backend's `SorobanEventListener` (`backend/src/services/sorobanEventListener.ts`) consumes these events using Soroban RPC cursor pagination.

### 3.1. Reconciling Subscriptions Without Polling
When a supporter cancels a subscription directly through contract interaction, the listener receives `SubscriptionCancelledEvent`:

```typescript
case "sub_cancelled": {
  const subId = Number(value.subscription_id);
  eventBus.emit(SUBSCRIPTION_CANCELLED_EVENT, payload);

  // Automatically deactivates subscription in DB:
  await prisma.subscription.updateMany({
    where: { onChainId: subId },
    data: { active: false },
  });
}
```

This eliminates the need for periodic RPC polling passes to check whether each subscription is still active.

### 3.2. Reconciling Creator Goals
When a creator updates their goal on-chain, `GoalUpdatedEvent` is ingested and updates the creator model:

```typescript
case "goal_upd": {
  await prisma.creator.updateMany({
    where: { walletAddress: creatorAddress },
    data: { donationGoal: Number(value.goal_amount) },
  });
}
```

### 3.3. Reconciling Donations Without Polling
A `DonatedEvent` is the authoritative record of a one-off donation. When the listener ingests one it resolves the creator by the event's creator wallet (skipping, with a log line, events for unknown creators), converts the stroop amount to whole units, and writes or updates the matching `Donation` row setting `verified: true`.

Rows may exist in two states:

- A hash-bearing `POST /api/donations` report is stored provisionally with `verified: false`. Such a report never touches goal progress or sends email — otherwise an unauthenticated caller could inflate a creator's goals and use the endpoint as a spam relay.
- The listener is the only writer allowed to flip a row to `verified: true`. It matches the row by `rpcEventId` (`evt.id`) or the `(transactionHash, operationIndex, eventIndex)` identity, backfills the authoritative `amount`/`currency`/`senderAddress`/`creatorId`, applies the donation to the creator's active same-currency goals, and sends the donation and goal-reached notifications.

The verification flip is a conditional `updateMany({ where: { verified: false } })`, so a replayed lookback after a restart — or a concurrent client report — is a no-op rather than a double-count. Donations made entirely on-chain (with no client report) are created directly in the verified state.

### 3.4. Recording Subscription Charge Failures
When a scheduled recurring charge fails on-chain, the listener receives `SubscriptionChargeFailedEvent` and persists the decoded failure reason onto the subscription so the backend (and anything reading `Subscription.lastError`) can tell an allowance problem from a balance problem, without the executor having to be the one that observed the failure — the executor's own tick may be lagging, or the charge may have failed from a path other than this backend's executor key:

```typescript
case "sub_failed": {
  const reason = normalizeChargeErrorReason(value.reason);
  eventBus.emit(SUBSCRIPTION_CHARGE_FAILED_EVENT, payload);

  await prisma.subscription.updateMany({
    where: { onChainId: subId },
    data: { lastError: `${reason}: on-chain charge failed (${evt.txHash})` },
  });
}
```

### 3.5. Unreconciled Events: Creator Registration and Admin Governance/Guardrails
`created`, the four admin-set/registry topics (`admin_added`, `admin_removed`, `threshold_chg`, `registry_chg`), the four proposal-lifecycle topics (`prop_created`, `prop_approved`, `prop_exec`, `prop_cancelled`), and the five guardrail-change topics (`allow_tok`, `min_don`, `max_don`, `pause_chg`, `exec_chg`) are emitted on-chain but have no corresponding `case` in `processEvent`'s `switch` — they fall through to `default` and are neither published on `eventBus` nor written to Postgres. There is no `AdminProposal` table in `schema.prisma`, so that state currently has no off-chain home to reconcile into; a creator's registration is instead captured by the backend's own `POST`-time username write, not by observing `created`.

### 3.6. Real-Time Dashboard Updates (SSE)
All processed events are published onto `eventBus` and broadcast via Server-Sent Events at `GET /api/events` to any open creator dashboards or activity monitors.
