# Session replay credentials

Test-only Helm chart for an explicitly authorized isolated replay namespace. It copies the named Secrets from a source namespace using server-side Helm lookup, keeping their data on the cluster. It does not copy application state or modify the source namespace. Supply sourceNamespace and secretNames as private deployment values. Deploy only into a fresh test namespace and remove the credential release with the test deployment afterward. Never publish rendered Secrets or Helm release data.
