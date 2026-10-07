// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const chart = 'oci://nvcr.io/0948643769302270/afoa-release/mosaic-stack';
const modules = {
  kubernetes: 'Kubernetes', observability: 'Prometheus and Alertmanager', grafana: 'Grafana',
  bcm: 'Base Command Manager', slurm: 'Slurm', diagnostics: 'Hardware diagnostics',
  research: 'Research', terminal: 'Browser terminal', edit: 'Guarded Kubernetes edits', clusters: 'Cluster monitoring',
};
const fields = {
  namespace: ['Namespace', 'mosaic'], pullSecret: ['NGC pull Secret', 'nvcr-image-pull-secret'],
  version: ['Pinned chart version (optional)', '', 'e.g. 0.0.1'],
  baseUrl: ['Inference API base URL', '', 'https://inference.example.com/v1'],
  model: ['Inference model', '', 'Your served model name'], llmSecret: ['Inference Secret (apiKey)', 'mosaic-external-llm'],
  prometheusUrl: ['Prometheus URL', '', 'http://prometheus:9090'],
  alertmanagerUrl: ['Alertmanager URL', '', 'http://alertmanager:9093'],
  grafanaUrl: ['Grafana URL, including serving path', '', 'https://grafana.example.com/grafana'],
  grafanaUid: ['Prometheus datasource UID', 'prometheus'], grafanaSecret: ['Grafana Secret (username, password)', 'mosaic-grafana-auth'],
  bcmHead: ['BCM SSH head host', '', 'user@bcm-head.example.com'], bcmSecret: ['BCM SSH Secret (id_ecdsa)', 'bcm-host-ssh-key'],
  evidenceRoot: ['Slurm evidence directory on the collector node', '', '/slurm'],
  evidenceNode: ['Slurm collector node hostname', '', 'slurm-login-node'],
  corpus: ['Research corpus directory on the node', '', '/cm/shared/iraop-corpus'],
  storageClass: ['StorageClass override (optional)', '', 'Leave empty to use the cluster default'],
};
export function enabledModules(state) {
  const enabled = new Set(state.modules || []);
  if (enabled.has('diagnostics') || (enabled.has('slurm') && state.slurmBackend !== 'vanilla')) enabled.add('bcm');
  if (['terminal', 'edit', 'clusters'].some(name => enabled.has(name))) enabled.add('kubernetes');
  return enabled;
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function buildCommand(state) {
  const enabled = enabledModules(state);
  const value = key => state[key]?.trim() || fields[key][1] || `<${fields[key][0]}>`;
  const version = state.version?.trim() ? `--version ${quote(state.version.trim())}` : state.channel === 'stable' ? '' : '--devel';
  const args = [version, `--namespace ${quote(value('namespace'))}`, `--set ${quote(`global.imagePullSecrets[0].name=${value('pullSecret')}`)}`].filter(Boolean);
  const set = (key, val, string = false) => args.push(`--set${string ? '-string' : ''} ${quote(`${key}=${String(val).replaceAll('\\', '\\\\').replaceAll(',', '\\,')}`)}`);
  set('llm.mode', state.inference === 'external' ? 'external' : 'vllm');
  if (state.inference === 'external') {
    set('llm.external.baseUrl', value('baseUrl'), true); set('llm.external.model', value('model'), true);
    set('llm.external.existingSecret', value('llmSecret'), true);
  }
  for (const name of ['ui', 'execution', ...Object.keys(modules)]) set(`modules.${name}.enabled`, ['ui', 'execution'].includes(name) || enabled.has(name));
  if (enabled.has('observability')) {
    set('observability.prometheusUrl', value('prometheusUrl'), true);
    set('observability.alertmanagerUrl', value('alertmanagerUrl'), true);
  }
  if (enabled.has('grafana')) {
    set('observability.grafanaUrl', value('grafanaUrl'), true); set('observability.grafanaDatasourceUid', value('grafanaUid'), true);
    set('observability.grafanaAuth.existingSecret', value('grafanaSecret'), true);
  }
  if (enabled.has('bcm')) {
    set('bcmMcp.enabled', true); set('bcmMcp.mode', 'ssh-adapter');
    set('bcmMcp.headHost', value('bcmHead'), true); set('bcmMcp.hostSshKeySecretName', value('bcmSecret'), true);
  }
  if (enabled.has('slurm')) {
    set('modules.slurm.backend', state.slurmBackend || 'bcm');
    if (state.slurmBackend === 'vanilla') {
      args.push(`--set-json ${quote(`slurmEvidenceCollector.roots=${JSON.stringify([value('evidenceRoot')])}`)}`);
      args.push(`--set-json ${quote(`slurmEvidenceCollector.nodeSelector=${JSON.stringify({'kubernetes.io/hostname': value('evidenceNode')})}`)}`);
    }
  }
  if (enabled.has('research')) {
    set('modules.research.secrets.create', false);
    set('researchAgent.iraop.config.NVIDIA_CHAT_MODEL', state.inference === 'external' ? value('model') : state.inference === 'ultra' ? 'nemotron-ultra-550b' : 'nemotron-super-120b', true);
    set('researchAgent.iraop.corpus.hostPath', value('corpus'), true);
  }
  if (enabled.has('edit')) set('modules.edit.hitl', true);
  if (state.storageClass?.trim()) for (const key of ['openclaw.pvc.storageClassName', 'mosaicUi.auditPvc.storageClassName']) set(key, state.storageClass.trim(), true);
  if (state.sandboxInstalled) set('agentSandbox.install', false);
  let target = quote(chart);
  let prefix = '';
  if (state.inference !== 'external') {
    const profile = state.inference === 'ultra' ? 'vllm-ultra-4gpu.yaml' : 'vllm-super-1gpu.yaml';
    prefix = `MOSAIC_CHART_WORKDIR=$(mktemp -d)\nhelm pull ${quote(chart)} ${version} --untar --untardir "$MOSAIC_CHART_WORKDIR"\n\n`;
    target = '"$MOSAIC_CHART_WORKDIR/mosaic-stack"';
    if (version) args.shift();
    args.unshift(`-f "$MOSAIC_CHART_WORKDIR/mosaic-stack/profiles/${profile}"`);
  }
  args.push('--atomic', '--wait', `--timeout ${state.inference === 'external' ? '12m' : '30m'}`);
  return prefix + `helm upgrade --install mosaic ${target} \\\n  ${args.join(' \\\n  ')}`;
}

const root = typeof document === 'undefined' ? null : document.querySelector('#install-command-builder');
if (root) {
  const state = {inference: 'external', channel: 'devel', slurmBackend: 'bcm', modules: ['kubernetes']};
  const form = document.createElement('form'); form.addEventListener('submit', event => event.preventDefault());
  const options = document.createElement('fieldset'); options.innerHTML = '<legend>Installation options</legend>';
  function select(key, label, choices) {
    const wrapper = document.createElement('label'); wrapper.textContent = label;
    const input = document.createElement('select'); input.name = key;
    for (const [value, text] of choices) input.add(new Option(text, value));
    input.value = state[key]; input.addEventListener('change', () => {state[key] = input.value; update(true);});
    wrapper.append(input); return wrapper;
  }
  const optionBody = document.createElement('div'); optionBody.className = 'builder-settings'; options.append(optionBody);
  optionBody.append(select('inference', 'Inference', [['external', 'Existing endpoint'], ['super', 'On-prem: Nemotron Super (1 GPU)'], ['ultra', 'On-prem: Nemotron Ultra (4 Blackwell GPUs)']]),
    select('channel', 'Chart channel', [['devel', 'Latest development'], ['stable', 'Latest stable']]));
  form.append(options);
  const moduleGroup = document.createElement('fieldset'); moduleGroup.innerHTML = '<legend>Modules</legend><p>UI and execution are always enabled. Required dependencies are selected automatically.</p>';
  const buttons = document.createElement('div'); buttons.className = 'builder-modules';
  const inputs = new Map();
  for (const [name, label] of Object.entries(modules)) {
    const wrapper = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.name = name;
    input.addEventListener('change', () => {const requested = new Set(state.modules); input.checked ? requested.add(name) : requested.delete(name); state.modules = [...requested]; update(true);});
    wrapper.append(input, document.createTextNode(label)); buttons.append(wrapper); inputs.set(name, input);
  }
  moduleGroup.append(buttons); form.append(moduleGroup);
  const settings = document.createElement('fieldset'); settings.innerHTML = '<legend>Connection settings</legend>';
  const settingsBody = document.createElement('div'); settingsBody.className = 'builder-settings'; settings.append(settingsBody); form.append(settings);
  const prerequisites = document.createElement('p'); prerequisites.className = 'builder-prerequisites'; form.append(prerequisites);
  const heading = document.createElement('h3'); heading.textContent = 'Generated command';
  const output = document.createElement('pre'); const code = document.createElement('code'); output.append(code);
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy command';
  const status = document.createElement('span'); status.setAttribute('role', 'status');
  copy.addEventListener('click', async () => {try {await navigator.clipboard.writeText(code.textContent); status.textContent = 'Copied';} catch {status.textContent = 'Select the command text to copy it.';}});
  const sizing = document.createElement('section'); sizing.className = 'builder-sizing';
  let catalog;
  root.replaceChildren(form, sizing, heading, copy, status, output);
  fetch(new URL('sizing-data.json', import.meta.url)).then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }).then(data => {catalog = data; update(false);}).catch(error => {sizing.textContent = `Deployment footprint unavailable: ${error.message}`;});
  function update(renderSettings) {
    const enabled = enabledModules(state);
    for (const [name, input] of inputs) {input.checked = enabled.has(name); input.disabled = enabled.has(name) && !state.modules.includes(name);}
    if (renderSettings) {
      settingsBody.replaceChildren();
      const keys = ['namespace', 'pullSecret', 'version'];
      if (state.inference === 'external') keys.push('baseUrl', 'model', 'llmSecret');
      if (enabled.has('observability')) keys.push('prometheusUrl', 'alertmanagerUrl');
      if (enabled.has('grafana')) keys.push('grafanaUrl', 'grafanaUid', 'grafanaSecret');
      if (enabled.has('slurm')) settingsBody.append(select('slurmBackend', 'Slurm integration', [['bcm', 'Through BCM'], ['vanilla', 'Standalone Slurm']]));
      if (enabled.has('bcm')) keys.push('bcmHead', 'bcmSecret');
      if (enabled.has('slurm') && state.slurmBackend === 'vanilla') keys.push('evidenceRoot', 'evidenceNode');
      if (enabled.has('research')) keys.push('corpus');
      keys.push('storageClass');
      for (const key of keys) {
        const [label, initial, placeholder] = fields[key]; const wrapper = document.createElement('label'); wrapper.textContent = label;
        const input = document.createElement('input'); input.name = key; input.value = state[key] ?? initial; input.placeholder = placeholder || '';
        input.addEventListener('input', () => {state[key] = input.value; update(false);}); wrapper.append(input); settingsBody.append(wrapper);
      }
      const wrapper = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!state.sandboxInstalled;
      input.addEventListener('change', () => {state.sandboxInstalled = input.checked; update(false);}); wrapper.append(input, document.createTextNode('Cluster already has a compatible agent-sandbox installation')); settingsBody.append(wrapper);
    }
    const notes = ['Complete namespace and NGC access setup first. Replace all <placeholders> before running.'];
    if (state.inference === 'external') notes.push(`Create ${state.llmSecret || fields.llmSecret[1]} with key apiKey.`);
    if (enabled.has('grafana')) notes.push(`Create ${state.grafanaSecret || fields.grafanaSecret[1]} with keys username and password.`);
    if (enabled.has('bcm')) notes.push(`Create ${state.bcmSecret || fields.bcmSecret[1]} with key id_ecdsa; its SSH identity must bootstrap the read-only CMSH user.`);
    if (enabled.has('research')) notes.push('Create iraop-secrets with NVIDIA_API_KEY, NVIDIA_CHAT_API_KEY and IRAOP_API_KEY; prepare the corpus directory.');
    if (state.inference !== 'external') notes.push('Verify GPU, memory and model cache requirements in the on-prem inference section.');
    prerequisites.textContent = notes.join(' '); code.textContent = buildCommand(state); status.textContent = '';
    if (catalog) renderSizing(sizing, catalog, state, enabled);
  }
  update(true);
}
export function selectedComponents(catalog, state, enabled) {
  const selections = [...enabled].filter(name => name !== 'slurm');
  if (enabled.has('slurm')) selections.push(state.slurmBackend === 'vanilla' ? 'slurm-vanilla' : 'slurm');
  if (!state.sandboxInstalled) selections.push('sandbox');
  if (state.inference !== 'external') selections.push(state.inference);
  const components = {};
  for (const group of [catalog.base, ...selections.map(name => catalog.variants[name])]) {
    for (const [key, component] of Object.entries(group)) {
      const previous = components[key];
      components[key] = {...component};
      for (const field of ['containers', 'initContainers']) {
        if (component[field]) components[key][field] = Object.values(Object.fromEntries([...(previous?.[field] || []), ...component[field]].map(container => [container.name, container])));
      }
    }
  }
  return Object.values(components);
}

