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
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "mosaic-stack.image" -}}
{{- printf "%s:%s" .repository .tag -}}
{{- end -}}

{{- define "mosaic-stack.imagePullSecrets" -}}
{{- $secrets := list -}}
{{- range .Values.global.imagePullSecrets }}
{{- $secrets = append $secrets . -}}
{{- end }}
{{- if .Values.registryCredentials.create }}
{{- $secrets = append $secrets (dict "name" .Values.registryCredentials.name) -}}
{{- end }}
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

{{- define "mosaic-stack.clusterScopedBase" -}}
{{- $base := printf "%s-%s" (include "mosaic-stack.fullname" .) .Release.Namespace -}}
{{- printf "%s-%s" ($base | trunc 42 | trimSuffix "-") (sha256sum $base | trunc 8) -}}
{{- end -}}

{{- define "mosaic-stack.llmBaseUrl" -}}
{{- if eq .Values.llm.mode "vllm" -}}
{{- printf "http://%s:%v/v1" .Values.llm.vllm.name .Values.llm.vllm.port -}}
{{- else -}}
{{- .Values.llm.external.baseUrl -}}
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
