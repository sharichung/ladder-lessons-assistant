// Ladder Lessons game finder: model worker.
// Loaded only after the teacher clicks the download button (or when the model
// is already fully cached). Runs WebLLM off the main thread so the page never
// freezes. Talks to ll-assistant.js with plain messages:
//
//   in : {type:'load', modelId}
//        {type:'chat', id, messages, schema}
//   out: {type:'progress', progress, text}
//        {type:'ready', ms}
//        {type:'reply', id, text, ms, usage}
//        {type:'stats', text}
//        {type:'error', stage:'load'|'chat', id?, message}

import { MLCEngine, prebuiltAppConfig } from './vendor/web-llm.js';

let engine = null;
const post = (m) => self.postMessage(m);
const errText = (e) => String((e && (e.message || e.name)) || e).slice(0, 300);

async function load(modelId) {
  const record = prebuiltAppConfig.model_list.find((r) => r.model_id === modelId);
  if (!record) throw new Error('Model is not in the WebLLM prebuilt list: ' + modelId);
  engine = new MLCEngine({
    appConfig: { model_list: [record], cacheBackend: 'cache' },
    initProgressCallback: (r) => post({ type: 'progress', progress: r.progress, text: r.text }),
    logLevel: 'WARN',
  });
  const t0 = performance.now();
  await engine.reload(modelId);
  post({ type: 'ready', ms: Math.round(performance.now() - t0) });
}

async function chat(m) {
  const request = {
    messages: m.messages,
    temperature: 0,
    max_tokens: 96,
    response_format: { type: 'json_object', schema: JSON.stringify(m.schema) },
  };
  const t0 = performance.now();
  let out;
  try {
    out = await engine.chat.completions.create(request);
  } catch (e) {
    // If the schema itself cannot be compiled, try once with plain JSON mode.
    // ll-assistant.js validates every id either way.
    await engine.resetChat().catch(() => {});
    delete request.response_format.schema;
    out = await engine.chat.completions.create(request);
  }
  await engine.resetChat().catch(() => {});
  const text = (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content) || '';
  post({ type: 'reply', id: m.id, text, ms: Math.round(performance.now() - t0), usage: out.usage || null });
}

self.onmessage = async ({ data: m }) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'load') {
    try { await load(m.modelId); }
    catch (e) { post({ type: 'error', stage: 'load', message: errText(e) }); }
  } else if (m.type === 'chat') {
    if (!engine) return post({ type: 'error', stage: 'chat', id: m.id, message: 'not loaded' });
    try { await chat(m); }
    catch (e) { post({ type: 'error', stage: 'chat', id: m.id, message: errText(e) }); }
  } else if (m.type === 'stats') {
    try { post({ type: 'stats', text: engine ? await engine.runtimeStatsText() : '' }); }
    catch (e) { post({ type: 'stats', text: '' }); }
  }
};
