{{- define "mosaic-stack.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "mosaic-stack.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "mosaic-stack.labels" -}}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: mosaic
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{- define "mosaic-stack.image" -}}
{{- printf "%s:%s" .repository .tag -}}
{{- end -}}

{{- define "mosaic-stack.pullSecrets" -}}
{{- $secrets := list -}}
{{- $names := dict -}}
{{- range .Values.global.imagePullSecrets }}
{{- if and (kindIs "map" .) (hasKey . "name") }}
{{- if not (hasKey $names .name) }}
{{- $secrets = append $secrets . -}}
{{- $_ := set $names .name true -}}
{{- end }}
{{- else }}
{{- $secrets = append $secrets . -}}
{{- end }}
{{- end }}
{{- if and .Values.global.registryCredentials.create (not (hasKey $names .Values.global.registryCredentials.name)) }}
{{- $secrets = append $secrets (dict "name" .Values.global.registryCredentials.name) -}}
{{- end }}
{{- $secrets | toJson -}}
{{- end -}}

{{- define "mosaic-stack.imagePullSecrets" -}}
{{- $secrets := include "mosaic-stack.pullSecrets" . | fromJsonArray -}}
{{- if $secrets }}
imagePullSecrets:
{{ toYaml $secrets | indent 2 }}
{{- end }}
{{- end -}}

{{- define "mosaic-stack.nodeSelector" -}}
{{- if .Values.global.nodeSelector }}
nodeSelector:
{{ toYaml .Values.global.nodeSelector | indent 2 }}
{{- end }}
{{- end -}}

{{- define "mosaic-stack.tolerations" -}}
{{- with .Values.global.tolerations }}
tolerations:
{{ toYaml . | indent 2 }}
{{- end }}
{{- end -}}

{{- define "mosaic-stack.clusterScopedBase" -}}
{{- $base := printf "%s-%s" (include "mosaic-stack.fullname" .) .Release.Namespace -}}
{{- printf "%s-%s" ($base | trunc 42 | trimSuffix "-") (sha256sum $base | trunc 8) -}}
{{- end -}}

{{- define "mosaic-stack.bcmEnabled" -}}
{{- $bcm := .Values.modules.bcm | default dict -}}
{{- $moduleEnabled := true -}}
{{- if hasKey $bcm "enabled" -}}{{- $moduleEnabled = $bcm.enabled -}}{{- end -}}
{{- if and $moduleEnabled (or .Values.bcmMcp.enabled .Values.externalServices.bcmMcp.enabled) -}}true{{- else -}}false{{- end -}}
{{- end -}}

{{- define "mosaic-stack.slurmEvidenceEnabled" -}}
{{- $slurm := .Values.modules.slurm | default dict -}}
{{- $collector := $slurm.evidenceCollector | default dict -}}
{{- $collectorEnabled := true -}}
{{- if hasKey $collector "enabled" -}}{{- $collectorEnabled = $collector.enabled -}}{{- end -}}
{{- if and ($slurm.enabled | default false) $collectorEnabled (ne (include "mosaic-stack.slurmBcmEnabled" .) "true") -}}true{{- else -}}false{{- end -}}
{{- end -}}

{{- define "mosaic-stack.slurmBcmEnabled" -}}
{{- $slurm := .Values.modules.slurm | default dict -}}
{{- $backend := $slurm.backend | default "auto" -}}
{{- if and ($slurm.enabled | default false) (ne $backend "vanilla") (eq (include "mosaic-stack.bcmEnabled" .) "true") -}}true{{- else -}}false{{- end -}}
{{- end -}}

{{- define "mosaic-stack.llmUpstreamBaseUrl" -}}
{{- if eq .Values.llm.mode "vllm" -}}
{{- printf "http://%s:%v/v1" .Values.llm.vllm.name .Values.llm.vllm.port -}}
{{- else -}}
{{- .Values.llm.external.baseUrl -}}
{{- end -}}
{{- end -}}

{{- define "mosaic-stack.llmBaseUrl" -}}
{{- if .Values.llm.requestCompatibility.enabled -}}
{{- printf "http://%s:%v/v1" .Values.llm.requestCompatibility.name .Values.llm.requestCompatibility.port -}}
{{- else -}}
{{- include "mosaic-stack.llmUpstreamBaseUrl" . -}}
{{- end -}}
{{- end -}}

{{- define "mosaic-stack.llmModel" -}}
{{- if eq .Values.llm.mode "vllm" -}}
{{- .Values.llm.vllm.servedModelName -}}
{{- else -}}
{{- .Values.llm.external.model -}}
{{- end -}}
{{- end -}}

{{- define "mosaic-stack.vllmTensorParallelSize" -}}
{{- default .Values.llm.vllm.gpuCount .Values.llm.vllm.tensorParallelSize -}}
{{- end -}}

{{- define "mosaic-stack.openshellFullname" -}}
{{- if .Values.openshell.fullnameOverride -}}
{{- .Values.openshell.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default "openshell" .Values.openshell.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "mosaic-stack.openshellGatewayEndpoint" -}}
{{- default (printf "http://%s:%v" (include "mosaic-stack.openshellFullname" .) .Values.openshell.server.sshGatewayPort) .Values.openclaw.nemoclaw.gatewayEndpoint -}}
{{- end -}}
