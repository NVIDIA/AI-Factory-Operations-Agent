# Slurm RCA

The AI Factory Operations Agent Slurm workflow is evidence based. It reads available Slurm accounting output, scheduler state, and mounted job logs.

When Slurm and Base Command Manager are enabled, `slurm_job_evidence` uses Base Command Manager WLM metadata and reads only the bounded stdout/stderr paths recorded for that job, without deploying the filesystem collector. The model cannot provide arbitrary file paths to the adapter. Otherwise, the chart deploys the read-only vanilla collector, which mounts host filesystems read-only and keeps broad filesystem access out of the LLM sandbox.

Each source is optional. If `sacct` is unavailable, or if one log directory does not exist on a site, the skill continues with the remaining mounted evidence. A valid RCA should report the concrete evidence it found and explicitly name missing evidence only when that evidence is needed to explain the failure.

Default evidence candidates:

- `/var/log`
- `/cm/shared`
- `/slurm`
- `/etc/slurm`
- `/cm/shared/apps/slurm/etc`
- `/run/log/journal`
- `/var/log/journal`

Sites with non-standard Slurm paths can adjust `slurmEvidenceCollector.roots`; the default install already attempts the common locations above.

## Job logs in Loki

To investigate Slurm jobs through Loki without head-node access, configure your
logging platform to collect job output and Slurm daemon logs. Include job IDs and
node names as labels or searchable fields so Mosaic can correlate logs with job
accounting and node metrics. Collecting Kubernetes logs alone does not provide
Slurm job logs.

[Connect Mosaic to Loki](installation.md#read-only-loki-logs), then verify access
by asking for logs from a known job ID and its execution time range.
