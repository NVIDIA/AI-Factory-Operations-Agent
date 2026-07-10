# Mosaic Security Model

Mosaic separates observation from mutation at the tool, credential, and session layers. Model instructions improve tool selection, but they are not a security boundary.

## Deployment Default

`modules.edit.enabled` defaults to `false`. The default deployment exposes read-only Kubernetes and BCM tools and does not install the edit Kubernetes credential, BCM admin tool, or remote SSH tool.

When the Edit module is enabled, every new interactive conversation still starts in View mode. Access is selected per conversation:

| Mode | Read-only tools | Safe diagnostics | Mutating tools |
| --- | --- | --- | --- |
| View | Automatic | Automatic | Blocked |
| Edit | Automatic | Automatic | Requires approval when `modules.edit.hitl=true` |
| Auto | Automatic | Automatic | Runs without approval after the user accepts the warning |

Automated alert and cluster-health sessions are always View-only. They cannot be changed to Edit or Auto.

For native Slack, `openclaw.slack.allowedUserIds` remains the messaging allowlist for DMs, group DMs, and channel mentions. `openclaw.slack.editUserIds` is narrower: those verified users receive Edit and approve their own mutations through Slack buttons; every other allowed Slack user remains in View.

Setting `modules.edit.hitl=false` also removes approvals from Edit mode. Keep the default `true` unless every user permitted to select Edit is trusted to make changes directly.

## Kubernetes Boundaries

Read and write operations use separate tools and Kubernetes credentials:

- `run_kubectl` uses the chart's read-only ServiceAccount. Its ClusterRole grants `get`, `list`, and `watch` for the supported operational resources. The tool rejects Secrets, interactive access, credential overrides, and shell syntax.
- `run_kubectl_admin` is installed only when Kubernetes editing is enabled. It accepts exact kubectl argv and optional standard input, executes without a local shell, requires approval in Edit, and skips approval in Auto. Credential overrides remain blocked so the installer-selected cluster and identity stay authoritative.
- Its default ClusterRole permits `create`, `delete`, `patch`, and `update` for ConfigMaps, Pods, Services, Deployments, DaemonSets, StatefulSets, Jobs, and CronJobs, plus `create` on `pods/exec`. An operator can replace that role through `modules.edit.kubernetes.existingClusterRole` to define the actual administrative scope.

Kubernetes RBAC remains authoritative in every mode. Auto bypasses approval, not RBAC or request validation.

## BCM Boundaries

The read-only and administrative BCM paths use separate identities and tools:

- `bcm_execute_cmsh` uses the dedicated BCM read-only identity and never requests approval.
- `bcm_execute_cmsh_admin`, `bcm_add_note`, and `bcm_remove_note` are installed only when BCM editing is enabled. They are blocked in View, approval-gated in Edit, and automatic in Auto.

BCM's configured profile remains authoritative. Enabling BCM administration requires an operator-provided credential with the intended cluster permissions.

## Diagnostic Commands And SSH

View mode can run a bounded set of read-only diagnostic commands locally through OpenShell or on configured hosts through `run_remote_ssh`. The shared policy in `diagnostic-policy.ts` validates the executable and every argument. It covers common hardware, operating-system, networking, and Slurm inspection commands such as `nvidia-smi`, `ipmitool mc info`, `journalctl`, `squeue`, and `scontrol show`.

The diagnostic policy rejects executable paths, shell operators, quoting, redirection, command substitution, nested SSH, arbitrary programs, and known mutating flags. Commands outside this policy are blocked in View and use Edit or Auto handling when available.

Remote SSH has additional constraints:

- Hosts are installer-defined aliases; the model cannot supply a destination.
- User, port, private key, and known-hosts data come from the Helm configuration and Secret.
- SSH option and identity overrides are not accepted.
- The remote command is transported as validated argv, not an arbitrary shell program.

Read-only execution is not a confidentiality boundary. A diagnostic command can read anything allowed by its operating-system or SSH identity. Operators must provision least-privilege identities and limit enrolled hosts accordingly.

## Approval And Auto

With `modules.edit.hitl=true`, Edit-mode mutations pause before execution and expose the exact operation to the user. Denial, expiration, or an unavailable approval service fails closed. Approval is scoped to one operation and does not change the conversation mode.

Auto presents a warning before activation, then executes the same validated mutation tools without approval. The warning is a user acknowledgement, not the enforcement mechanism. Server-side session state, tool validators, Kubernetes RBAC, BCM credentials, configured SSH hosts, and audit records continue to apply.

## Automation, Sandboxing, And Audit

- Scheduled cluster checks and alert-triggered sessions are marked as automation and reject all mutating tools regardless of requested mode.
- General local command execution remains inside OpenShell. View permits only the diagnostic allowlist; other commands require an interactive Edit or Auto session.
- Tool calls, approvals, denials, and results are recorded in the Mosaic audit stream.
- Secrets remain Kubernetes Secrets and are mounted only into the workloads that need them. They are not supplied through prompts or committed values.

## Operator Responsibility

Enabling Edit expands Mosaic's authority. Before enabling it, review the generated RBAC, any custom ClusterRole, BCM profiles, SSH host list, mounted credentials, and who can access the Mosaic UI. Auto should be restricted to users trusted to exercise those configured permissions without per-operation review.
