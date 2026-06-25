# Slurm RCA

Mosaic's Slurm path is evidence based. It reads available Slurm accounting output, scheduler state, and mounted job logs.

For automatic failed-job pickup, run the Slurm watcher on a login/head node where `sacct` and `scontrol` already work. The watcher polls recent failed jobs and posts an alert to Mosaic. The alert prompt then routes to the Slurm RCA skill, which uses the evidence collector and any available Slurm commands/logs to find the root cause.

```bash
export PATH=/cm/local/apps/slurm/current/bin:/cm/local/apps/slurm/current/sbin:$PATH
export SLURM_CONF=/cm/shared/apps/slurm/etc/slurm/slurm.conf
node scripts/slurm_failure_watcher.mjs --mosaic-url http://mosaic.example:3000
```

When Slurm is enabled, the chart deploys a read-only Slurm evidence collector. The collector mounts host filesystems read-only inside the collector pod and exposes bounded tools to OpenClaw, keeping broad filesystem access out of the LLM sandbox. The Slurm skill first calls `slurm_job_evidence`, then tries read-only Slurm commands such as `sacct` and `scontrol` when they are available, then searches any mounted accounting exports, scheduler logs, and job stdout/stderr logs.

Each source is optional. If `sacct` is unavailable, or if one log directory does not exist on a site, the skill continues with the remaining mounted evidence. A valid RCA should report the concrete evidence it found and explicitly name missing evidence only when that evidence is needed to explain the failure.

Default evidence candidates:

- `/var/log`
- `/cm/shared/slurm-logs`
- `/cm/shared`
- `/slurm/logs`
- `/slurm/accounting`
- `/etc/slurm`
- `/cm/shared/apps/slurm/etc`
- `/run/log/journal`
- `/var/log/journal`

Sites with non-standard Slurm paths can adjust `slurmEvidenceCollector.roots`; the default install already attempts the common locations above.

## Slurm-Only Invocation With Pyxis

On clusters where Mosaic should be used from Slurm instead of a Kubernetes UI session, run the packaged Mosaic CLI in a Pyxis/Enroot container and point it at a Mosaic service URL:

```bash
export MOSAIC_URL=http://mosaic.example:3000
export MOSAIC_PYXIS_IMAGE=<registry>/mosaic-ui:<tag>
scripts/run_mosaic_slurm_pyxis.sh "job 123 failed. Use the Slurm logs and summarize the root cause."
```

Pyxis adds the `--container-image`, `--container-mount-home`, `--container-workdir`, and `--container-env` flags to `sbatch`/`srun`. The script keeps the Slurm job ordinary: stdout still lands wherever the site's Slurm default writes it, and the failed-job watcher/RCA path does not require users to add an output flag.
