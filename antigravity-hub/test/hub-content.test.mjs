import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpSpec, promptContent } from '../src/hub/content.mjs';

test('Paseo image blocks become Hub media and preserve all text', () => {
  assert.deepEqual(promptContent([{ type: 'text', text: 'inspect' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }, { type: 'text', text: 'please' }]), {
    items: [{ text: 'inspect' }, { text: 'please' }], media: [{ mimeType: 'image/png', inlineData: 'aGVsbG8=' }],
  });
  assert.deepEqual(promptContent([{type:'image',mimeType:'image/jpeg',data:'YQ=='}]).items, []);
  for (const data of ['', 'invalid!', 'a', 'data:image/png;base64,YQ==']) assert.throws(() => promptContent([{type:'image',mimeType:'image/png',data}]), /base64/);
  assert.throws(() => promptContent([{type:'image',mimeType:'text/html',data:'YQ=='}]), /MIME/);
  assert.throws(() => promptContent([{type:'audio'}]), /Unsupported/);
  assert.throws(() => promptContent([]), /content/);
  assert.deepEqual(promptContent([
    { type: 'text', text: 'see' },
    { type: 'resource_link', uri: 'file:///tmp/a.ts', title: 'a.ts' },
    { type: 'resource_link', name: 'b.ts', path: '/tmp/b.ts' },
  ]), { items: [{ text: 'see' }, { text: 'a.ts file:///tmp/a.ts' }, { text: 'b.ts /tmp/b.ts' }] });
  assert.deepEqual(promptContent([{ type: 'resource_link' }]).items, [{ text: 'resource' }]);
});

test('Paseo MCP transports map into isolated conversation discovery', () => {
  const spec = mcpSpec([
    {name:'paseo',command:'node',args:['server.mjs'],env:[{name:'TOKEN',value:'test'}]},
    {type:'http',name:'remote',url:'http://127.0.0.1:3333/mcp',headers:[{name:'Authorization',value:'Bearer test'}]},
    {type:'sse',name:'events',url:'https://example.test/sse',headers:[]},
  ], '/workspace');
  assert.deepEqual(spec.builtinAgent.customizationDiscovery.mcp, {inheritUser:false,servers:[
    {forceAllToolsEager:true,serverName:'paseo',command:'node',args:['server.mjs'],env:{TOKEN:'test'},cwd:'/workspace'},
    {forceAllToolsEager:true,serverName:'remote',serverUrl:'http://127.0.0.1:3333/mcp',headers:{Authorization:'Bearer test'},disableStandaloneSse:true},
    {forceAllToolsEager:true,serverName:'events',serverUrl:'https://example.test/sse',headers:{},disableStandaloneSse:false},
  ]});
  assert.throws(()=>mcpSpec([{name:'x',command:'node'},{name:'x',command:'node'}],'/tmp'), /duplicate/);
  assert.throws(()=>mcpSpec([{name:'x',type:'http',url:'file:///tmp/test'}],'/tmp'), /protocol/);
  assert.throws(()=>mcpSpec([{name:'x',command:'node',env:[{name:'TOKEN',value:42}]}],'/tmp'), /environment/);
  assert.deepEqual(mcpSpec([], '/tmp').builtinAgent.customizationDiscovery.mcp.servers, []);
});
