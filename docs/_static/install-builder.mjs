// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const chart = 'oci://nvcr.io/0948643769302270/afoa-release/mosaic-stack';
export const modules = {
  kubernetes: 'Kubernetes', prometheus: 'Prometheus metrics', alertmanager: 'Alertmanager alerts', loki: 'Loki logs', grafana: 'Grafana',
  bcm: 'Base Command Manager', slurm: 'Slurm', diagnostics: 'Hardware diagnostics',
  research: 'Research', terminal: 'Browser terminal', edit: 'Guarded Kubernetes edits', clusters: 'Cluster monitoring',
  webSearch: 'Web search (DuckDuckGo)',
};
const observabilityServices = ['prometheus', 'alertmanager', 'loki'];
const fields = {
  namespace: ['Namespace', 'mosaic'], pullSecret: ['NGC pull Secret', 'nvcr-image-pull-secret'],
  version: ['Pinned chart version (optional)', '', 'e.g. 0.0.1'],
  baseUrl: ['Inference API base URL', '', 'https://inference.example.com/v1'],
  model: ['Inference model', '', 'Your served model name'], llmSecret: ['Inference Secret (apiKey)', 'mosaic-external-llm'],
  prometheusUrl: ['Prometheus URL', '', 'http://prometheus:9090'],
  alertmanagerUrl: ['Alertmanager URL', '', 'http://alertmanager:9093'],
  lokiUrl: ['Loki URL', '', 'https://logs.example.com'],
  lokiTenant: ['Loki tenant ID (optional)', ''],
  lokiSecret: ['Loki Authorization Secret (optional)', ''],
  lokiKey: ['Loki Secret key', 'authorization'],
  grafanaUrl: ['Grafana URL, including serving path', '', 'https://grafana.example.com/grafana'],
  grafanaUid: ['Metrics datasource UID', 'prometheus'], grafanaType: ['Metrics datasource type', 'prometheus'], grafanaSecret: ['Grafana Secret (username, password)', 'mosaic-grafana-auth'],
  bcmHead: ['BCM SSH head host', '', 'user@bcm-head.example.com'], bcmSecret: ['BCM SSH Secret (id_ecdsa)', 'bcm-host-ssh-key'],
  evidenceRoot: ['Slurm evidence directory on the collector node', '', '/slurm'],
  evidenceNode: ['Slurm collector node hostname', '', 'slurm-login-node'],
  corpus: ['Research corpus directory on the node', '', '/cm/shared/iraop-corpus'],
};
export function enabledModules(state) {
  const enabled = new Set(state.modules || []);
  if (enabled.has('diagnostics') || (enabled.has('slurm') && state.slurmBackend !== 'vanilla')) enabled.add('bcm');
  if (['terminal', 'edit', 'clusters'].some(name => enabled.has(name))) enabled.add('kubernetes');
  if ([...observabilityServices, 'grafana'].some(name => enabled.has(name))) enabled.add('observability');
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
  for (const name of ['ui', 'execution', 'observability', ...Object.keys(modules).filter(name => !observabilityServices.includes(name))]) set(`modules.${name}.enabled`, ['ui', 'execution'].includes(name) || enabled.has(name));
  set('modules.bcm.redfish.enabled', enabled.has('bcm') && !!state.redfish);
  set('llm.requestCompatibility.researchToolCalls.enabled', enabled.has('research') && !!state.researchToolCalls);
  if (enabled.has('research') && state.researchToolCalls) set('llm.requestCompatibility.enabled', true);
  for (const service of ['prometheus', 'alertmanager']) {
    set(`observability.${service}Url`, enabled.has(service) ? value(`${service}Url`) : '', true);
  }
  set('observability.loki.url', enabled.has('loki') ? value('lokiUrl') : '', true);
  if (enabled.has('loki')) {
    for (const [key, field] of Object.entries({tenantId:'lokiTenant', 'auth.existingSecret':'lokiSecret', 'auth.authorizationKey':'lokiKey'})) {
      set(`observability.loki.${key}`, state[field]?.trim() || fields[field][1], true);
    }
  }
  if (enabled.has('grafana')) {
    set('observability.grafanaUrl', value('grafanaUrl'), true); set('observability.grafanaDatasourceUid', value('grafanaUid'), true);
    set('observability.grafanaDatasourceType', value('grafanaType'), true);
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
    set('researchAgent.iraop.config.NVIDIA_CHAT_MODEL', state.inference === 'external' ? value('model') : state.inference === 'ultra' ? 'nemotron-ultra-550b' : 'nemotron-3.5-super-vl', true);
    set('researchAgent.iraop.corpus.hostPath', value('corpus'), true);
  }
  if (enabled.has('edit')) set('modules.edit.hitl', true);
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
  const state = {inference: 'external', channel: 'devel', slurmBackend: 'bcm', grafanaType: 'prometheus', modules: ['kubernetes', 'webSearch']};
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
  optionBody.append(select('inference', 'Inference', [['external', 'Existing endpoint'], ['super', 'On-prem: Nemotron 3.5 Super VL (1 GPU)'], ['ultra', 'On-prem: Nemotron Ultra (4 Blackwell GPUs)']]),
    select('channel', 'Chart channel', [['devel', 'Latest development'], ['stable', 'Latest stable']]));
  form.append(options);
  const moduleGroup = document.createElement('fieldset'); moduleGroup.innerHTML = '<legend>Modules</legend><p>UI and execution are always enabled. Required dependencies are selected automatically.</p>';
  const buttons = document.createElement('div'); buttons.className = 'builder-modules';
  const inputs = new Map();
  const redfishOptions = document.createElement('div'); redfishOptions.className = 'builder-suboptions';
  const redfishLabel = document.createElement('label'); const redfishInput = document.createElement('input'); redfishInput.type = 'checkbox'; redfishInput.name = 'redfish';
  redfishInput.addEventListener('change', () => {state.redfish = redfishInput.checked; update(false);}); redfishLabel.append(redfishInput, document.createTextNode('Read-only Redfish')); redfishOptions.append(redfishLabel);
  const researchOptions = document.createElement('div'); researchOptions.className = 'builder-suboptions';
  const researchLabel = document.createElement('label'); const researchInput = document.createElement('input'); researchInput.type = 'checkbox'; researchInput.name = 'researchToolCalls';
  researchInput.addEventListener('change', () => {state.researchToolCalls = researchInput.checked; update(false);}); researchLabel.append(researchInput, document.createTextNode('Search tool compatibility workaround')); researchOptions.append(researchLabel);
  for (const [name, label] of Object.entries(modules)) {
    const wrapper = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.name = name;
    input.addEventListener('change', () => {const requested = new Set(state.modules); input.checked ? requested.add(name) : requested.delete(name); state.modules = [...requested]; update(true);});
    wrapper.append(input, document.createTextNode(label)); inputs.set(name, input);
    if (name === 'bcm') {
      const block = document.createElement('div'); block.className = 'builder-module'; block.append(wrapper, redfishOptions); buttons.append(block);
    } else if (name === 'research') {
      const block = document.createElement('div'); block.className = 'builder-module'; block.append(wrapper, researchOptions); buttons.append(block);
    } else buttons.append(wrapper);
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
  root.replaceChildren(form, heading, copy, status, output, sizing);
  fetch(new URL('sizing-data.json', import.meta.url)).then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }).then(data => {catalog = data; update(false);}).catch(error => {sizing.textContent = `Deployment footprint unavailable: ${error.message}`;});
  function update(renderSettings) {
    const enabled = enabledModules(state);
    redfishOptions.hidden = !enabled.has('bcm'); redfishInput.checked = !!state.redfish;
    researchOptions.hidden = !enabled.has('research'); researchInput.checked = !!state.researchToolCalls;
    for (const [name, input] of inputs) {input.checked = enabled.has(name); input.disabled = enabled.has(name) && !state.modules.includes(name);}
    if (renderSettings) {
      settingsBody.replaceChildren();
      const keys = ['namespace', 'pullSecret', 'version'];
      if (state.inference === 'external') keys.push('baseUrl', 'model', 'llmSecret');
      if (enabled.has('prometheus')) keys.push('prometheusUrl');
      if (enabled.has('alertmanager')) keys.push('alertmanagerUrl');
      if (enabled.has('loki')) keys.push('lokiUrl', 'lokiTenant', 'lokiSecret', 'lokiKey');
      if (enabled.has('grafana')) keys.push('grafanaUrl', 'grafanaUid', 'grafanaType', 'grafanaSecret');
      if (enabled.has('slurm')) settingsBody.append(select('slurmBackend', 'Slurm integration', [['bcm', 'Through BCM'], ['vanilla', 'Standalone Slurm']]));
      if (enabled.has('bcm')) keys.push('bcmHead', 'bcmSecret');
      if (enabled.has('slurm') && state.slurmBackend === 'vanilla') keys.push('evidenceRoot', 'evidenceNode');
      if (enabled.has('research')) keys.push('corpus');
      for (const key of keys) {
        if (key === 'grafanaType') {
          settingsBody.append(select(key, fields[key][0], [['prometheus', 'Prometheus'], ['victoriametrics-metrics-datasource', 'VictoriaMetrics (native plugin)']]));
          continue;
        }
        const [label, initial, placeholder] = fields[key]; const wrapper = document.createElement('label'); wrapper.textContent = label;
        const input = document.createElement('input'); input.name = key; input.value = state[key] ?? initial; input.placeholder = placeholder || '';
        input.addEventListener('input', () => {state[key] = input.value; update(false);}); wrapper.append(input); settingsBody.append(wrapper);
      }
      const wrapper = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!state.sandboxInstalled;
      input.addEventListener('change', () => {state.sandboxInstalled = input.checked; update(false);}); wrapper.append(input, document.createTextNode('Cluster already has a compatible agent-sandbox installation')); settingsBody.append(wrapper);
    }
    const notes = ['Complete namespace and NGC access setup first. Replace all <placeholders> before running.'];
    if (state.inference === 'external') notes.push(`Create ${state.llmSecret || fields.llmSecret[1]} with key apiKey.`);
    if (enabled.has('loki')) {
      notes.push('Connect to an existing Loki endpoint; no Loki server or collector is installed.');
      if (state.lokiUrl?.trim() && state.lokiSecret?.trim()) notes.push(`Create ${state.lokiSecret.trim()} in the release namespace with key ${state.lokiKey?.trim() || fields.lokiKey[1]} containing the complete Authorization header. Do not enter credentials in this form.`);
    }
    if (enabled.has('grafana')) notes.push(`Create ${state.grafanaSecret || fields.grafanaSecret[1]} with keys username and password.`);
    if (enabled.has('bcm')) notes.push(`Create ${state.bcmSecret || fields.bcmSecret[1]} with key id_ecdsa; its SSH identity must bootstrap the read-only CMSH user.`);
    if (enabled.has('bcm') && state.redfish) notes.push('Redfish reads node BMCs through the BCM head using credentials stored in BCM. Resets and configuration changes are unavailable. BMC TLS certificate verification is off by default; see the Redfish installation guide to configure it.');
    if (enabled.has('research')) notes.push('Create iraop-secrets with NVIDIA_API_KEY, NVIDIA_CHAT_API_KEY and IRAOP_API_KEY; prepare the corpus directory.');
    if (enabled.has('research') && state.researchToolCalls) notes.push('The search workaround is for inference backends returning named search arguments as ordinary text. Verify the affected protocol first; it does not establish answer or citation quality. Full request tracing stays disabled by default.');
    if (enabled.has('webSearch')) notes.push('Web search uses DuckDuckGo without an API key; the OpenClaw pod needs HTTPS egress to duckduckgo.com. Clear it for air-gapped installations.');
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
  const title = document.createElement('h3'); title.textContent = 'Server resources';
  const components = selectedComponents(catalog, state, enabled);
  const fixed = components.filter(component => ['Deployment', 'StatefulSet', 'Sandbox'].includes(component.kind));
  const total = resource => fixed.reduce((sum, component) => sum + footprint(component, 'requests', resource), 0);
  const format = (amount, resource) => resource === 'memory' ? `${Number((amount / 1024 ** 3).toFixed(3))} GiB` : `${Number(amount.toFixed(3))}`;
  const storage = components.reduce((sum, component) => {
    const volumes = typeof component.storage === 'string' ? [component.storage] : component.storage || [];
    return sum + volumes.reduce((amount, value) => amount + quantity(value, 'memory'), 0) * component.count;
  }, 0);
  const resources = document.createElement('table');
  const header = resources.createTHead().insertRow();
  const row = resources.createTBody().insertRow();
  for (const [label, value] of [
    ['CPU', `≥ ${format(total('cpu'), 'cpu')} cores`],
    ['RAM', `≥ ${format(total('memory'), 'memory')}`],
    ['GPUs', format(total('nvidia.com/gpu'), 'nvidia.com/gpu')],
    ['Disk', format(storage, 'memory')],
  ]) {
    const name = document.createElement('th'); name.scope = 'col'; name.textContent = label;
    header.append(name); row.insertCell().textContent = value;
  }
  const note = document.createElement('p'); note.className = 'builder-sizing-note';
  note.textContent = 'Configured minimums for this chart. Allow extra capacity for concurrency and services without declared resources; existing services and per-node collectors are excluded.';
  if (state.inference === 'external') note.textContent += ' Inference runs on your existing endpoint.';
  else note.textContent += ' Model GPUs must fit on one compatible node.';
  if (enabled.has('research') && !catalog.researchAvailable) note.textContent += ' Research resources are excluded from this build.';
  panel.append(title, resources, note);
}
