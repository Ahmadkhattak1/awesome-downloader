'use strict';
const $ = selector => document.querySelector(selector);
function el(tag, text) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; }
const tabs = ['about', 'system', 'license', 'third'];
function select(name) { for (const t of tabs) { $(`#t-${t}`).setAttribute('aria-selected', String(t === name)); $(`#p-${t}`).hidden = t !== name; } }
for (const t of tabs) $(`#t-${t}`).addEventListener('click', () => select(t));
(async () => {
  const info = await window.aboutApi.info();
  $('#name').textContent = info.name; $('#version').textContent = `Version ${info.version}${info.packaged ? '' : ' (development build)'}`;
  $('#description').textContent = info.description;
  for (const feature of info.features) $('#features').append(el('li', feature));
  for (const link of info.links) { const a = el('a', link.label); a.tabIndex = 0; a.role = 'link'; const go = () => window.aboutApi.open(link.url); a.addEventListener('click', go); a.addEventListener('keydown', e => { if (e.key === 'Enter') go(); }); $('#links').append(a); }
  for (const [key, value] of Object.entries(info.runtime)) { const row = el('tr'); row.append(el('td', key), el('td', value || '—')); $('#runtime').append(row); }
  $('#license').textContent = info.license || 'LICENSE file not found.'; $('#third').textContent = info.thirdParty || 'THIRD-PARTY.md not found.';
  $('#copy').addEventListener('click', async () => { const text = [`${info.name} ${info.version}`, ...Object.entries(info.runtime).map(([k, v]) => `${k}: ${v}`)].join('\n'); await window.aboutApi.copy(text); $('#copied').textContent = 'Copied.'; });
})();