export function quantity(value, resource) {
  const match = String(value).match(/^([0-9.]+)([a-zA-Z]*)$/);
  if (!match) throw new Error(`Unsupported resource quantity: ${value}`);
  const factors = resource === 'cpu' ? {'': 1, m: .001, u: .000001, n: .000000001} : {'': 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, k: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4};
  if (!(match[2] in factors)) throw new Error(`Unsupported resource unit: ${match[2]}`);
  return Number(match[1]) * factors[match[2]];
}

export function footprint(component, field, resource) {
  const amount = container => quantity(container.resources[field]?.[resource] || 0, resource);
  const running = (component.containers || []).reduce((sum, container) => sum + amount(container), 0);
  const initializing = Math.max(0, ...(component.initContainers || []).map(amount));
  return Math.max(running, initializing) * component.count;
}

export function renderSizing(panel, catalog, state, enabled) {
  panel.replaceChildren();
  const title = document.createElement('h3'); title.textContent = 'Deployment footprint'; panel.append(title);
  const note = document.createElement('p');
  note.textContent = `Rendered chart ${catalog.version}, source ${catalog.revision.slice(0, 12)}. Configured resources, not measured capacity. Only valid for this source version; channel, pinned-version and site overrides may differ.`;
  panel.append(note);
  const components = selectedComponents(catalog, state, enabled);
  const table = document.createElement('table');
  const header = table.createTHead().insertRow();
  for (const text of ['Component', 'CPU request / limit', 'Memory request / limit', 'GPU request / limit', 'Storage']) {const cell = document.createElement('th'); cell.textContent = text; header.append(cell);}
  const body = table.createTBody();
  const format = (amount, resource) => resource === 'memory' ? `${Number((amount / 1024 ** 3).toFixed(3))} GiB` : `${Number(amount.toFixed(3))}`;
  const warnings = ['Dynamic execution sandboxes, existing inference services, observability backends and corpus storage are not included. GPU memory compatibility and workload concurrency require separate validation.'];
  for (const component of components) {
    const row = body.insertRow();
    row.insertCell().textContent = `${component.name}${component.kind === 'DaemonSet' ? ' (per matching node)' : component.kind === 'Job' ? ' (setup job)' : ''}`;
    for (const resource of ['cpu', 'memory', 'nvidia.com/gpu']) {
      const values = ['requests', 'limits'].map(field => {
        const containers = [...(component.containers || []), ...(component.initContainers || [])];
        const amount = footprint(component, field, resource);
        if (resource !== 'nvidia.com/gpu' && containers.some(container => container.resources[field]?.[resource] === undefined)) return amount ? `≥ ${format(amount, resource)}` : 'Unspecified';
        return format(amount, resource);
      });
      row.insertCell().textContent = component.kind === 'PersistentVolumeClaim' ? '—' : values.join(' / ');
    }
    const storage = typeof component.storage === 'string' ? [component.storage] : component.storage || [];
    row.insertCell().textContent = storage.length ? format(storage.reduce((sum, value) => sum + quantity(value, 'memory'), 0) * component.count, 'memory') : '—';
    if (Object.keys(component.nodeSelector || {}).length) warnings.push(`${component.name} placement: ${JSON.stringify(component.nodeSelector)}.`);
  }
  const subtotal = body.insertRow(); subtotal.insertCell().textContent = 'Known fixed-workload subtotal (partial)';
  const fixed = components.filter(component => ['Deployment', 'StatefulSet', 'Sandbox'].includes(component.kind));
  for (const resource of ['cpu', 'memory', 'nvidia.com/gpu']) {
    subtotal.insertCell().textContent = ['requests', 'limits'].map(field => `≥ ${format(fixed.reduce((sum, component) => sum + footprint(component, field, resource), 0), resource)}`).join(' / ');
  }
  subtotal.insertCell().textContent = format(components.reduce((sum, component) => {
    const storage = typeof component.storage === 'string' ? [component.storage] : component.storage || [];
    return sum + storage.reduce((amount, value) => amount + quantity(value, 'memory'), 0) * component.count;
  }, 0), 'memory');
  warnings.push('Subtotal excludes setup jobs and per-node collectors; unspecified requests/limits are not counted. PVC subtotal excludes pre-existing and dynamically allocated storage.');
  if (enabled.has('research') && !catalog.researchAvailable) warnings.push('Research dependency workloads are unavailable in this documentation build; the footprint is incomplete.');
  if (state.inference !== 'external') warnings.push('Model-server GPU requests must fit on one compatible node. Storage includes model-cache PVC capacity, not download size.');
  const summary = document.createElement('p');
  summary.textContent = `Known fixed-workload requests: ≥ ${format(fixed.reduce((sum, component) => sum + footprint(component, 'requests', 'cpu'), 0), 'cpu')} CPU cores; ≥ ${format(fixed.reduce((sum, component) => sum + footprint(component, 'requests', 'memory'), 0), 'memory')} memory; ≥ ${format(fixed.reduce((sum, component) => sum + footprint(component, 'requests', 'nvidia.com/gpu'), 0), 'nvidia.com/gpu')} GPUs. Partial footprint; see component details below.`;
  const details = document.createElement('div'); details.className = 'builder-sizing-table'; details.append(table);
  panel.append(summary, details);
  const caveat = document.createElement('p'); caveat.textContent = warnings.join(' '); panel.append(caveat);
}
